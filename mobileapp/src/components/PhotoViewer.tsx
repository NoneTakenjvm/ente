import {
    startTransition,
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type JSX,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    type TouchEvent as ReactTouchEvent,
} from "react";
import {
    Archive,
    ArchiveRestore,
    ChevronLeft,
    ChevronRight,
    Crop,
    Heart,
    Image,
    MoreVertical,
    Tag,
    Trash2,
    Undo2,
    X,
} from "lucide-react";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { ConfirmRevertEditModal } from "@/components/ConfirmRevertEditModal";
import {
    CropEditorOverlay,
    type CropSaveResult,
} from "@/components/CropEditorOverlay";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import {
    VideoEditorOverlay,
    type VideoSaveResult,
} from "@/components/VideoEditorOverlay";
import { VideoPlaybackControls } from "@/components/VideoPlaybackControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { usePinchZoom } from "@/hooks/use-pinch-zoom";
import { canCrop, canCropVideo } from "@/lib/crop";
import { hasEditHistory } from "@/lib/edit-history";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import {
    isEnteVideoFile,
    mediaKindForFile,
    mimeTypeForFile,
} from "@/lib/media-kind";
import { toRenderableImageBlob } from "@/lib/renderable-image";
import { cn } from "@/lib/utils";
import {
    forgetSessionVideoUrl,
    invalidateVideoCache,
    loadCachedVideoBytes,
    retainSessionVideoUrl,
    takeSessionVideoUrl,
    transferSessionVideoUrl,
} from "@/lib/video-media-cache";
import {
    extractTags,
    extractUserTags,
    isReservedTag,
    isSystemTag,
} from "@/lib/tags";
import { addTagNames, applyTagMutator, normalizeTagName, removeTagNames, tagsEqual } from "@/lib/tag-writes";
import { enqueueTagOutboxEntries } from "@/lib/tag-outbox";
import { requestTagOutboxFlush } from "@/lib/tag-outbox-runner";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { FileType } from "ente-media/file-type";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import { useVideoPlaybackStore } from "@/stores/video-playback-store";
import type { EnteFile } from "ente-media/file";
import { toast } from "sonner";

type CarouselDragMode = "horizontal" | "dismiss";

interface CarouselDragStart {
    x: number;
    y: number;
    dragPx: number;
    dragging: boolean;
    mode?: CarouselDragMode;
}
interface PhotoViewerProps {
    files: EnteFile[];
    initialFileId: number;
    onClose: () => void;
    onFileUpdated?: (file: EnteFile) => void;
    albumCoverFileId?: number;
    onSetAlbumCover?: (fileId: number) => void;
}

type SlideStatus = "idle" | "loading" | "ready" | "error";

interface SlideLoader {
    fileId: number;
    cancelled: boolean;
    timedOut: boolean;
    timeoutId: number;
}

interface SlideMedia {
    status: SlideStatus;
    url?: string;
    /** Download percent 0–100 when known; undefined while indeterminate. */
    progress?: number;
    bytesLoaded?: number;
    bytesTotal?: number;
}

const formatDownloadBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "?";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Label + optional size/progress for full-media download in the viewer.
 */
function MediaDownloadIndicator({
    kind,
    progress,
    bytesLoaded,
    bytesTotal,
}: {
    kind: "video" | "photo";
    progress?: number;
    bytesLoaded?: number;
    bytesTotal?: number;
}): JSX.Element {
    const label =
        kind === "video" ? "Downloading video..." : "Downloading photo...";
    const sizeLabel =
        bytesLoaded !== undefined &&
        bytesTotal !== undefined &&
        bytesTotal > 0 ?
            `${formatDownloadBytes(bytesLoaded)} / ${formatDownloadBytes(bytesTotal)}` :
            bytesLoaded !== undefined && bytesLoaded > 0 ?
                formatDownloadBytes(bytesLoaded) :
                undefined;

    return (
        <div
            className="flex w-52 flex-col items-center gap-1.5"
            role="status"
            aria-label={label}
        >
            <span className="text-center text-xs text-muted-foreground">
                {label}
            </span>
            {sizeLabel ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                    {sizeLabel}
                </span>
            ) : null}
            {progress !== undefined ? (
                <Progress value={progress} className="w-full" />
            ) : (
                <div
                    className="h-1.5 w-full animate-pulse rounded-full bg-primary/50"
                    aria-hidden
                />
            )}
        </div>
    );
}

const CAROUSEL_TRANSITION_MS = 280;
const SWIPE_THRESHOLD_RATIO = 0.22;
const SWIPE_THRESHOLD_MIN_PX = 40;
/** History-state marker so Safari edge-back can be absorbed while the viewer is open. */
const VIEWER_HISTORY_STATE = { entePhotoViewer: true } as const;
const CAROUSEL_DRAG_DEAD_ZONE_PX = 8;
const CHROME_HIDE_MS = 2000;
/** Full-res download + HEIC convert can exceed a few seconds on desktop. */
const MEDIA_LOAD_TIMEOUT_MS = 60_000;
/**
 * Decoded media kept in the viewer: prefer ahead (typical swipe direction)
 * over behind so forward browsing rarely hits a loading screen.
 */
const PRELOAD_AHEAD = 3;
const PRELOAD_BEHIND = 1;
/** Cap parallel full-file fetches so one hung download cannot saturate the browser. */
const MAX_CONCURRENT_MEDIA_LOADS = 2;
const TAP_MAX_MOVEMENT_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
const DISMISS_THRESHOLD_MIN_PX = 80;
const DISMISS_THRESHOLD_RATIO = 0.15;

/**
 * Indices to keep loaded around {@link current}, current first then ahead then behind.
 */
const preloadSlideIndices = (
    current: number,
    length: number,
): number[] => {
    const ordered: number[] = [];
    const seen = new Set<number>();
    const push = (index: number): void => {
        if (index < 0 || index >= length || seen.has(index)) {
            return;
        }
        seen.add(index);
        ordered.push(index);
    };
    push(current);
    for (let distance = 1; distance <= PRELOAD_AHEAD; distance++) {
        push(current + distance);
    }
    for (let distance = 1; distance <= PRELOAD_BEHIND; distance++) {
        push(current - distance);
    }
    return ordered;
};

/**
 * Show the cached gallery thumbnail while a video slide decrypts/downloads.
 */
