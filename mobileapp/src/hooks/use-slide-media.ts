import { useCallback, useEffect, useRef, useState } from "react";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { loadMediaBytesForEdit } from "@/lib/load-media-bytes";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { mimeTypeForFile } from "@/lib/media-kind";
import { toRenderableImageBlob } from "@/lib/renderable-image";
import { requestThumbnail } from "@/lib/thumbnail-cache";
import {
    invalidateVideoCache,
    retainSessionVideoUrl,
    takeSessionVideoUrl,
    transferSessionVideoUrl,
} from "@/lib/video-media-cache";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";

type SlideStatus = "idle" | "loading" | "ready" | "error";

export interface SlideMedia {
    status: SlideStatus;
    url?: string;
    /** Download percent 0–100 when known; undefined while indeterminate. */
    progress?: number;
    bytesLoaded?: number;
    bytesTotal?: number;
}

interface SlideLoader {
    fileId: number;
    cancelled: boolean;
    timeoutId: number;
    abortController: AbortController;
}

export interface SlideMediaController {
    mediaByFileId: Map<number, SlideMedia>;
    setSlideMedia: (fileId: number, media: SlideMedia) => void;
    /** Own {@link url} for the slide, revoking any URL it replaces, and mark it ready. */
    setSlideUrl: (fileId: number, url: string, byteSize: number) => void;
    /** Forget and revoke a slide's media entirely (e.g. the file was trashed). */
    removeSlide: (fileId: number) => void;
    /** Drop the slide's URL and load it again (e.g. a derived upload failed). */
    reloadSlide: (fileId: number) => void;
    /** User-requested retry after a failed load; also refetches video. */
    retrySlide: (fileId: number) => void;
    /** Blob URL revoked or undecodable under the `<img>`/`<video>`; reload once, then fail. */
    handleBrokenSlideMedia: (fileId: number) => void;
    /** Re-key a slide's media from {@link sourceId} to {@link uploadedId} without revoking it. */
    transferSlide: (sourceId: number, uploadedId: number) => void;
}

/** A full-res load with no download progress for this long is abandoned. */
const MEDIA_LOAD_TIMEOUT_MS = 60_000;
/**
 * Decoded media kept in the viewer: prefer ahead (typical swipe direction)
 * over behind so forward browsing rarely hits a loading screen.
 */
const PRELOAD_AHEAD = 3;
const PRELOAD_BEHIND = 1;
/** Videos are large, so only the immediate neighbours are preloaded. */
const VIDEO_PRELOAD_DISTANCE = 1;
/** Cap parallel full-file fetches so one hung download cannot saturate the browser. */
const MAX_CONCURRENT_MEDIA_LOADS = 2;

/**
 * Blob the browser can display for {@link file}'s decrypted {@link bytes}.
 */
export const slideBlob = (
    file: EnteFile,
    bytes: Uint8Array,
): Promise<Blob> | Blob =>
    file.metadata.fileType === FileType.video ?
        blobFromUint8Array(bytes, mimeTypeForFile(file)) :
        toRenderableImageBlob(file, bytes);

/**
 * Own the viewer's slide media: loads the window around {@link currentIndex}
 * (cancelling work that leaves it), tracks blob URL lifetime, and releases
 * everything on unmount. Video URLs that leave the window go to the session cache.
 */
