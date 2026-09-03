import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import { generateImageThumbnail } from "@/core/upload/thumbnail";
import {
    deleteThumbnailCiphertext,
    getThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { isJsHeapUnderPressure } from "@/lib/memory-probe";
import type { EnteFile } from "ente-media/file";

type ThumbnailStatus = "idle" | "loading" | "ready" | "error";

interface ThumbnailEntry {
    status: ThumbnailStatus;
    url?: string;
    byteSize?: number;
    lastAccess?: number;
}

/**
 * Soft cap on decrypted thumbnail blob URLs retained in RAM this session.
 * Thumbs are ≤~100KB JPEG; ~64MB holds hundreds of decoded URLs without
 * unbounded growth after long gallery scrolls.
 */
const SESSION_BUDGET_BYTES = 64 * 1024 * 1024;

const idleEntry: ThumbnailEntry = { status: "idle" };
const loadingEntry: ThumbnailEntry = { status: "loading" };

const cache: Map<number, ThumbnailEntry> = new Map();
const listeners: Map<number, Set<() => void>> = new Map();

const maxConcurrent = 6;
let inFlight = 0;
const queue: Array<() => void> = [];

const runNext = (): void => {
    while (inFlight < maxConcurrent && queue.length > 0) {
        const task: (() => void) | undefined = queue.shift();
        if (task) {
            inFlight++;
            task();
        }
    }
};

const finishTask = (): void => {
    inFlight--;
    runNext();
};

const notify = (fileId: number): void => {
    listeners.get(fileId)?.forEach((listener: () => void) => listener());
};

const hasSubscribers = (fileId: number): boolean =>
    (listeners.get(fileId)?.size ?? 0) > 0;

const sessionBytesUsed = (): number => {
    let total = 0;
    for (const entry of cache.values()) {
        if (entry.status === "ready" && entry.byteSize) {
            total += entry.byteSize;
        }
    }
    return total;
};

const revokeEntryUrl = (entry: ThumbnailEntry): void => {
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
    }
};

/**
 * Drop oldest ready thumbs that nothing is currently subscribed to.
 * Visible (subscribed) cells are never evicted — virtualization bounds that set.
 */
const evictSessionUntilFit = (incomingBytes: number): void => {
    if (incomingBytes > SESSION_BUDGET_BYTES) {
        for (const [fileId, entry] of cache) {
            if (entry.status !== "ready" || hasSubscribers(fileId)) {
                continue;
            }
            revokeEntryUrl(entry);
            cache.delete(fileId);
        }
        return;
    }

    const ranked = [...cache.entries()]
        .filter(
            ([fileId, entry]) =>
                entry.status === "ready" &&
                entry.url !== undefined &&
                !hasSubscribers(fileId),
        )
        .sort(
            (a, b) => (a[1].lastAccess ?? 0) - (b[1].lastAccess ?? 0),
        );

    let used = sessionBytesUsed();
    for (const [fileId, entry] of ranked) {
        if (used + incomingBytes <= SESSION_BUDGET_BYTES) {
            break;
        }
        revokeEntryUrl(entry);
        cache.delete(fileId);
        used -= entry.byteSize ?? 0;
    }
};

/** Evict ~25% of unsubscribed ready thumbs (oldest first). */
const emergencyEvict = (): void => {
    const ranked = [...cache.entries()]
        .filter(
            ([fileId, entry]) =>
                entry.status === "ready" &&
                entry.url !== undefined &&
                !hasSubscribers(fileId),
        )
        .sort(
            (a, b) => (a[1].lastAccess ?? 0) - (b[1].lastAccess ?? 0),
        );
    const dropCount = Math.max(1, Math.ceil(ranked.length * 0.25));
    for (let i = 0; i < dropCount && i < ranked.length; i++) {
        const [fileId, entry] = ranked[i]!;
        revokeEntryUrl(entry);
        cache.delete(fileId);
    }
};

const relieveHeapPressureIfNeeded = (): void => {
    if (!isJsHeapUnderPressure()) {
        return;
    }
    emergencyEvict();
};

export const subscribeThumbnail = (
    fileId: number,
    listener: () => void,
): (() => void) => {
    let set: Set<() => void> | undefined = listeners.get(fileId);
    if (!set) {
        set = new Set();
        listeners.set(fileId, set);
    }
    set.add(listener);
    return (): void => {
        set?.delete(listener);
        if (set?.size === 0) {
            listeners.delete(fileId);
        }
    };
};

export const getThumbnailEntry = (fileId: number): ThumbnailEntry => {
    const entry = cache.get(fileId);
    if (!entry) {
        return idleEntry;
    }
    if (entry.status === "ready") {
        entry.lastAccess = Date.now();
    }
    return entry;
};