function VideoSlidePoster({
    file,
    children,
}: {
    file: EnteFile;
    children?: ReactNode;
}): JSX.Element {
    const thumb = useSyncExternalStore(
        (listener) => subscribeThumbnail(file.id, listener),
        () => getThumbnailEntry(file.id),
        () => getThumbnailEntry(0),
    );

    useEffect((): void => {
        requestThumbnail(file);
    }, [file]);

    return (
        <div className="absolute inset-0 bg-black/40">
            {thumb.status === "ready" && thumb.url ? (
                <img
                    className="pointer-events-none size-full object-contain select-none"
                    src={thumb.url}
                    alt=""
                    draggable={false}
                />
            ) : null}
            {children ? (
                <div className="absolute inset-0 flex items-center justify-center">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Decode and pause on the first frame so the preview is not black when autoplay is off.
 */
const primeVideoFirstFrame = (video: HTMLVideoElement): void => {
    const seekToStart = (): void => {
        video.pause();
        try {
            video.currentTime = 0;
        } catch {
            // Metadata may not be ready yet on some browsers.
        }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        seekToStart();
        return;
    }

    video.addEventListener("loadeddata", seekToStart, { once: true });

    void video.play()
        .then(() => {
            video.pause();
            seekToStart();
        })
        .catch(() => {
            seekToStart();
        });
};

export function PhotoViewer({
    files,
    initialFileId,
    onClose,
    onFileUpdated,
    albumCoverFileId,
    onSetAlbumCover,
}: PhotoViewerProps): JSX.Element {
    const [sessionFiles, setSessionFiles] = useState<EnteFile[]>(files);
    const [currentIndex, setCurrentIndex] = useState<number>(() => {
        const index = sessionFiles.findIndex((entry) => entry.id === initialFileId);
        return index >= 0 ? index : 0;
    });
    const [mediaByFileId, setMediaByFileId] = useState<
        Map<number, SlideMedia>
    >(() => new Map());
    const [retryKey, setRetryKey] = useState<number>(0);
    const [tagError, setTagError] = useState<string | undefined>();
    const [tagSaveBusy, setTagSaveBusy] = useState<boolean>(false);
    const [showTagPicker, setShowTagPicker] = useState<boolean>(false);
    /** Local draft while the tag sheet is open; committed on close. */
    const [stagedTags, setStagedTags] = useState<string[] | null>(null);
    const [favoriteBusy, setFavoriteBusy] = useState<boolean>(false);
    const [favoriteError, setFavoriteError] = useState<string | undefined>();
    const [archiveBusy, setArchiveBusy] = useState<boolean>(false);
    const [revertBusy, setRevertBusy] = useState<boolean>(false);
    const [showRevertConfirm, setShowRevertConfirm] = useState<boolean>(false);
    const [cropMode, setCropMode] = useState<boolean>(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
    const [deleteBusy, setDeleteBusy] = useState<boolean>(false);
    const [deleteError, setDeleteError] = useState<string | undefined>();
    const [carouselDragPx, setCarouselDragPx] = useState<number>(0);
    const [dismissDragPx, setDismissDragPx] = useState<number>(0);
    const [carouselAnimating, setCarouselAnimating] = useState<boolean>(false);
    const [viewportWidth, setViewportWidth] = useState<number>(0);
    const [viewportHeight, setViewportHeight] = useState<number>(0);
    const [chromeVisible, setChromeVisible] = useState<boolean>(true);
    const [videoScrubbing, setVideoScrubbing] = useState<boolean>(false);
    const coarsePointer = useCoarsePointer();

    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const activeImageRef = useRef<HTMLImageElement>(null);
    const activeVideoRef = useRef<HTMLVideoElement>(null);
    const pinchLayoutRef = useRef<
        { container: HTMLElement; image: HTMLImageElement } | null
    >(null);
    const carouselDragStartRef = useRef<CarouselDragStart | undefined>(undefined);
    const carouselPointerIdRef = useRef<number | undefined>(undefined);
    const chromeTimerRef = useRef<number | undefined>(undefined);
    const skipChromeTapRef = useRef<boolean>(false);
    const mediaTapCountRef = useRef<number>(0);
    const mediaTapCountResetRef = useRef<number | undefined>(undefined);
    const lastTouchTapRef = useRef<
        { time: number; x: number; y: number } | undefined
    >(undefined);
    const zoomPointerStartRef = useRef<
        { x: number; y: number } | undefined
    >(undefined);
    const mediaUrlsRef = useRef<Map<number, string>>(new Map());
    const mediaByteSizesRef = useRef<Map<number, number>>(new Map());
    const loadingIdsRef = useRef<Set<number>>(new Set());
    const mediaLoadersRef = useRef<Map<number, SlideLoader>>(new Map());
    const viewerFileIdRef = useRef<number>(initialFileId);
    const currentIndexRef = useRef<number>(currentIndex);
    const sessionFilesRef = useRef<EnteFile[]>(sessionFiles);
    const tagBaselineRef = useRef<string[]>([]);
    /** Mirrors {@link stagedTags} so close flush always reads the latest draft. */
    const stagedTagsRef = useRef<string[] | null>(null);
    const viewerActiveRef = useRef<boolean>(true);

    currentIndexRef.current = currentIndex;
    sessionFilesRef.current = sessionFiles;

    useEffect((): (() => void) => {
        viewerActiveRef.current = true;
        return (): void => {
            viewerActiveRef.current = false;
        };
    }, []);

    // Absorb Safari / browser edge-back while the viewer is open (stay put).
    useEffect((): (() => void) => {
        const marker = { ...VIEWER_HISTORY_STATE };
        history.pushState(marker, "");

        const onPopState = (): void => {
            history.pushState(marker, "");
        };
        window.addEventListener("popstate", onPopState);

        return (): void => {
            window.removeEventListener("popstate", onPopState);
            const state = history.state as { entePhotoViewer?: boolean } | null;
            if (state?.entePhotoViewer) {
                history.back();
            }
        };
    }, []);

    const notifyFileUpdated = useCallback(
        (updated: EnteFile): void => {
            if (!viewerActiveRef.current) {
                return;
            }
            onFileUpdated?.(updated);
        },
        [onFileUpdated],
    );

    const file = sessionFiles[currentIndex];
    const mediaKind = file ? mediaKindForFile(file) : null;
    const isVideo = file?.metadata.fileType === FileType.video;
    const relativeSort = useUIStore((s) => s.relativeSort);
    const relativeStartFileId = useUIStore((s) => s.relativeStartFileId);
    const setRelativeStartFileId = useUIStore((s) => s.setRelativeStartFileId);
    const hasClipEmbedding = useEmbeddingIndexStore((s) => {
        if (!file) {
            return false;
        }
        const vector = s.entries.get(file.id);
        return vector?.length === KIT_EMBEDDING_DIMS;
    });
    const showSetRelative =
        relativeSort !== "none" &&
        file !== undefined &&
        !isEnteVideoFile(file) &&
        hasClipEmbedding;
    const zoomEnabled = mediaKind === "image" || mediaKind === "gif";
    const chromePaused =
        cropMode ||
        showDeleteConfirm ||
        showTagPicker ||
        videoScrubbing;

    const updateTagsOnFile = useLibraryStore((s) => s.updateTagsOnFile);
    const viewerFileId = file?.id;
    const storeFile = useLibraryStore((s) =>
        viewerFileId === undefined ? undefined : s.getFileById(viewerFileId));
    const displayFile = storeFile ?? file;
    const setFileFavorite = useLibraryStore((s) => s.setFileFavorite);
    const setFileArchived = useLibraryStore((s) => s.setFileArchived);
    const revertLastEdit = useLibraryStore((s) => s.revertLastEdit);
    const moveFilesToTrash = useLibraryStore((s) => s.moveFilesToTrash);
    const isFavorite = useFavoritesStore((s) =>
        file ? s.favoriteFileIds.has(file.id) : false);
    const favoritePending = useFavoritesStore((s) =>
        file ? s.pendingFavoriteFileIds.has(file.id) : false);
    const isArchived = file ? isFileArchivedLocally(displayFile ?? file) : false;
    const canRevertEdit = file ? hasEditHistory(file.id) : false;
    const knownTags = useTagStore((s) => s.tags);
    const hydrateVideoPlayback = useVideoPlaybackStore((s) => s.hydrate);
    const videoVolume = useVideoPlaybackStore((s) => s.volume);
    const videoMuted = useVideoPlaybackStore((s) => s.muted);
    const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
    const videoLoop = useSettingsStore((s) => s.videoLoop);
    const activeVideoThumb = useSyncExternalStore(
        (listener) => {
            if (file?.metadata.fileType !== FileType.video) {
                return (): void => {};
            }
            return subscribeThumbnail(file.id, listener);
        },
        () =>
            file?.metadata.fileType === FileType.video ?
                getThumbnailEntry(file.id) :
                getThumbnailEntry(0),
        () => getThumbnailEntry(0),
    );
    const tags = displayFile ? extractUserTags(displayFile) : [];
    const displayTags = stagedTags ?? tags;
    const activeSlideMedia = file ? mediaByFileId.get(file.id) : undefined;

    useEffect((): void => {
        if (file?.metadata.fileType === FileType.video) {
            requestThumbnail(file);
        }
    }, [file]);

    useEffect((): void => {
        setVideoScrubbing(false);
    }, [file?.id]);

    useEffect((): void => {
        hydrateVideoPlayback();
    }, [hydrateVideoPlayback]);

    useEffect((): void => {
        const video = activeVideoRef.current;
        if (!video || !isVideo) {
            return;
        }
        video.volume = videoVolume;
        video.muted = videoMuted;
    }, [isVideo, videoMuted, videoVolume, file?.id, activeSlideMedia?.status]);

    useEffect(() => {
        if (relativeStartFileId === undefined) {
            return;
        }
        const currentId = viewerFileIdRef.current;
        setSessionFiles(files);
        const index = files.findIndex((entry) => entry.id === currentId);
        if (index >= 0) {
            setCurrentIndex(index);
        }
        // Rematch viewer order after pinning a relative tip (files already rebuilt).
        // eslint-disable-next-line react-hooks/exhaustive-deps -- tip change only
    }, [relativeStartFileId]);

    useEffect(() => {
        if (initialFileId === viewerFileIdRef.current) {
            return;
        }
        viewerFileIdRef.current = initialFileId;
        const index = sessionFiles.findIndex((entry) => entry.id === initialFileId);
        if (index >= 0) {
            setCurrentIndex(index);
        }
    }, [initialFileId, sessionFiles]);

    useEffect(() => {
        if (!file || sessionFiles.some((entry) => entry.id === file.id)) {
            return;
        }
        onClose();
    }, [file, onClose, sessionFiles]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) {
            return;
        }
        const updateSize = (): void => {
            setViewportWidth(viewport.clientWidth);
            setViewportHeight(viewport.clientHeight);
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(viewport);
        return (): void => {
            observer.disconnect();
        };
    }, []);

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

    const goToIndexRef = useRef<(index: number, animate?: boolean) => void>(
        () => undefined,
    );

    // Zoomed pan must not advance the carousel — edge overflow stays in-image only.
    const pinchZoom = usePinchZoom({
        enabled: zoomEnabled,
        layoutRef: pinchLayoutRef,
    });

    const {
        reset: resetZoom,
        updatePanBounds,
        scale: zoomScale,
        getPointerCount,
        registerPointer,
        clearPointers,
        releasePointer,
    } = pinchZoom;

    useEffect((): void => {
        resetZoom();
        setCarouselDragPx(0);
        setDismissDragPx(0);
    }, [file?.id, resetZoom]);

    useEffect((): void => {
        const viewport = viewportRef.current;
        const image = activeImageRef.current;
        if (!viewport || !image || zoomScale <= 1.01) {
            return;
        }
        updatePanBounds(viewport, image);
        pinchLayoutRef.current = { container: viewport, image };
    }, [updatePanBounds, zoomScale, file?.id, viewportWidth]);

    useEffect(() => {
        const loadingIds = loadingIdsRef.current;
        const loadersByFileId = mediaLoadersRef.current;
        const keepIndices = preloadSlideIndices(
            currentIndex,
            sessionFiles.length,
        );
        const keepIds = new Set<number>();
        const keepFiles: EnteFile[] = [];

        for (const index of keepIndices) {
            const slideFile = sessionFiles[index];
            keepIds.add(slideFile.id);
            keepFiles.push(slideFile);
        }

        const releaseLoader = (loader: SlideLoader): void => {
            // Only the active loader for this file may clear the slot — a
            // cancelled predecessor must not wipe a newer in-flight load.
            if (loadersByFileId.get(loader.fileId) !== loader) {
                return;
            }
            loadersByFileId.delete(loader.fileId);
            loadingIds.delete(loader.fileId);
        };

        const clearLoadingState = (fileId: number): void => {
            setMediaByFileId((current) => {
                const entry = current.get(fileId);
                if (entry?.status !== "loading") {
                    return current;
                }
                const next = new Map(current);
                next.delete(fileId);
                return next;
            });
        };

        // Drop in-flight work only for slides that left the preload window.
        for (const [fileId, loader] of [...loadersByFileId.entries()]) {
            if (keepIds.has(fileId)) {
                continue;
            }
            loader.cancelled = true;
            window.clearTimeout(loader.timeoutId);
            loadersByFileId.delete(fileId);
            loadingIds.delete(fileId);
            clearLoadingState(fileId);
        }

        let pumpLoads = (): void => undefined;

        const startNetworkLoad = (slideFile: EnteFile): void => {
            if (
                mediaUrlsRef.current.has(slideFile.id) ||
                loadingIds.has(slideFile.id)
            ) {
                return;
            }

            loadingIds.add(slideFile.id);
            setSlideMedia(slideFile.id, { status: "loading" });
            const loader: SlideLoader = {
                fileId: slideFile.id,
                cancelled: false,
                timedOut: false,
                timeoutId: window.setTimeout(() => {
                    if (loader.cancelled) {
                        return;
                    }
                    loader.timedOut = true;
                    releaseLoader(loader);
                    setSlideMedia(slideFile.id, { status: "error" });
                    pumpLoads();
                }, MEDIA_LOAD_TIMEOUT_MS),
            };
            loadersByFileId.set(slideFile.id, loader);

            const isVideo = slideFile.metadata.fileType === FileType.video;
            const reportDownloadProgress = ({
                loaded,
                total,
            }: {
                loaded: number;
                total: number;
            }): void => {
                if (loader.cancelled || loader.timedOut) {
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
            const loadBytes =
                isVideo ?
                    loadCachedVideoBytes(slideFile, reportDownloadProgress) :
                    getEnteCore().getDecryptedFile(
                        slideFile,
                        reportDownloadProgress,
                    );

            void loadBytes
                .then(async (bytes) => {
                    window.clearTimeout(loader.timeoutId);
                    if (loader.cancelled) {
                        releaseLoader(loader);
                        pumpLoads();
                        return;
                    }
                    setSlideMedia(slideFile.id, {
                        status: "loading",
                        progress: 100,
                        bytesLoaded: bytes.byteLength,
                        bytesTotal: bytes.byteLength,
                    });
                    const blob =
                        isVideo ?
                            new Blob([Uint8Array.from(bytes)], {
                                type: mimeTypeForFile(slideFile),
                            }) :
                            await toRenderableImageBlob(slideFile, bytes);
                    if (loader.cancelled) {
                        releaseLoader(loader);
                        pumpLoads();
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    mediaUrlsRef.current.set(slideFile.id, url);
                    if (isVideo) {
                        mediaByteSizesRef.current.set(slideFile.id, blob.size);
                    }
                    releaseLoader(loader);
                    setSlideMedia(slideFile.id, { status: "ready", url });
                    pumpLoads();
                })
                .catch(() => {
                    window.clearTimeout(loader.timeoutId);
                    releaseLoader(loader);
                    if (!loader.cancelled) {
                        setSlideMedia(slideFile.id, { status: "error" });
                    }
                    pumpLoads();
                });
        };

        pumpLoads = (): void => {
            let inFlight = loadersByFileId.size;
            for (const slideFile of keepFiles) {
                if (inFlight >= MAX_CONCURRENT_MEDIA_LOADS) {
                    break;
                }
                if (
                    mediaUrlsRef.current.has(slideFile.id) ||
                    loadingIds.has(slideFile.id)
                ) {
                    continue;
                }
                if (getLocalMediaOverride(slideFile.id)) {
                    continue;
                }
                startNetworkLoad(slideFile);
                inFlight += 1;
            }
        };

        for (const slideFile of keepFiles) {
            if (slideFile.metadata.fileType === FileType.video) {
                requestThumbnail(slideFile);
            }

            const mediaOverride = getLocalMediaOverride(slideFile.id);
            if (mediaOverride) {
                if (mediaUrlsRef.current.has(slideFile.id)) {
                    continue;
                }
                if (loadingIds.has(slideFile.id)) {
                    continue;
                }
                loadingIds.add(slideFile.id);
                setSlideMedia(slideFile.id, { status: "loading" });
                const overrideLoader: SlideLoader = {
                    fileId: slideFile.id,
                    cancelled: false,
                    timedOut: false,
                    timeoutId: 0,
                };
                loadersByFileId.set(slideFile.id, overrideLoader);
                void (async (): Promise<void> => {
                    try {
                        const blob =
                            slideFile.metadata.fileType === FileType.video ?
                                new Blob([Uint8Array.from(mediaOverride)], {
                                    type: mimeTypeForFile(slideFile),
                                }) :
                                await toRenderableImageBlob(
                                    slideFile,
                                    mediaOverride,
                                );
                        if (overrideLoader.cancelled) {
                            releaseLoader(overrideLoader);
                            pumpLoads();
                            return;
                        }
                        const url = URL.createObjectURL(blob);
                        const previousUrl = mediaUrlsRef.current.get(
                            slideFile.id,
                        );
                        if (previousUrl) {
                            URL.revokeObjectURL(previousUrl);
                        }
                        mediaUrlsRef.current.set(slideFile.id, url);
                        if (slideFile.metadata.fileType === FileType.video) {
                            mediaByteSizesRef.current.set(
                                slideFile.id,
                                blob.size,
                            );
                        }
                        releaseLoader(overrideLoader);
                        setSlideMedia(slideFile.id, { status: "ready", url });
                        pumpLoads();
                    } catch {
                        releaseLoader(overrideLoader);
                        if (!overrideLoader.cancelled) {
                            setSlideMedia(slideFile.id, { status: "error" });
                        }
                        pumpLoads();
                    }
                })();
                continue;
            }

            if (mediaUrlsRef.current.has(slideFile.id)) {
                continue;
            }

            if (slideFile.metadata.fileType === FileType.video) {
                const sessionHit = takeSessionVideoUrl(slideFile.id);
                if (sessionHit) {
                    mediaUrlsRef.current.set(slideFile.id, sessionHit.url);
                    mediaByteSizesRef.current.set(
                        slideFile.id,
                        sessionHit.byteSize,
                    );
                    setSlideMedia(slideFile.id, {
                        status: "ready",
                        url: sessionHit.url,
                    });
                }
            }
        }

        pumpLoads();

        for (const [fileId, url] of [...mediaUrlsRef.current.entries()]) {
            if (keepIds.has(fileId)) {
                continue;
            }
            mediaUrlsRef.current.delete(fileId);
            loadingIds.delete(fileId);
            const leftFile = sessionFiles.find(
                (entry) => entry.id === fileId,
            );
            const knownSize = mediaByteSizesRef.current.get(fileId);
            mediaByteSizesRef.current.delete(fileId);
            if (leftFile?.metadata.fileType === FileType.video) {
                retainSessionVideoUrl(
                    fileId,
                    url,
                    knownSize ?? leftFile.info?.fileSize ?? 0,
                );
            } else {
                URL.revokeObjectURL(url);
            }
            setMediaByFileId((current) => {
                if (!current.has(fileId)) {
                    return current;
                }
                const next = new Map(current);
                next.delete(fileId);
                return next;
            });
        }
    }, [currentIndex, retryKey, sessionFiles, setSlideMedia]);

    useEffect((): (() => void) => {
        const urls = mediaUrlsRef.current;
        const sizes = mediaByteSizesRef.current;
        const loaders = mediaLoadersRef.current;
        const loadingIds = loadingIdsRef.current;
        return (): void => {
            for (const loader of loaders.values()) {
                loader.cancelled = true;
                window.clearTimeout(loader.timeoutId);
            }
            loaders.clear();
            loadingIds.clear();
            for (const [fileId, url] of [...urls.entries()]) {
                const leftFile = sessionFilesRef.current.find(
                    (entry) => entry.id === fileId,
                );
                const knownSize = sizes.get(fileId);
                if (leftFile?.metadata.fileType === FileType.video) {
                    retainSessionVideoUrl(
                        fileId,
                        url,
                        knownSize ?? leftFile.info?.fileSize ?? 0,
                    );
                } else {
                    URL.revokeObjectURL(url);
                }
            }
            urls.clear();
            sizes.clear();
        };
    }, []);

    const goToIndex = useCallback(
        (index: number, animate = false): void => {
            if (index < 0 || index >= sessionFiles.length || index === currentIndex) {
                setCarouselDragPx(0);
                setCarouselAnimating(false);
                return;
            }
            if (animate && viewportWidth > 0) {
                const goingNext = index > currentIndex;
                setCarouselAnimating(true);
                setCarouselDragPx(goingNext ? -viewportWidth : viewportWidth);
                window.setTimeout(() => {
                    setCurrentIndex(index);
                    setCarouselDragPx(0);
                    setCarouselAnimating(false);
                    resetZoom();
                }, CAROUSEL_TRANSITION_MS);
                return;
            }
            setCurrentIndex(index);
            setCarouselDragPx(0);
            setCarouselAnimating(false);
            resetZoom();
        },
        [currentIndex, resetZoom, sessionFiles.length, viewportWidth],
    );

    goToIndexRef.current = goToIndex;

    const goPrev = useCallback((): void => {
        goToIndex(currentIndex - 1, true);
    }, [currentIndex, goToIndex]);

    const goNext = useCallback((): void => {
        goToIndex(currentIndex + 1, true);
    }, [currentIndex, goToIndex]);

    const cancelCarouselDrag = useCallback((): void => {
        const carouselPointerId = carouselPointerIdRef.current;
        carouselPointerIdRef.current = undefined;
        carouselDragStartRef.current = undefined;
        setCarouselDragPx(0);
        setDismissDragPx(0);
        if (carouselPointerId !== undefined && viewportRef.current) {
            try {
                viewportRef.current.releasePointerCapture(carouselPointerId);
            } catch {
                // Pointer may already be released.
            }
        }
    }, []);

    const handleMediaTap = useCallback((): void => {
        window.clearTimeout(chromeTimerRef.current);
        mediaTapCountRef.current += 1;
        window.clearTimeout(mediaTapCountResetRef.current);
        mediaTapCountResetRef.current = window.setTimeout((): void => {
            mediaTapCountRef.current = 0;
        }, DOUBLE_TAP_MS);
        if (chromeVisible) {
            setChromeVisible(false);
            return;
        }
        setChromeVisible(true);
        if (chromePaused) {
            return;
        }
        chromeTimerRef.current = window.setTimeout((): void => {
            setChromeVisible(false);
        }, CHROME_HIDE_MS);
    }, [chromePaused, chromeVisible]);

    const resetChromeTimer = useCallback((): void => {
        window.clearTimeout(chromeTimerRef.current);
        if (chromePaused || !chromeVisible) {
            return;
        }
        chromeTimerRef.current = window.setTimeout((): void => {
            setChromeVisible(false);
        }, CHROME_HIDE_MS);
    }, [chromePaused, chromeVisible]);

    useEffect((): (() => void) => {
        if (chromePaused) {
            window.clearTimeout(chromeTimerRef.current);
            return (): void => undefined;
        }
        if (chromeVisible) {
            resetChromeTimer();
        }
        return (): void => {
            window.clearTimeout(chromeTimerRef.current);
        };
    }, [chromePaused, chromeVisible, resetChromeTimer]);

    // Desktop: hide chrome only after the pointer has been still for CHROME_HIDE_MS.
    useEffect((): (() => void) => {
        if (coarsePointer || chromePaused || !chromeVisible) {
            return (): void => undefined;
        }
        const onPointerMove = (event: PointerEvent): void => {
            if (event.pointerType === "touch") {
                return;
            }
            resetChromeTimer();
        };
        document.addEventListener("pointermove", onPointerMove);
        return (): void => {
            document.removeEventListener("pointermove", onPointerMove);
        };
    }, [chromePaused, chromeVisible, coarsePointer, resetChromeTimer]);

    useEffect((): void => {
        const track = trackRef.current;
        if (track) {
            track.querySelectorAll("video").forEach((video) => {
                if (video !== activeVideoRef.current) {
                    video.pause();
                }
            });
        }
        if (file?.metadata.fileType !== FileType.video) {
            return;
        }
        const slideMedia = mediaByFileId.get(file.id);
        if (slideMedia?.status !== "ready") {
            return;
        }
        const video = activeVideoRef.current;
        if (!video) {
            return;
        }

        if (!videoAutoPlay) {
            video.muted = videoMuted;
            primeVideoFirstFrame(video);
            return;
        }
        void video.play().catch(() => undefined);
    }, [
        currentIndex,
        file?.id,
        file?.metadata.fileType,
        mediaByFileId,
        videoAutoPlay,
        videoMuted,
    ]);

    const handleRetry = useCallback((): void => {
        if (!file) {
            return;
        }
        const activeLoader = mediaLoadersRef.current.get(file.id);
        if (activeLoader) {
            activeLoader.cancelled = true;
            window.clearTimeout(activeLoader.timeoutId);
            mediaLoadersRef.current.delete(file.id);
        }
        const url = mediaUrlsRef.current.get(file.id);
        mediaUrlsRef.current.delete(file.id);
        mediaByteSizesRef.current.delete(file.id);
        invalidateVideoCache(file.id);
        if (url) {
            URL.revokeObjectURL(url);
        }
        loadingIdsRef.current.delete(file.id);
        setSlideMedia(file.id, { status: "idle" });
        setRetryKey((k) => k + 1);
    }, [file, setSlideMedia]);

    /**
     * Blob URL revoked under us (e.g. session LRU) — drop it and reload.
     */
    const handleBrokenSlideMedia = useCallback(
        (fileId: number): void => {
            const activeLoader = mediaLoadersRef.current.get(fileId);
            if (activeLoader) {
                activeLoader.cancelled = true;
                window.clearTimeout(activeLoader.timeoutId);
                mediaLoadersRef.current.delete(fileId);
            }
            const url = mediaUrlsRef.current.get(fileId);
            if (!url) {
                return;
            }
            mediaUrlsRef.current.delete(fileId);
            mediaByteSizesRef.current.delete(fileId);
            loadingIdsRef.current.delete(fileId);
            URL.revokeObjectURL(url);
            setSlideMedia(fileId, { status: "idle" });
            setRetryKey((key) => key + 1);
        },
        [setSlideMedia],
    );

    const finishCarouselDrag = useCallback((mode?: CarouselDragMode): void => {
        if (mode === "dismiss") {
            const threshold = Math.max(
                DISMISS_THRESHOLD_MIN_PX,
                viewportHeight * DISMISS_THRESHOLD_RATIO,
            );
            if (dismissDragPx > threshold) {
                onClose();
                return;
            }
            setCarouselAnimating(true);
            setDismissDragPx(0);
            window.setTimeout(() => {
                setCarouselAnimating(false);
            }, CAROUSEL_TRANSITION_MS);
            return;
        }

        const threshold = Math.max(
            SWIPE_THRESHOLD_MIN_PX,
            viewportWidth * SWIPE_THRESHOLD_RATIO,
        );
        if (carouselDragPx > threshold && currentIndex > 0) {
            goToIndex(currentIndex - 1, true);
            return;
        }
        if (
            carouselDragPx < -threshold &&
            currentIndex < sessionFiles.length - 1
        ) {
            goToIndex(currentIndex + 1, true);
            return;
        }
        setCarouselAnimating(true);
        setCarouselDragPx(0);
        window.setTimeout(() => {
            setCarouselAnimating(false);
        }, CAROUSEL_TRANSITION_MS);
    }, [
        carouselDragPx,
        currentIndex,
        dismissDragPx,
        goToIndex,
        onClose,
        sessionFiles.length,
        viewportHeight,
        viewportWidth,
    ]);

    const handleCarouselPointerDown = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        if (
            cropMode ||
            carouselAnimating ||
            zoomScale > 1.01 ||
            event.pointerType === "mouse" && event.button !== 0
        ) {
            return;
        }
        if (
            carouselPointerIdRef.current !== undefined &&
            carouselPointerIdRef.current !== event.pointerId
        ) {
            cancelCarouselDrag();
            return;
        }
        resetChromeTimer();
        carouselPointerIdRef.current = event.pointerId;
        carouselDragStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            dragPx: carouselDragPx,
            dragging: false,
        };
    };

    const handleCarouselPointerMove = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        if (getPointerCount() >= 2) {
            cancelCarouselDrag();
            return;
        }
        if (
            carouselPointerIdRef.current !== event.pointerId ||
            !carouselDragStartRef.current
        ) {
            return;
        }
        const deltaX = event.clientX - carouselDragStartRef.current.x;
        const deltaY = event.clientY - carouselDragStartRef.current.y;
        if (!carouselDragStartRef.current.dragging) {
            if (
                deltaY > CAROUSEL_DRAG_DEAD_ZONE_PX &&
                deltaY > Math.abs(deltaX)
            ) {
                carouselDragStartRef.current.dragging = true;
                carouselDragStartRef.current.mode = "dismiss";
            } else if (
                Math.abs(deltaX) > CAROUSEL_DRAG_DEAD_ZONE_PX &&
                Math.abs(deltaX) > Math.abs(deltaY)
            ) {
                carouselDragStartRef.current.dragging = true;
                carouselDragStartRef.current.mode = "horizontal";
            } else {
                return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (carouselDragStartRef.current.mode === "dismiss") {
            setDismissDragPx(Math.max(0, deltaY));
            return;
        }
        let nextDrag = carouselDragStartRef.current.dragPx + deltaX;
        if (currentIndex === 0 && nextDrag > 0) {
            nextDrag *= 0.35;
        }
        if (currentIndex >= sessionFiles.length - 1 && nextDrag < 0) {
            nextDrag *= 0.35;
        }
        setCarouselDragPx(nextDrag);
    };

    const handleCarouselPointerUp = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        if (carouselPointerIdRef.current !== event.pointerId) {
            return;
        }
        releasePointer(event.pointerId);
        const start = carouselDragStartRef.current;
        carouselPointerIdRef.current = undefined;
        carouselDragStartRef.current = undefined;
        if (start && !start.dragging) {
            const deltaX = event.clientX - start.x;
            const deltaY = event.clientY - start.y;
            if (
                !skipChromeTapRef.current &&
                Math.hypot(deltaX, deltaY) < TAP_MAX_MOVEMENT_PX
            ) {
                handleMediaTap();
            }
            skipChromeTapRef.current = false;
            return;
        }
        skipChromeTapRef.current = false;
        finishCarouselDrag(start?.mode);
    };

    const handleZoomPointerDown = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        resetChromeTimer();
        const pointerCountBefore = getPointerCount();
        pinchZoom.onPointerDown(event);
        if (getPointerCount() >= 2 && pointerCountBefore < 2) {
            if (pointerCountBefore === 0) {
                const carouselPointerId = carouselPointerIdRef.current;
                const carouselStart = carouselDragStartRef.current;
                if (
                    carouselPointerId !== undefined &&
                    carouselStart &&
                    carouselPointerId !== event.pointerId
                ) {
                    registerPointer(
                        carouselPointerId,
                        carouselStart.x,
                        carouselStart.y,
                    );
                }
            }
            cancelCarouselDrag();
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (zoomScale > 1.01 || getPointerCount() >= 2) {
            zoomPointerStartRef.current = {
                x: event.clientX,
                y: event.clientY,
            };
        }
    };

    const handleZoomPointerUp = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        const start = zoomPointerStartRef.current;
        zoomPointerStartRef.current = undefined;
        pinchZoom.onPointerUp(event);
        if (!start || skipChromeTapRef.current) {
            return;
        }
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        if (Math.hypot(deltaX, deltaY) < TAP_MAX_MOVEMENT_PX) {
            handleMediaTap();
        }
    };

    const handleMediaDoubleTap = (
        clientX: number,
        clientY: number,
    ): void => {
        if (mediaTapCountRef.current === 1) {
            window.clearTimeout(chromeTimerRef.current);
            setChromeVisible((visible) => !visible);
        }
        mediaTapCountRef.current = 0;
        window.clearTimeout(mediaTapCountResetRef.current);
        skipChromeTapRef.current = true;
        const container = viewportRef.current;
        if (container && zoomEnabled) {
            pinchZoom.onDoubleTap(clientX, clientY, container);
        }
    };

    const handleTouchEnd = (event: ReactTouchEvent<HTMLDivElement>): void => {
        if (!zoomEnabled) {
            return;
        }
        const touch = event.changedTouches[0];
        if (!touch) {
            return;
        }
        const now = Date.now();
        const last = lastTouchTapRef.current;
        if (
            last &&
            now - last.time < DOUBLE_TAP_MS &&
            Math.hypot(touch.clientX - last.x, touch.clientY - last.y) <
                DOUBLE_TAP_MAX_DISTANCE_PX
        ) {
            lastTouchTapRef.current = undefined;
            handleMediaDoubleTap(touch.clientX, touch.clientY);
            return;
        }
        lastTouchTapRef.current = {
            time: now,
            x: touch.clientX,
            y: touch.clientY,
        };
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            resetChromeTimer();
            if (event.key === "Escape") {
                if (cropMode) {
                    setCropMode(false);
                    return;
                }
                if (zoomScale > 1.01 && zoomEnabled) {
                    resetZoom();
                    return;
                }
                onClose();
            } else if (!cropMode && event.key === "ArrowLeft") {
                goPrev();
            } else if (!cropMode && event.key === "ArrowRight") {
                goNext();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return (): void => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [cropMode, goNext, goPrev, onClose, resetChromeTimer, resetZoom, zoomEnabled, zoomScale]);

    const syncSessionFile = useCallback(
        (fileId: number): void => {
            const updated = useLibraryStore.getState().getFileById(fileId);
            if (updated) {
                setSessionFiles((current) => current.map((entry) => (
                    entry.id === fileId ? updated : entry
                )));
                notifyFileUpdated(updated);
            }
        },
        [notifyFileUpdated],
    );

    const beginTagDraft = useCallback((): void => {
        const baseline = displayFile ? extractUserTags(displayFile) : [];
        tagBaselineRef.current = [...baseline];
        stagedTagsRef.current = [...baseline];
        setStagedTags([...baseline]);
        setTagError(undefined);
        setShowTagPicker(true);
    }, [displayFile]);

    const flushTagDraft = useCallback((): void => {
        if (!displayFile) {
            stagedTagsRef.current = null;
            setStagedTags(null);
            setShowTagPicker(false);
            return;
        }
        const fileId = displayFile.id;
        const intendedTags =
            stagedTagsRef.current ?? extractUserTags(displayFile);
        setShowTagPicker(false);
        if (tagsEqual(tagBaselineRef.current, intendedTags)) {
            stagedTagsRef.current = null;
            setStagedTags(null);
            return;
        }

        setTagSaveBusy(true);
        setTagError(undefined);
        stagedTagsRef.current = null;
        setStagedTags(null);
        tagBaselineRef.current = intendedTags;

        const mutator = (current: string[]): string[] => [
            ...current.filter((tag) => isSystemTag(tag)),
            ...intendedTags,
        ];
        // Enqueue before yielding so a kill during rAF cannot void the draft.
        enqueueTagOutboxEntries([
            {
                fileId,
                intendedTags: applyTagMutator(mutator, extractTags(displayFile)),
            },
        ]);
        requestTagOutboxFlush();

        // Let the sheet close paint before store + gallery work runs.
        requestAnimationFrame(() => {
            startTransition(() => {
                void updateTagsOnFile(fileId, mutator)
                    .then(() => {
                        syncSessionFile(fileId);
                    })
                    .catch((error: unknown) => {
                        syncSessionFile(fileId);
                        setTagError(
                            error instanceof Error ?
                                error.message :
                                "Could not save tags",
                        );
                    })
                    .finally(() => {
                        setTagSaveBusy(false);
                    });
            });
        });
    }, [displayFile, syncSessionFile, updateTagsOnFile]);

    const handleAddTag = useCallback(
        (name: string): void => {
            const normalized = normalizeTagName(name);
            if (!normalized || isReservedTag(normalized)) {
                return;
            }
            setTagError(undefined);
            setStagedTags((current) => {
                if (!current) {
                    return current;
                }
                const next = addTagNames(current, normalized);
                stagedTagsRef.current = next;
                return next;
            });
        },
        [],
    );

    const handleRemoveTag = useCallback(
        (tag: string): void => {
            setTagError(undefined);
            setStagedTags((current) => {
                if (!current) {
                    return current;
                }
                const next = removeTagNames(current, tag);
                stagedTagsRef.current = next;
                return next;
            });
        },
        [],
    );

    const handleDerivedFileFinalized = useCallback(
        (sourceId: number, uploaded: EnteFile): void => {
            const stillViewingSource =
                sessionFiles[currentIndexRef.current]?.id === sourceId;
            const url = mediaUrlsRef.current.get(sourceId);
            const byteSize = mediaByteSizesRef.current.get(sourceId);
            if (url) {
                mediaUrlsRef.current.delete(sourceId);
                mediaUrlsRef.current.set(uploaded.id, url);
            }
            if (byteSize !== undefined) {
                mediaByteSizesRef.current.delete(sourceId);
                mediaByteSizesRef.current.set(uploaded.id, byteSize);
            }
            transferSessionVideoUrl(sourceId, uploaded.id);
            setSessionFiles((current) => current.map((entry) => (
                entry.id === sourceId ? uploaded : entry
            )));
            setMediaByFileId((current) => {
                const media = current.get(sourceId);
                if (!media) {
                    return current;
                }
                const next = new Map(current);
                next.delete(sourceId);
                next.set(uploaded.id, media);
                return next;
            });
            if (stillViewingSource) {
                notifyFileUpdated(uploaded);
            }
        },
        [notifyFileUpdated, sessionFiles],
    );

    const handleEditSaved = useCallback(
        (result: CropSaveResult | VideoSaveResult): void => {
            if (!file) {
                return;
            }
            const sourceId = file.id;
            const previousUrl = mediaUrlsRef.current.get(sourceId);
            forgetSessionVideoUrl(sourceId);
            if (previousUrl) {
                URL.revokeObjectURL(previousUrl);
            }
            const url = URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                    type: mimeTypeForFile(file),
                }),
            );
            mediaUrlsRef.current.set(sourceId, url);
            if (file.metadata.fileType === FileType.video) {
                mediaByteSizesRef.current.set(sourceId, result.bytes.byteLength);
            }
            setSlideMedia(sourceId, { status: "ready", url });
            setSessionFiles((current) => current.map((entry) => (
                entry.id === sourceId ? result.optimisticFile : entry
            )));
            notifyFileUpdated(result.optimisticFile);
            clearPointers();
            resetZoom();
            setCropMode(false);

            void result.finalize
                .then((uploaded) => {
                    handleDerivedFileFinalized(sourceId, uploaded);
                })
                .catch((error: unknown) => {
                    const reverted = useLibraryStore.getState().allFiles.find(
                        (entry) => entry.id === sourceId,
                    );
                    const stillViewingSource =
                        sessionFiles[currentIndexRef.current]?.id === sourceId;
                    if (reverted) {
                        setSessionFiles((current) => current.map((entry) => (
                            entry.id === sourceId ? reverted : entry
                        )));
                        if (stillViewingSource) {
                            notifyFileUpdated(reverted);
                        }
                    }
                    const staleUrl = mediaUrlsRef.current.get(sourceId);
                    mediaUrlsRef.current.delete(sourceId);
                    mediaByteSizesRef.current.delete(sourceId);
                    forgetSessionVideoUrl(sourceId);
                    if (staleUrl) {
                        URL.revokeObjectURL(staleUrl);
                    }
                    setSlideMedia(sourceId, { status: "loading" });
                    setRetryKey((current) => current + 1);
                    toast.error(
                        error instanceof Error ?
                            error.message :
                            "Could not save edits",
                    );
                });
        },
        [
            clearPointers,
            file,
            handleDerivedFileFinalized,
            notifyFileUpdated,
            resetZoom,
            sessionFiles,
            setSlideMedia,
        ],
    );

    const handleToggleFavorite = (): void => {
        if (!file) {
            return;
        }
        clearPointers();
        setFavoriteBusy(true);
        setFavoriteError(undefined);
        void setFileFavorite(file, !isFavorite)
            .catch((error: unknown) => {
                setFavoriteError(
                    error instanceof Error ?
                        error.message :
                        "Could not update favourite",
                );
            })
            .finally(() => {
                setFavoriteBusy(false);
            });
    };

    const handleToggleArchive = (): void => {
        if (!file) {
            return;
        }
        clearPointers();
        setArchiveBusy(true);
        void setFileArchived(file, !isArchived)
            .catch((error: unknown) => {
                toast.error(
                    error instanceof Error ?
                        error.message :
                        "Could not update archive",
                );
            })
            .finally(() => {
                setArchiveBusy(false);
            });
    };

    const handleRevertLastEdit = (): void => {
        if (!file) {
            return;
        }
        const sourceId = file.id;
        const sourceFile = file;
        const result = revertLastEdit(sourceId);
        if (!result) {
            setShowRevertConfirm(false);
            return;
        }

        clearPointers();
        resetZoom();
        setRevertBusy(true);
        setShowRevertConfirm(false);

        void (async (): Promise<void> => {
            try {
                const previousUrl = mediaUrlsRef.current.get(sourceId);
                if (previousUrl) {
                    URL.revokeObjectURL(previousUrl);
                }
                const blob =
                    sourceFile.metadata.fileType === FileType.video ?
                        new Blob([Uint8Array.from(result.bytes)], {
                            type: mimeTypeForFile(sourceFile),
                        }) :
                        await toRenderableImageBlob(sourceFile, result.bytes);
                const url = URL.createObjectURL(blob);
                mediaUrlsRef.current.set(sourceId, url);
                setSlideMedia(sourceId, { status: "ready", url });
                setSessionFiles((current) => current.map((entry) => (
                    entry.id === sourceId ? result.optimisticFile : entry
                )));
                notifyFileUpdated(result.optimisticFile);

                await result.finalize.then((uploaded) => {
                    handleDerivedFileFinalized(sourceId, uploaded);
                });
            } catch (error: unknown) {
                const reverted = useLibraryStore.getState().allFiles.find(
                    (entry) => entry.id === sourceId,
                );
                if (reverted) {
                    setSessionFiles((current) => current.map((entry) => (
                        entry.id === sourceId ? reverted : entry
                    )));
                    notifyFileUpdated(reverted);
                }
                const staleUrl = mediaUrlsRef.current.get(sourceId);
                if (staleUrl) {
                    URL.revokeObjectURL(staleUrl);
                    mediaUrlsRef.current.delete(sourceId);
                }
                setSlideMedia(sourceId, { status: "loading" });
                setRetryKey((current) => current + 1);
                toast.error(
                    error instanceof Error ?
                        error.message :
                        "Could not revert edit",
                );
            } finally {
                setRevertBusy(false);
            }
        })();
    };

    const handleConfirmDelete = (): void => {
        if (!file) {
            return;
        }
        const deletedId = file.id;
        const deletedIndex = currentIndexRef.current;
        setDeleteBusy(true);
        setDeleteError(undefined);
        void moveFilesToTrash([deletedId])
            .then(() => {
                if (!viewerActiveRef.current) {
                    return;
                }
                setShowDeleteConfirm(false);

                const staleUrl = mediaUrlsRef.current.get(deletedId);
                mediaUrlsRef.current.delete(deletedId);
                mediaByteSizesRef.current.delete(deletedId);
                invalidateVideoCache(deletedId);
                if (staleUrl) {
                    URL.revokeObjectURL(staleUrl);
                }
                setMediaByFileId((current) => {
                    if (!current.has(deletedId)) {
                        return current;
                    }
                    const next = new Map(current);
                    next.delete(deletedId);
                    return next;
                });

                const current = sessionFilesRef.current;
                const deletedAt = current.findIndex(
                    (entry) => entry.id === deletedId,
                );
                const remaining = current.filter(
                    (entry) => entry.id !== deletedId,
                );
                if (remaining.length === 0) {
                    onClose();
                    return;
                }
                const indexBasis =
                    deletedAt >= 0 ? deletedAt : deletedIndex;
                const nextIndex = Math.min(
                    indexBasis > 0 ? indexBasis - 1 : 0,
                    remaining.length - 1,
                );
                const neighbor = remaining[nextIndex];
                if (!neighbor) {
                    onClose();
                    return;
                }
                setSessionFiles(remaining);
                setCurrentIndex(nextIndex);
                viewerFileIdRef.current = neighbor.id;
                notifyFileUpdated(neighbor);
            })
            .catch((error: unknown) => {
                setDeleteError(
                    error instanceof Error ?
                        error.message :
                        "Could not move item to trash",
                );
            })
            .finally(() => {
                setDeleteBusy(false);
            });
    };

    if (!file) {
        return <></>;
    }

    const slideOffsets = [-1, 0, 1] as const;
    const trackTranslatePx =
        viewportWidth > 0 ?
            -viewportWidth + carouselDragPx :
            carouselDragPx;
    const dismissOpacity =
        viewportHeight > 0 ?
            Math.max(0.35, 1 - dismissDragPx / viewportHeight) :
            1;

    const renderSlide = (offset: -1 | 0 | 1): JSX.Element => {
        const slideIndex = currentIndex + offset;
        const slideFile =
            slideIndex >= 0 && slideIndex < sessionFiles.length ?
                sessionFiles[slideIndex] :
                undefined;
        const isActive = offset === 0;
        const slideMedia = slideFile ?
            mediaByFileId.get(slideFile.id) :
            undefined;
        const isVideo =
            slideFile?.metadata.fileType === FileType.video;
        const slideZoomEnabled =
            slideFile ?
                (() => {
                    const kind = mediaKindForFile(slideFile);
                    return kind === "image" || kind === "gif";
                })() :
                false;

        return (
            <div
                key={offset}
                className="relative h-full shrink-0"
                style={
                    viewportWidth > 0 ?
                        { width: viewportWidth } :
                        { width: "100%" }
                }
            >
                {!slideFile ? null : slideMedia?.status === "error" ? (
                    isActive ? (
                        <div className="flex flex-col items-center gap-3 px-6 text-center">
                            <p className="text-sm text-muted-foreground">
                                Could not load this item.
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleRetry}
                            >
                                Retry
                            </Button>
                        </div>
                    ) : null
                ) : slideMedia?.status === "loading" || !slideMedia?.url ? (
                    isVideo && slideFile ? (
                        <VideoSlidePoster file={slideFile}>
                            {isActive ? (
                                <MediaDownloadIndicator
                                    kind="video"
                                    progress={slideMedia?.progress}
                                    bytesLoaded={slideMedia?.bytesLoaded}
                                    bytesTotal={slideMedia?.bytesTotal}
                                />
                            ) : null}
                        </VideoSlidePoster>
                    ) : isActive ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <MediaDownloadIndicator
                                kind="photo"
                                progress={slideMedia?.progress}
                                bytesLoaded={slideMedia?.bytesLoaded}
                                bytesTotal={slideMedia?.bytesTotal}
                            />
                        </div>
                    ) : null
                ) : isVideo ? (
                    <div className="absolute inset-0">
                        <VideoSlidePoster file={slideFile!} />
                        <video
                            ref={isActive ? activeVideoRef : undefined}
                            className="pointer-events-none absolute inset-0 size-full object-contain select-none [-webkit-touch-callout:none]"
                            src={slideMedia.url}
                            loop={videoLoop}
                            playsInline
                            preload={videoAutoPlay ? "metadata" : "auto"}
                            poster={
                                isActive && activeVideoThumb.url ?
                                    activeVideoThumb.url :
                                    undefined
                            }
                            onError={() => {
                                if (slideFile) {
                                    handleBrokenSlideMedia(slideFile.id);
                                }
                            }}
                        />
                    </div>
                ) : (
                    <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={
                            isActive && slideZoomEnabled ?
                                pinchZoom.transformStyle :
                                undefined
                        }
                        onPointerDown={
                            isActive && slideZoomEnabled ?
                                handleZoomPointerDown :
                                undefined
                        }
                        onPointerMove={
                            isActive && slideZoomEnabled ?
                                pinchZoom.onPointerMove :
                                undefined
                        }
                        onPointerUp={
                            isActive && slideZoomEnabled ?
                                handleZoomPointerUp :
                                undefined
                        }
                        onPointerCancel={
                            isActive && slideZoomEnabled ?
                                handleZoomPointerUp :
                                undefined
                        }
                        onWheel={
                            isActive && slideZoomEnabled && zoomScale > 1.01 ?
                                pinchZoom.onWheel :
                                undefined
                        }
                    >
                        <img
                            ref={isActive ? activeImageRef : undefined}
                            className="block size-full object-contain select-none [-webkit-touch-callout:none]"
                            src={slideMedia.url}
                            alt=""
                            draggable={false}
                            onError={() => {
                                if (slideFile) {
                                    handleBrokenSlideMedia(slideFile.id);
                                }
                            }}
                            onLoad={() => {
                                if (
                                    isActive &&
                                    viewportRef.current &&
                                    activeImageRef.current
                                ) {
                                    pinchLayoutRef.current = {
                                        container: viewportRef.current,
                                        image: activeImageRef.current,
                                    };
                                    updatePanBounds(
                                        viewportRef.current,
                                        activeImageRef.current,
                                    );
                                }
                            }}
                        />
                    </div>
                )}
            </div>
        );
    };

    return (
        <div
            className="fixed inset-0 z-50 flex select-none flex-col bg-background overscroll-none [-webkit-touch-callout:none]"
            role="dialog"
            aria-modal="true"
            aria-label="Media viewer"
        >
            <div
                className={cn(
                    "absolute inset-x-0 top-0 z-10 border-b border-border bg-background transition-transform duration-200",
                    chromeVisible && !cropMode ?
                        "translate-y-0" :
                        "-translate-y-full pointer-events-none",
                )}
            >
                <div className="flex items-center justify-between gap-2 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                            resetChromeTimer();
                            onClose();
                        }}
                        aria-label="Close"
                    >
                        <X />
                    </Button>
                    <span className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
                        {currentIndex + 1} / {sessionFiles.length}
                    </span>
                    {showSetRelative && file ? (
                        <Button
                            type="button"
                            variant={
                                file.id === relativeStartFileId ?
                                    "secondary" :
                                    "outline"
                            }
                            size="sm"
                            className="h-8 shrink-0 px-2 text-xs"
                            onClick={() => {
                                resetChromeTimer();
                                setRelativeStartFileId(file.id);
                            }}
                            aria-pressed={file.id === relativeStartFileId}
                        >
                            Set Relative
                        </Button>
                    ) : null}
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                resetChromeTimer();
                                goPrev();
                            }}
                            disabled={currentIndex === 0 || carouselAnimating}
                            aria-label="Previous"
                        >
                            <ChevronLeft />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                resetChromeTimer();
                                goNext();
                            }}
                            disabled={
                                currentIndex >= sessionFiles.length - 1 ||
                            carouselAnimating
                            }
                            aria-label="Next"
                        >
                            <ChevronRight />
                        </Button>
                        <Button
                            type="button"
                            variant={isFavorite ? "secondary" : "ghost"}
                            size="icon-sm"
                            onClick={() => {
                                resetChromeTimer();
                                handleToggleFavorite();
                            }}
                            disabled={favoriteBusy || favoritePending}
                            aria-label={
                                isFavorite ?
                                    "Remove from favourites" :
                                    "Add to favourites"
                            }
                            aria-pressed={isFavorite}
                        >
                            <Heart className={cn(isFavorite && "fill-current")} />
                        </Button>
                        {canRevertEdit ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                    resetChromeTimer();
                                    setShowRevertConfirm(true);
                                }}
                                disabled={revertBusy}
                                aria-label="Revert last edit"
                            >
                                <Undo2 />
                            </Button>
                        ) : null}
                        {onSetAlbumCover ? (
                            <Button
                                type="button"
                                variant={
                                    file.id === albumCoverFileId ?
                                        "secondary" :
                                        "ghost"
                                }
                                size="icon-sm"
                                onClick={() => {
                                    resetChromeTimer();
                                    onSetAlbumCover(file.id);
                                }}
                                aria-label="Set as album cover"
                                aria-pressed={file.id === albumCoverFileId}
                            >
                                <Image />
                            </Button>
                        ) : null}
                        {(canCrop(file) || canCropVideo(file)) ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                    resetChromeTimer();
                                    setCropMode(true);
                                }}
                                disabled={
                                    cropMode ||
                                    activeSlideMedia?.status !== "ready"
                                }
                                aria-label={isVideo ? "Edit video" : "Crop image"}
                            >
                                <Crop />
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                resetChromeTimer();
                                setShowDeleteConfirm(true);
                            }}
                            aria-label="Delete"
                        >
                            <Trash2 />
                        </Button>
                        <DropdownMenu
                            onOpenChange={() => {
                                resetChromeTimer();
                            }}
                        >
                            <DropdownMenuTrigger
                                render={
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label="More actions"
                                    />
                                }
                            >
                                <MoreVertical />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuGroup>
                                    <DropdownMenuItem
                                        disabled={archiveBusy}
                                        onClick={() => {
                                            resetChromeTimer();
                                            handleToggleArchive();
                                        }}
                                    >
                                        {isArchived ?
                                            <ArchiveRestore data-icon="inline-start" /> :
                                            <Archive data-icon="inline-start" />}
                                        {isArchived ? "Unarchive" : "Archive"}
                                    </DropdownMenuItem>
                                </DropdownMenuGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </div>

            <div className="relative min-h-0 flex-1 bg-black/40">
                <div
                    ref={viewportRef}
                    className="absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top,0px)] touch-none overflow-hidden"
                    onPointerDown={handleCarouselPointerDown}
                    onPointerMove={handleCarouselPointerMove}
                    onPointerUp={handleCarouselPointerUp}
                    onPointerCancel={handleCarouselPointerUp}
                    onDoubleClick={(event) => {
                        resetChromeTimer();
                        handleMediaDoubleTap(event.clientX, event.clientY);
                    }}
                    onTouchEnd={handleTouchEnd}
                >
                    <div
                        ref={trackRef}
                        className="flex h-full min-h-0 items-stretch"
                        style={{
                            transform: `translate3d(${trackTranslatePx}px, ${dismissDragPx}px, 0)`,
                            opacity: dismissDragPx > 0 ? dismissOpacity : 1,
                            transition:
                                carouselAnimating ?
                                    `transform ${CAROUSEL_TRANSITION_MS}ms ease-out, opacity ${CAROUSEL_TRANSITION_MS}ms ease-out` :
                                    undefined,
                        }}
                    >
                        {slideOffsets.map((offset) => renderSlide(offset))}
                    </div>
                </div>
            </div>

            <div
                className={cn(
                    "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-background px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-transform duration-200",
                    isVideo && "rounded-t-xl shadow-lg",
                    chromeVisible && !cropMode ?
                        "translate-y-0" :
                        "translate-y-full pointer-events-none",
                )}
            >
                {isVideo ? (
                    <VideoPlaybackControls
                        key={
                            file && activeSlideMedia?.url ?
                                `${file.id}:${activeSlideMedia.url}` :
                                "idle"
                        }
                        videoRef={activeVideoRef}
                        attachKey={
                            file && activeSlideMedia?.status === "ready" ?
                                `${file.id}:${activeSlideMedia.url}` :
                                undefined
                        }
                        visible={chromeVisible && !cropMode}
                        onScrubbingChange={setVideoScrubbing}
                    />
                ) : null}
                <div className="flex h-8 shrink-0 items-center gap-1.5">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={tagSaveBusy}
                        onClick={() => {
                            resetChromeTimer();
                            beginTagDraft();
                        }}
                    >
                        {tagSaveBusy ? <Spinner /> : <Tag />}
                        Tags
                    </Button>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain">
                        {displayTags.length === 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                                No tags
                            </span>
                        ) : (
                            displayTags.map((tag) => (
                                <Badge
                                    key={tag}
                                    variant="secondary"
                                    className="max-w-[12rem] shrink-0"
                                >
                                    <span className="truncate">{tag}</span>
                                </Badge>
                            ))
                        )}
                    </div>
                </div>
                {tagSaveBusy && !showTagPicker ? (
                    <p className="text-xs text-muted-foreground">
                        Saving tags…
                    </p>
                ) : null}
                {tagError && !showTagPicker ? (
                    <Alert variant="destructive" className="py-2">
                        <AlertDescription>{tagError}</AlertDescription>
                    </Alert>
                ) : null}
                {favoriteError ? (
                    <Alert variant="destructive" className="py-2">
                        <AlertDescription>{favoriteError}</AlertDescription>
                    </Alert>
                ) : null}
                {deleteError ? (
                    <Alert variant="destructive" className="py-2">
                        <AlertDescription>{deleteError}</AlertDescription>
                    </Alert>
                ) : null}
            </div>

            <TagPickerSheet
                open={showTagPicker}
                appliedTags={displayTags}
                knownTags={knownTags}
                error={tagError}
                batchSelectionHint="Tap tags to stage changes. Closing saves."
                onOpenChange={(open) => {
                    if (open) {
                        beginTagDraft();
                        return;
                    }
                    void flushTagDraft();
                }}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
            />
            {cropMode && file && isVideo ? (
                <VideoEditorOverlay
                    file={file}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleEditSaved}
                />
            ) : null}
            {cropMode && file && !isVideo ? (
                <CropEditorOverlay
                    file={file}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleEditSaved}
                />
            ) : null}
            <ConfirmDeleteModal
                open={showDeleteConfirm}
                isWorking={deleteBusy}
                onCancel={() => {
                    if (!deleteBusy) {
                        setShowDeleteConfirm(false);
                    }
                }}
                onConfirm={handleConfirmDelete}
            />
            <ConfirmRevertEditModal
                open={showRevertConfirm}
                isWorking={revertBusy}
                onCancel={() => {
                    if (!revertBusy) {
                        setShowRevertConfirm(false);
                    }
                }}
                onConfirm={handleRevertLastEdit}
            />
        </div>
    );
}