export function useSlideMedia(
    files: EnteFile[],
    currentIndex: number,
): SlideMediaController {
    const [mediaByFileId, setMediaByFileId] = useState<
        Map<number, SlideMedia>
    >(() => new Map());
    const [retryKey, setRetryKey] = useState<number>(0);

    const urlsRef = useRef<Map<number, string>>(new Map());
    const byteSizesRef = useRef<Map<number, number>>(new Map());
    const loadingIdsRef = useRef<Set<number>>(new Set());
    const loadersRef = useRef<Map<number, SlideLoader>>(new Map());
    /** Loads whose promise has not settled, including aborted ones; bounds concurrency. */
    const unsettledLoadersRef = useRef<Set<SlideLoader>>(new Set());
    /** Slides whose load failed; not retried until the user asks or they leave the window. */
    const failedIdsRef = useRef<Set<number>>(new Set());
    /** Slides already reloaded once after a media element error. */
    const brokenReloadIdsRef = useRef<Set<number>>(new Set());
    /** Load pump for the current window; a no-op after unmount. */
    const pumpLoadsRef = useRef<() => void>(() => undefined);
    const currentIndexRef = useRef<number>(currentIndex);
    const filesRef = useRef<EnteFile[]>(files);

    useEffect((): void => {
        currentIndexRef.current = currentIndex;
        filesRef.current = files;
    }, [currentIndex, files]);

    const setSlideMedia = useCallback(
        (fileId: number, media: SlideMedia): void => {
            setMediaByFileId((current) => {
                const next = new Map(current);
                next.set(fileId, media);
                return next;
            });
        },
        [],
    );

    const setSlideUrl = useCallback(
        (fileId: number, url: string, byteSize: number): void => {
            const previousUrl = urlsRef.current.get(fileId);
            if (previousUrl && previousUrl !== url) {
                URL.revokeObjectURL(previousUrl);
            }
            urlsRef.current.set(fileId, url);
            byteSizesRef.current.set(fileId, byteSize);
            setSlideMedia(fileId, { status: "ready", url });
        },
        [setSlideMedia],
    );

    useEffect(() => {
        const urls = urlsRef.current;
        const loadingIds = loadingIdsRef.current;
        const loadersByFileId = loadersRef.current;
        const unsettledLoaders = unsettledLoadersRef.current;
        const failedIds = failedIdsRef.current;
        const keepFiles = preloadSlideIndices(currentIndex, files).map(
            (index) => files[index],
        );
        const keepIds = new Set(keepFiles.map((slideFile) => slideFile.id));

        const releaseLoader = (loader: SlideLoader): void => {
            unsettledLoaders.delete(loader);
            // Only the active loader for this file may clear the slot — a
            // cancelled predecessor must not wipe a newer in-flight load.
            if (loadersByFileId.get(loader.fileId) !== loader) {
                return;
            }
            loadersByFileId.delete(loader.fileId);
            loadingIds.delete(loader.fileId);
        };

        // Drop in-flight work only for slides that left the preload window.
        for (const [fileId, loader] of [...loadersByFileId.entries()]) {
            if (keepIds.has(fileId)) {
                continue;
            }
            cancelLoader(loader);
            loadersByFileId.delete(fileId);
            loadingIds.delete(fileId);
            setMediaByFileId((current) =>
                current.get(fileId)?.status === "loading" ?
                    withoutSlideMedia(current, fileId) :
                    current);
        }
        for (const fileId of [...failedIds]) {
            if (!keepIds.has(fileId)) {
                failedIds.delete(fileId);
            }
        }

        const startLoad = (slideFile: EnteFile): void => {
            loadingIds.add(slideFile.id);
            setSlideMedia(slideFile.id, { status: "loading" });
            const loader: SlideLoader = {
                fileId: slideFile.id,
                cancelled: false,
                timeoutId: 0,
                abortController: new AbortController(),
            };
            // Re-armed on every progress tick so a slow but moving download
            // (large video on mobile data) is not abandoned; a stalled one is.
            const armStallTimeout = (): void => {
                window.clearTimeout(loader.timeoutId);
                loader.timeoutId = window.setTimeout(() => {
                    if (loader.cancelled) {
                        return;
                    }
                    cancelLoader(loader);
                    releaseLoader(loader);
                    failedIds.add(slideFile.id);
                    setSlideMedia(slideFile.id, { status: "error" });
                    pumpLoadsRef.current();
                }, MEDIA_LOAD_TIMEOUT_MS);
            };
            armStallTimeout();
            loadersByFileId.set(slideFile.id, loader);
            unsettledLoaders.add(loader);

            const reportDownloadProgress = ({
                loaded,
                total,
            }: {
                loaded: number;
                total: number;
            }): void => {
                if (loader.cancelled) {
                    return;
                }
                armStallTimeout();
                // Background preloads stay quiet; only the visible slide
                // re-renders the viewer on download progress.
                if (
                    filesRef.current[currentIndexRef.current]?.id !==
                    slideFile.id
                ) {
                    return;
                }
                setSlideMedia(slideFile.id, {
                    status: "loading",
                    progress:
                        total > 0 ?
                            Math.min(100, Math.round((loaded / total) * 100)) :
                            undefined,
                    bytesLoaded: loaded,
                    bytesTotal: total > 0 ? total : undefined,
                });
            };

            void loadMediaBytesForEdit(
                slideFile,
                reportDownloadProgress,
                loader.abortController.signal,
            )
                .then(async (bytes) => {
                    window.clearTimeout(loader.timeoutId);
                    if (loader.cancelled) {
                        releaseLoader(loader);
                        pumpLoadsRef.current();
                        return;
                    }
                    setSlideMedia(slideFile.id, {
                        status: "loading",
                        progress: 100,
                        bytesLoaded: bytes.byteLength,
                        bytesTotal: bytes.byteLength,
                    });
                    const blob = await slideBlob(slideFile, bytes);
                    if (loader.cancelled) {
                        releaseLoader(loader);
                        pumpLoadsRef.current();
                        return;
                    }
                    releaseLoader(loader);
                    setSlideUrl(
                        slideFile.id,
                        URL.createObjectURL(blob),
                        blob.size,
                    );
                    pumpLoadsRef.current();
                })
                .catch(() => {
                    window.clearTimeout(loader.timeoutId);
                    releaseLoader(loader);
                    if (!loader.cancelled) {
                        failedIds.add(slideFile.id);
                        setSlideMedia(slideFile.id, { status: "error" });
                    }
                    pumpLoadsRef.current();
                });
        };

        pumpLoadsRef.current = (): void => {
            let inFlight = unsettledLoaders.size;
            for (const slideFile of keepFiles) {
                if (inFlight >= MAX_CONCURRENT_MEDIA_LOADS) {
                    break;
                }
                if (
                    urls.has(slideFile.id) ||
                    loadingIds.has(slideFile.id) ||
                    failedIds.has(slideFile.id)
                ) {
                    continue;
                }
                startLoad(slideFile);
                inFlight += 1;
            }
        };

        for (const slideFile of keepFiles) {
            const isVideoSlide = slideFile.metadata.fileType === FileType.video;
            if (isVideoSlide) {
                requestThumbnail(slideFile);
            }
            if (
                urls.has(slideFile.id) ||
                !isVideoSlide ||
                getLocalMediaOverride(slideFile.id)
            ) {
                continue;
            }
            const sessionHit = takeSessionVideoUrl(slideFile.id);
            if (sessionHit) {
                setSlideUrl(slideFile.id, sessionHit.url, sessionHit.byteSize);
            }
        }

        pumpLoadsRef.current();

        for (const [fileId, url] of [...urls.entries()]) {
            if (keepIds.has(fileId)) {
                continue;
            }
            urls.delete(fileId);
            loadingIds.delete(fileId);
            const knownSize = byteSizesRef.current.get(fileId);
            byteSizesRef.current.delete(fileId);
            retainOrRevokeMediaUrl(
                files.find((entry) => entry.id === fileId),
                fileId,
                url,
                knownSize,
            );
            setMediaByFileId((current) => withoutSlideMedia(current, fileId));
        }
    }, [currentIndex, retryKey, files, setSlideMedia, setSlideUrl]);

    useEffect((): (() => void) => {
        const urls = urlsRef.current;
        const sizes = byteSizesRef.current;
        const loaders = loadersRef.current;
        const loadingIds = loadingIdsRef.current;
        const pumpLoads = pumpLoadsRef;
        const currentFiles = filesRef;
        return (): void => {
            // Cancelled loads settle after unmount; they must not start new ones.
            pumpLoads.current = (): void => undefined;
            for (const loader of loaders.values()) {
                cancelLoader(loader);
            }
            loaders.clear();
            loadingIds.clear();
            for (const [fileId, url] of [...urls.entries()]) {
                retainOrRevokeMediaUrl(
                    currentFiles.current.find((entry) => entry.id === fileId),
                    fileId,
                    url,
                    sizes.get(fileId),
                );
            }
            urls.clear();
            sizes.clear();
        };
    }, []);

    const cancelSlideLoader = useCallback((fileId: number): void => {
        const activeLoader = loadersRef.current.get(fileId);
        if (activeLoader) {
            cancelLoader(activeLoader);
            loadersRef.current.delete(fileId);
        }
    }, []);

    /** Forget and revoke a slide's blob URL; returns whether one was held. */
    const discardSlideUrl = useCallback((fileId: number): boolean => {
        const url = urlsRef.current.get(fileId);
        urlsRef.current.delete(fileId);
        byteSizesRef.current.delete(fileId);
        if (!url) {
            return false;
        }
        URL.revokeObjectURL(url);
        return true;
    }, []);

    const removeSlide = useCallback(
        (fileId: number): void => {
            discardSlideUrl(fileId);
            setMediaByFileId((current) => withoutSlideMedia(current, fileId));
        },
        [discardSlideUrl],
    );

    const reloadSlide = useCallback(
        (fileId: number): void => {
            discardSlideUrl(fileId);
            setSlideMedia(fileId, { status: "loading" });
            setRetryKey((key) => key + 1);
        },
        [discardSlideUrl, setSlideMedia],
    );

    const retrySlide = useCallback(
        (fileId: number): void => {
            cancelSlideLoader(fileId);
            invalidateVideoCache(fileId);
            discardSlideUrl(fileId);
            loadingIdsRef.current.delete(fileId);
            failedIdsRef.current.delete(fileId);
            brokenReloadIdsRef.current.delete(fileId);
            setSlideMedia(fileId, { status: "idle" });
            setRetryKey((key) => key + 1);
        },
        [cancelSlideLoader, discardSlideUrl, setSlideMedia],
    );

    const handleBrokenSlideMedia = useCallback(
        (fileId: number): void => {
            cancelSlideLoader(fileId);
            if (!discardSlideUrl(fileId)) {
                return;
            }
            loadingIdsRef.current.delete(fileId);
            // A second error on freshly loaded bytes means the browser cannot
            // decode this file; show the error instead of reloading forever.
            if (brokenReloadIdsRef.current.has(fileId)) {
                failedIdsRef.current.add(fileId);
                setSlideMedia(fileId, { status: "error" });
                return;
            }
            brokenReloadIdsRef.current.add(fileId);
            setSlideMedia(fileId, { status: "idle" });
            setRetryKey((key) => key + 1);
        },
        [cancelSlideLoader, discardSlideUrl, setSlideMedia],
    );

    const transferSlide = useCallback(
        (sourceId: number, uploadedId: number): void => {
            const url = urlsRef.current.get(sourceId);
            const byteSize = byteSizesRef.current.get(sourceId);
            if (url) {
                urlsRef.current.delete(sourceId);
                urlsRef.current.set(uploadedId, url);
            }
            if (byteSize !== undefined) {
                byteSizesRef.current.delete(sourceId);
                byteSizesRef.current.set(uploadedId, byteSize);
            }
            transferSessionVideoUrl(sourceId, uploadedId);
            setMediaByFileId((current) => {
                const media = current.get(sourceId);
                if (!media) {
                    return current;
                }
                const next = new Map(current);
                next.delete(sourceId);
                next.set(uploadedId, media);
                return next;
            });
        },
        [],
    );

    return {
        mediaByFileId,
        setSlideMedia,
        setSlideUrl,
        removeSlide,
        reloadSlide,
        retrySlide,
        handleBrokenSlideMedia,
        transferSlide,
    };
}

