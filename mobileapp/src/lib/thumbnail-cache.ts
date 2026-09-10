import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import { generateImageThumbnail } from "@/core/upload/thumbnail";
import {
    deleteThumbnailCiphertext,
    getThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { isGalleryScrolling } from "@/lib/gallery-scroll-activity";
import {
    readJsHeapSnapshot,
    type JsHeapSnapshot,
} from "@/lib/memory-probe";
import type { EnteFile } from "ente-media/file";

type ThumbnailStatus = "idle" | "loading" | "ready" | "error";

interface ThumbnailEntry {
    status: ThumbnailStatus;
    url?: string;
    byteSize?: number;
    lastAccess?: number;
}

interface PendingReady {
    fileId: number;
    bytes: Uint8Array;
}

/**
 * Soft cap on decrypted thumbnail blob URLs retained in RAM this session.
 * Raised from 64MB so long gallery scrolls keep recently-seen thumbs warm
 * without going fully unbounded.
 */
const SESSION_BUDGET_BYTES = 160 * 1024 * 1024;

/** Only thrash the session cache when the heap is near the limit. */
const THUMB_HEAP_PRESSURE_RATIO = 0.85;

const MAX_CONCURRENT_IDLE = 8;
const MAX_CONCURRENT_SCROLLING = 3;
const MAX_APPLIES_PER_FRAME_IDLE = 4;
const MAX_APPLIES_PER_FRAME_SCROLLING = 2;

const idleEntry: ThumbnailEntry = { status: "idle" };
const loadingEntry: ThumbnailEntry = { status: "loading" };

const cache: Map<number, ThumbnailEntry> = new Map();
const listeners: Map<number, Set<() => void>> = new Map();

/** Running total of ready thumbnail blob sizes (avoids scanning the map). */
let sessionReadyBytes = 0;

let inFlight = 0;
/** Visible / subscribed cells — drained first. */
const highQueue: Array<() => void> = [];
/** Off-screen work — runs only when highQueue is empty and not scrolling. */
const lowQueue: Array<() => void> = [];

/** Decrypted bytes waiting for main-thread blob URL + React notify. */
const pendingReady: PendingReady[] = [];
let applyFrameScheduled = false;

const maxConcurrentNow = (): number =>
    isGalleryScrolling() ? MAX_CONCURRENT_SCROLLING : MAX_CONCURRENT_IDLE;

const appliesPerFrameNow = (): number =>
    isGalleryScrolling() ?
        MAX_APPLIES_PER_FRAME_SCROLLING :
        MAX_APPLIES_PER_FRAME_IDLE;

const runNext = (): void => {
    const limit = maxConcurrentNow();
    while (inFlight < limit && highQueue.length > 0) {
        const task = highQueue.shift();
        if (task) {
            inFlight++;
            task();
        }
    }
    // During a fling, do not start off-screen / unsubscribed work.
    if (isGalleryScrolling()) {
        return;
    }
    while (inFlight < limit && lowQueue.length > 0) {
        const task = lowQueue.shift();
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

const enqueueLoad = (fileId: number, task: () => void): void => {
    if (hasSubscribers(fileId)) {
        highQueue.push(task);
    } else {
        lowQueue.push(task);
    }
    runNext();
};

const notify = (fileId: number): void => {
    listeners.get(fileId)?.forEach((listener: () => void) => listener());
};

const hasSubscribers = (fileId: number): boolean =>
    (listeners.get(fileId)?.size ?? 0) > 0;

const touchLastAccess = (fileId: number): void => {
    const entry = cache.get(fileId);
    if (entry?.status === "ready") {
        entry.lastAccess = Date.now();
    }
};

const dropReadyBytes = (entry: ThumbnailEntry): void => {
    if (entry.status === "ready" && entry.byteSize) {
        sessionReadyBytes = Math.max(0, sessionReadyBytes - entry.byteSize);
    }
};

const revokeEntryUrl = (entry: ThumbnailEntry): void => {
    if (entry.url) {
        URL.revokeObjectURL(entry.url);
    }
};

const discardCacheEntry = (fileId: number, entry: ThumbnailEntry): void => {
    dropReadyBytes(entry);
    revokeEntryUrl(entry);
    cache.delete(fileId);
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
            discardCacheEntry(fileId, entry);
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

    let used = sessionReadyBytes;
    for (const [fileId, entry] of ranked) {
        if (used + incomingBytes <= SESSION_BUDGET_BYTES) {
            break;
        }
        used -= entry.byteSize ?? 0;
        discardCacheEntry(fileId, entry);
    }
};

/** Evict ~10% of unsubscribed ready thumbs (oldest first). */
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
    const dropCount = Math.max(1, Math.ceil(ranked.length * 0.1));
    for (let i = 0; i < dropCount && i < ranked.length; i++) {
        const [fileId, entry] = ranked[i]!;
        discardCacheEntry(fileId, entry);
    }
};

const isThumbHeapUnderPressure = (
    snapshot: JsHeapSnapshot | undefined = readJsHeapSnapshot(),
): boolean =>
    snapshot !== undefined && snapshot.usedRatio >= THUMB_HEAP_PRESSURE_RATIO;

const relieveHeapPressureIfNeeded = (): void => {
    if (!isThumbHeapUnderPressure()) {
        return;
    }
    emergencyEvict();
};

/** Reset a cancelled in-flight load so a remount can request again. */
const resetToIdle = (fileId: number): void => {
    const entry = cache.get(fileId);
    if (entry?.status === "loading") {
        cache.delete(fileId);
        notify(fileId);
    }
};

/**
 * Apply blob URL + notify immediately. Prefer {@link scheduleSetReady} so
 * scroll frames are not starved by a burst of ready thumbs.
 */
const applyReadyNow = (fileId: number, bytes: Uint8Array): void => {
    relieveHeapPressureIfNeeded();
    const byteSize = bytes.byteLength;
    evictSessionUntilFit(byteSize);

    const existing = cache.get(fileId);
    if (existing) {
        dropReadyBytes(existing);
        if (existing.url) {
            URL.revokeObjectURL(existing.url);
        }
    }

    const blob = blobFromUint8Array(bytes, "image/jpeg");
    const url = URL.createObjectURL(blob);
    sessionReadyBytes += byteSize;
    cache.set(fileId, {
        status: "ready",
        url,
        byteSize,
        lastAccess: Date.now(),
    });
    if (hasSubscribers(fileId)) {
        notify(fileId);
    }
};

const takeNextPendingReady = (): PendingReady | undefined => {
    const subscribedIdx = pendingReady.findIndex((item) =>
        hasSubscribers(item.fileId));
    if (subscribedIdx >= 0) {
        return pendingReady.splice(subscribedIdx, 1)[0];
    }
    return pendingReady.shift();
};

const flushPendingReady = (): void => {
    applyFrameScheduled = false;
    const budget = appliesPerFrameNow();
    let applied = 0;
    while (applied < budget && pendingReady.length > 0) {
        const next = takeNextPendingReady();
        if (!next) {
            break;
        }
        applyReadyNow(next.fileId, next.bytes);
        applied++;
    }
    if (pendingReady.length > 0) {
        scheduleApplyFrame();
    }
    // Scroll may have ended — resume deferred low-priority loads.
    runNext();
};

const scheduleApplyFrame = (): void => {
    if (applyFrameScheduled) {
        return;
    }
    applyFrameScheduled = true;
    requestAnimationFrame(flushPendingReady);
};

/**
 * Queue decrypted bytes for a paced main-thread apply (blob URL + React).
 */
const scheduleSetReady = (fileId: number, bytes: Uint8Array): void => {
    // Replace any older pending payload for the same file.
    for (let i = pendingReady.length - 1; i >= 0; i--) {
        if (pendingReady[i]?.fileId === fileId) {
            pendingReady.splice(i, 1);
        }
    }
    pendingReady.push({ fileId, bytes });
    scheduleApplyFrame();
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
    touchLastAccess(fileId);
    return (): void => {
        set?.delete(listener);
        if (set?.size === 0) {
            listeners.delete(fileId);
        }
    };
};

export const getThumbnailEntry = (fileId: number): ThumbnailEntry =>
    cache.get(fileId) ?? idleEntry;

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

                // Cell scrolled away during a fling — do not burn decrypt CPU.
                if (!hasSubscribers(file.id) && isGalleryScrolling()) {
                    resetToIdle(file.id);
                    return;
                }

                const cached = await getThumbnailCiphertext(file.id);
                if (cached) {
                    if (!hasSubscribers(file.id) && isGalleryScrolling()) {
                        resetToIdle(file.id);
                        return;
                    }
                    const bytes = await decryptThumbnailCiphertext(
                        cached,
                        file.key,
                    );
                    // Warm session cache even if unsubscribed; notify only if
                    // still visible (handled inside applyReadyNow).
                    scheduleSetReady(file.id, bytes);
                    return;
                }

                // Network fetch: skip if nothing is waiting on this thumb.
                if (!hasSubscribers(file.id)) {
                    resetToIdle(file.id);
                    return;
                }

                const core = getEnteCore();
                const ciphertext =
                    await core.fetchEncryptedThumbnail(file);
                await putThumbnailCiphertext(file.id, ciphertext);
                if (!hasSubscribers(file.id)) {
                    // Ciphertext is on disk; skip decode until remounted.
                    resetToIdle(file.id);
                    return;
                }
                const bytes = await decryptThumbnailCiphertext(
                    ciphertext,
                    file.key,
                );
                scheduleSetReady(file.id, bytes);
            } catch {
                cache.set(file.id, { status: "error" });
                notify(file.id);
            } finally {
                finishTask();
            }
        })();
    };

    enqueueLoad(file.id, task);
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
    mimeType = "image/jpeg",
): void => {
    const existing = cache.get(fileId);
    if (existing) {
        dropReadyBytes(existing);
        revokeEntryUrl(existing);
    }
    cache.set(fileId, { status: "loading" });
    notify(fileId);

    void (async (): Promise<void> => {
        try {
            const thumbBytes = await generateImageThumbnail(imageBytes, mimeType);
            scheduleSetReady(fileId, thumbBytes);
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
    if (existing) {
        dropReadyBytes(existing);
        revokeEntryUrl(existing);
    }
    cache.set(fileId, { status: "loading" });
    notify(fileId);

    void (async (): Promise<void> => {
        try {
            const { extractVideoFrameJpeg } = await import("@/lib/ffmpeg");
            const frameBytes = await extractVideoFrameJpeg(videoBytes, "video/mp4");
            const thumbBytes = await generateImageThumbnail(frameBytes);
            scheduleSetReady(fileId, thumbBytes);
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
    for (let i = pendingReady.length - 1; i >= 0; i--) {
        if (pendingReady[i]?.fileId === fileId) {
            pendingReady.splice(i, 1);
        }
    }
    const entry = cache.get(fileId);
    if (entry) {
        discardCacheEntry(fileId, entry);
        notify(fileId);
    }
    await deleteThumbnailCiphertext(fileId);
};

export const clearThumbnailCache = (): void => {
    for (const entry of cache.values()) {
        revokeEntryUrl(entry);
    }
    cache.clear();
    sessionReadyBytes = 0;
    listeners.clear();
    highQueue.length = 0;
    lowQueue.length = 0;
    pendingReady.length = 0;
    applyFrameScheduled = false;
    inFlight = 0;
};