const setReady = (fileId: number, bytes: Uint8Array): void => {
    relieveHeapPressureIfNeeded();
    const byteSize = bytes.byteLength;
    evictSessionUntilFit(byteSize);

    const existing = cache.get(fileId);
    if (existing?.url) {
        URL.revokeObjectURL(existing.url);
    }

    const blob = blobFromUint8Array(bytes, "image/jpeg");
    const url = URL.createObjectURL(blob);
    cache.set(fileId, {
        status: "ready",
        url,
        byteSize,
        lastAccess: Date.now(),
    });
    notify(fileId);
};

const loadThumbnail = (file: EnteFile): void => {
    const existing: ThumbnailEntry | undefined = cache.get(file.id);
    if (existing && existing.status !== "idle") {
        return;
    }

    cache.set(file.id, { status: "loading" });
    notify(file.id);

    const task = (): void => {
        void (async (): Promise<void> => {
            try {
                relieveHeapPressureIfNeeded();

                const cached = await getThumbnailCiphertext(file.id);
                if (cached) {
                    const bytes = await decryptThumbnailCiphertext(
                        cached,
                        file.key,
                    );
                    setReady(file.id, bytes);
                    return;
                }

                const core = getEnteCore();
                const ciphertext =
                    await core.fetchEncryptedThumbnail(file);
                await putThumbnailCiphertext(file.id, ciphertext);
                const bytes = await decryptThumbnailCiphertext(
                    ciphertext,
                    file.key,
                );
                setReady(file.id, bytes);
            } catch {
                cache.set(file.id, { status: "error" });
                notify(file.id);
            } finally {
                finishTask();
            }
        })();
    };

    queue.push(task);
    runNext();
};

export const requestThumbnail = (file: EnteFile): ThumbnailEntry => {
    const entry: ThumbnailEntry = getThumbnailEntry(file.id);
    if (entry.status === "idle") {
        loadThumbnail(file);
        return loadingEntry;
    }
    return entry;
};

/**
 * Decrypt thumbnail bytes when already present in IDB. Does not network-fetch
 * (mass scans must avoid fetch+decode spikes on mobile Chrome).
 */
export const loadCachedDecryptedThumbnailBytes = async (
    file: EnteFile,
): Promise<Uint8Array | undefined> => {
    const cached = await getThumbnailCiphertext(file.id);
    if (!cached) {
        return undefined;
    }
    return decryptThumbnailCiphertext(cached, file.key);
};

/**
 * Decrypt thumbnail bytes for background jobs (IDB cache, else fetch + cache).
 */
export const loadDecryptedThumbnailBytes = async (
    file: EnteFile,
): Promise<Uint8Array> => {
    const cached = await getThumbnailCiphertext(file.id);
    if (cached) {
        return decryptThumbnailCiphertext(cached, file.key);
    }
    const core = getEnteCore();
    const ciphertext = await core.fetchEncryptedThumbnail(file);
    await putThumbnailCiphertext(file.id, ciphertext);
    return decryptThumbnailCiphertext(ciphertext, file.key);
};

/**
 * Show a thumbnail immediately from full image bytes (e.g. after optimistic crop).
 */
export const primeThumbnailFromBytes = (
    fileId: number,
    imageBytes: Uint8Array,
): void => {
    const existing = cache.get(fileId);
    if (existing?.url) {
        URL.revokeObjectURL(existing.url);
    }
    cache.set(fileId, { status: "loading" });
    notify(fileId);

    void (async (): Promise<void> => {
        try {
            const thumbBytes = await generateImageThumbnail(imageBytes);
            setReady(fileId, thumbBytes);
        } catch {
            cache.set(fileId, { status: "error" });
            notify(fileId);
        }
    })();
};

/**
 * Show a thumbnail immediately from edited video bytes (e.g. after optimistic crop).
 */
export const primeVideoThumbnailFromBytes = (
    fileId: number,
    videoBytes: Uint8Array,
): void => {
    const existing = cache.get(fileId);
    if (existing?.url) {
        URL.revokeObjectURL(existing.url);
    }
    cache.set(fileId, { status: "loading" });
    notify(fileId);

    void (async (): Promise<void> => {
        try {
            const { extractVideoFrameJpeg } = await import("@/lib/ffmpeg");
            const frameBytes = await extractVideoFrameJpeg(videoBytes, "video/mp4");
            const thumbBytes = await generateImageThumbnail(frameBytes);
            setReady(fileId, thumbBytes);
        } catch {
            cache.set(fileId, { status: "error" });
            notify(fileId);
        }
    })();
};

/**
 * Drop session blob URL + IDB ciphertext for a file (trash, sync delete, replace).
 */
export const invalidateThumbnailCache = async (
    fileId: number,
): Promise<void> => {
    const entry = cache.get(fileId);
    if (entry) {
        revokeEntryUrl(entry);
        cache.delete(fileId);
        notify(fileId);
    }
    await deleteThumbnailCiphertext(fileId);
};

export const clearThumbnailCache = (): void => {
    for (const entry of cache.values()) {
        revokeEntryUrl(entry);
    }
    cache.clear();
    listeners.clear();
    queue.length = 0;
    inFlight = 0;
};
