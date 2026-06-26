import { getEnteCore } from "@/core";
import { decryptThumbnailCiphertext } from "@/core/download";
import { generateImageThumbnail } from "@/core/upload/thumbnail";
import {
    getThumbnailCiphertext,
    putThumbnailCiphertext,
} from "@/db/thumbnails";
import type { EnteFile } from "ente-media/file";

type ThumbnailStatus = "idle" | "loading" | "ready" | "error";

interface ThumbnailEntry {
    status: ThumbnailStatus;
    url?: string;
}

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

export const getThumbnailEntry = (fileId: number): ThumbnailEntry =>
    cache.get(fileId) ?? idleEntry;

/**
 * Return decrypted thumbnail bytes when the in-memory cache is ready.
 */
export const getCachedThumbnailBytes = async (
    fileId: number,
): Promise<Uint8Array | undefined> => {
    const entry = cache.get(fileId);
    if (entry?.status !== "ready" || !entry.url) {
        return undefined;
    }
    try {
        const response = await fetch(entry.url);
        return new Uint8Array(await response.arrayBuffer());
    } catch {
        return undefined;
    }
};

const setReady = (fileId: number, bytes: Uint8Array): void => {
    const blob: Blob = new Blob([Uint8Array.from(bytes)], {
        type: "image/jpeg",
    });
    const url: string = URL.createObjectURL(blob);
    cache.set(fileId, { status: "ready", url });
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

export const clearThumbnailCache = (): void => {
    for (const entry of cache.values()) {
        if (entry.url) {
            URL.revokeObjectURL(entry.url);
        }
    }
    cache.clear();
    listeners.clear();
    queue.length = 0;
    inFlight = 0;
};