/**
 * Indices to keep loaded around {@link current}, current first then ahead then behind.
 * Video slides are only kept within {@link VIDEO_PRELOAD_DISTANCE} of the current slide.
 */
const preloadSlideIndices = (
    current: number,
    files: EnteFile[],
): number[] => {
    const ordered: number[] = [];
    const seen = new Set<number>();
    const push = (index: number, distance: number): void => {
        if (index < 0 || index >= files.length || seen.has(index)) {
            return;
        }
        if (
            distance > VIDEO_PRELOAD_DISTANCE &&
            files[index].metadata.fileType === FileType.video
        ) {
            return;
        }
        seen.add(index);
        ordered.push(index);
    };
    push(current, 0);
    for (let distance = 1; distance <= PRELOAD_AHEAD; distance++) {
        push(current + distance, distance);
    }
    for (let distance = 1; distance <= PRELOAD_BEHIND; distance++) {
        push(current - distance, distance);
    }
    return ordered;
};

/**
 * Cancel a slide load. It keeps counting toward the concurrency cap in
 * `unsettledLoadersRef` until its promise settles.
 */
const cancelLoader = (loader: SlideLoader): void => {
    loader.cancelled = true;
    window.clearTimeout(loader.timeoutId);
    loader.abortController.abort();
};

/**
 * Hand a video's blob URL to the session cache, or revoke the URL of any
 * other slide.
 */
const retainOrRevokeMediaUrl = (
    slideFile: EnteFile | undefined,
    fileId: number,
    url: string,
    knownSize: number | undefined,
): void => {
    if (slideFile?.metadata.fileType === FileType.video) {
        retainSessionVideoUrl(
            fileId,
            url,
            knownSize ?? slideFile.info?.fileSize ?? 0,
        );
    } else {
        URL.revokeObjectURL(url);
    }
};

const withoutSlideMedia = (
    current: Map<number, SlideMedia>,
    fileId: number,
): Map<number, SlideMedia> => {
    if (!current.has(fileId)) {
        return current;
    }
    const next = new Map(current);
    next.delete(fileId);
    return next;
};
