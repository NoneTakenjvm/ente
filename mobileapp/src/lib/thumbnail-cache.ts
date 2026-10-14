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
import { readJsHeapSnapshot } from "@/lib/memory-probe";
import type { EnteFile } from "ente-media/file";

type ThumbnailStatus = "idle" | "loading" | "ready" | "error";

interface ThumbnailEntry {
    status: ThumbnailStatus;
    url?: string;
    byteSize?: number;
}

interface PendingReady {
    fileId: number;
    bytes: Uint8Array;
}

interface ThumbnailFailure {
    attempts: number;
    failedAt: number;
    /** Set for network loads, which can be retried; absent for primed thumbs. */
    file?: EnteFile;
}

/**
 * Soft cap on decrypted thumbnail blob URLs retained in RAM this session.
 * Keeps recently-seen thumbs warm during long scrolls while staying small
 * enough for iOS, which counts blob URLs against the tab's process memory.
 */
const SESSION_BUDGET_BYTES = 96 * 1024 * 1024;

/** Only thrash the session cache when the heap is near the limit. */
const THUMB_HEAP_PRESSURE_RATIO = 0.85;

const MAX_CONCURRENT_IDLE = 8;
const MAX_CONCURRENT_SCROLLING = 3;
const MAX_APPLIES_PER_FRAME_IDLE = 4;
const MAX_APPLIES_PER_FRAME_SCROLLING = 2;

/** Failed loads stop auto-retrying after this many attempts. */
const MAX_THUMBNAIL_ATTEMPTS = 3;
/** A remount only retries a failed load once it is this old. */
const REMOUNT_RETRY_DELAY_MS = 10_000;

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

const failureByFileId: Map<number, ThumbnailFailure> = new Map();

const maxConcurrentNow = (): number =>
    isGalleryScrolling() ? MAX_CONCURRENT_SCROLLING : MAX_CONCURRENT_IDLE;

const appliesPerFrameNow = (): number =>
    isGalleryScrolling() ?
        MAX_APPLIES_PER_FRAME_SCROLLING :
        MAX_APPLIES_PER_FRAME_IDLE;

const runNext = (): void => {
    const limit = maxConcurrentNow();
    while (inFlight < limit && highQueue.length > 0) {
        // Newest first: after a fling the oldest entries are for cells that
        // have already scrolled past.
        const task = highQueue.pop();
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

/** Move a ready entry to the end of the map (most recently used). */
const touchLastAccess = (fileId: number): void => {
    const entry = cache.get(fileId);
    if (entry?.status === "ready") {
        cache.delete(fileId);
        cache.set(fileId, entry);
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

const isEvictable = (fileId: number, entry: ThumbnailEntry): boolean =>
    entry.status === "ready" &&
    entry.url !== undefined &&
    !hasSubscribers(fileId);

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
    // Called for every decoded thumb; skip the scan while scrolling under
    // budget.
    if (sessionReadyBytes + incomingBytes <= SESSION_BUDGET_BYTES) {
        return;
    }

    // The map is in LRU order (oldest first), so no sorting is needed.
    let used = sessionReadyBytes;
    for (const [fileId, entry] of cache) {
        if (used + incomingBytes <= SESSION_BUDGET_BYTES) {
            break;
        }
        if (!isEvictable(fileId, entry)) {
            continue;
        }
        used -= entry.byteSize ?? 0;
        discardCacheEntry(fileId, entry);
    }
};

/** Evict ~10% of unsubscribed ready thumbs (oldest first). */
const emergencyEvict = (): void => {
    let evictableCount = 0;
    for (const [fileId, entry] of cache) {
        if (isEvictable(fileId, entry)) {
            evictableCount++;
        }
    }
    let remainingDrops = Math.max(1, Math.ceil(evictableCount * 0.1));
    for (const [fileId, entry] of cache) {
        if (remainingDrops === 0) {
            break;
        }
        if (!isEvictable(fileId, entry)) {
            continue;
        }
        discardCacheEntry(fileId, entry);
        remainingDrops--;
    }
};

const relieveHeapPressureIfNeeded = (): void => {
    const snapshot = readJsHeapSnapshot();
    if (snapshot !== undefined && snapshot.usedRatio >= THUMB_HEAP_PRESSURE_RATIO) {
        emergencyEvict();
    }
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
 * True while {@link loading} is still the entry for {@link fileId}. Invalidating,
 * clearing, or re-priming the file replaces that entry, so older async work
 * must stop instead of applying or persisting stale bytes.
 */
const isCurrentLoad = (fileId: number, loading: ThumbnailEntry): boolean =>
    cache.get(fileId) === loading;

/** Mark a load as failed, unless it was superseded while in flight. */
const failLoad = (
    fileId: number,
    loading: ThumbnailEntry,
    file?: EnteFile,
): void => {
    if (!isCurrentLoad(fileId, loading)) {
        return;
    }
    const attempts = (failureByFileId.get(fileId)?.attempts ?? 0) + 1;
    failureByFileId.set(fileId, { attempts, failedAt: Date.now(), file });
    cache.set(fileId, { status: "error" });
    notify(fileId);
};

const isRetryAllowed = (fileId: number, minAgeMs: number): boolean => {
    const failure = failureByFileId.get(fileId);
    if (!failure) {
        return true;
    }
    return (
        failure.attempts < MAX_THUMBNAIL_ATTEMPTS &&
        Date.now() - failure.failedAt >= minAgeMs
    );
};

/** Retry failed network loads once the device is back online. */
const retryFailedThumbnails = (): void => {
    for (const [fileId, failure] of failureByFileId) {
        if (failure.file && isRetryAllowed(fileId, 0)) {
            loadThumbnail(failure.file);
        }
    }
};

const dropPendingReady = (fileId: number): void => {
    for (let i = pendingReady.length - 1; i >= 0; i--) {
        if (pendingReady[i]?.fileId === fileId) {
            pendingReady.splice(i, 1);
        }
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

    // Discard first so the new entry lands at the end of the map (LRU order).
    const existing = cache.get(fileId);
    if (existing) {
        discardCacheEntry(fileId, existing);
    }

    const blob = blobFromUint8Array(bytes, "image/jpeg");
    const url = URL.createObjectURL(blob);
    sessionReadyBytes += byteSize;
    cache.set(fileId, { status: "ready", url, byteSize });
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
    dropPendingReady(fileId);
    failureByFileId.delete(fileId);
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
    if (existing && existing.status !== "idle" && existing.status !== "error") {
        return;
    }

    const loading: ThumbnailEntry = { status: "loading" };
    cache.set(file.id, loading);
    notify(file.id);

    const task = (): void => {
        void (async (): Promise<void> => {
            try {
                // Invalidated or re-primed while queued.
                if (!isCurrentLoad(file.id, loading)) {
                    return;
                }
                relieveHeapPressureIfNeeded();

                // Cell scrolled away during a fling — do not burn decrypt CPU.
                if (!hasSubscribers(file.id) && isGalleryScrolling()) {
                    resetToIdle(file.id);
                    return;
                }

                const cached = await getThumbnailCiphertext(file.id);
                if (!isCurrentLoad(file.id, loading)) {
                    return;
                }
                if (cached) {
                    if (!hasSubscribers(file.id) && isGalleryScrolling()) {
                        resetToIdle(file.id);
                        return;
                    }
                    const bytes = await decryptThumbnailCiphertext(
                        cached,
                        file.key,
                    );
                    if (!isCurrentLoad(file.id, loading)) {
                        return;
                    }
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
                if (!isCurrentLoad(file.id, loading)) {
                    return;
                }
                // Persisting is fire-and-forget (the put swallows its own
                // errors) so it never delays first paint.
                if (!hasSubscribers(file.id)) {
                    // Cache the ciphertext; skip decode until remounted.
                    void putThumbnailCiphertext(file.id, ciphertext);
                    resetToIdle(file.id);
                    return;
                }
                const bytes = await decryptThumbnailCiphertext(
                    ciphertext,
                    file.key,
                );
                if (!isCurrentLoad(file.id, loading)) {
                    return;
                }
                scheduleSetReady(file.id, bytes);
                void putThumbnailCiphertext(file.id, ciphertext);
            } catch {
                failLoad(file.id, loading, file);
            } finally {
                finishTask();
            }
        })();
    };

    enqueueLoad(file.id, task);
};

/**
 * Return the cached entry, starting a load when the thumbnail is idle, or when
 * it failed and the retry limits allow another attempt (a remount must wait
 * {@link REMOUNT_RETRY_DELAY_MS} after the last failure).
 */
export const requestThumbnail = (file: EnteFile): ThumbnailEntry => {
    const entry: ThumbnailEntry = getThumbnailEntry(file.id);
    if (
        entry.status === "idle" ||
        (entry.status === "error" &&
            isRetryAllowed(file.id, REMOUNT_RETRY_DELAY_MS))
    ) {
        loadThumbnail(file);
        return loadingEntry;
    }
    return entry;
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
    const bytes = await decryptThumbnailCiphertext(ciphertext, file.key);
    // Persist off the critical path; the put swallows its own errors.
    void putThumbnailCiphertext(file.id, ciphertext);
    return bytes;
};

/**
 * Show a thumbnail immediately from full image bytes (e.g. after optimistic crop).
 */
export const primeThumbnailFromBytes = (
    fileId: number,
    imageBytes: Uint8Array,
    mimeType = "image/jpeg",
): void => {
    primeThumbnail(fileId, () => generateImageThumbnail(imageBytes, mimeType));
};

/**
 * Show a thumbnail immediately from edited video bytes (e.g. after optimistic crop).
 */
export const primeVideoThumbnailFromBytes = (
    fileId: number,
    videoBytes: Uint8Array,
): void => {
    primeThumbnail(fileId, async () => {
        const { extractVideoFrameJpeg } = await import("@/lib/ffmpeg");
        const frameBytes = await extractVideoFrameJpeg(videoBytes, "video/mp4");
        return generateImageThumbnail(frameBytes);
    });
};

/** Replace the file's entry with a loading one and fill it from `generate`. */
const primeThumbnail = (
    fileId: number,
    generate: () => Promise<Uint8Array>,
): void => {
    const existing = cache.get(fileId);
    if (existing) {
        discardCacheEntry(fileId, existing);
    }
    dropPendingReady(fileId);
    const loading: ThumbnailEntry = { status: "loading" };
    cache.set(fileId, loading);
    notify(fileId);

    void (async (): Promise<void> => {
        try {
            const thumbBytes = await generate();
            if (isCurrentLoad(fileId, loading)) {
                scheduleSetReady(fileId, thumbBytes);
            }
        } catch {
            failLoad(fileId, loading);
        }
    })();
};

/**
 * Drop session blob URL + IDB ciphertext for a file (trash, sync delete, replace).
 */
export const invalidateThumbnailCache = async (
    fileId: number,
): Promise<void> => {
    dropPendingReady(fileId);
    failureByFileId.delete(fileId);
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
    failureByFileId.clear();
    sessionReadyBytes = 0;
    listeners.clear();
    highQueue.length = 0;
    lowQueue.length = 0;
    pendingReady.length = 0;
    applyFrameScheduled = false;
    // inFlight is left alone: loads already started still call finishTask.
};

if (typeof window !== "undefined") {
    window.addEventListener("online", retryFailedThumbnails);
}
