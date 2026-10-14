import {
    startTransition,
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    memo,
    type ComponentProps,
    type JSX,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
    type RefObject,
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
    type MediaKind,
} from "@/lib/media-kind";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { toRenderableImageBlob } from "@/lib/renderable-image";
import { cn } from "@/lib/utils";
import { filePixelSize } from "@/lib/file-aspect-ratio";
import { deviceViewerSize } from "@/lib/viewport-fit";
import { VIEW_SESSION_QUALIFY_MS } from "@/lib/view-sessions";
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
import { useViewSessionsStore } from "@/stores/view-sessions-store";
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
    /** Preferred when the file list may contain duplicate ids (e.g. Recents). */
    initialIndex?: number;
    initialFileId?: number;
    onClose: () => void;
    onFileUpdated?: (file: EnteFile) => void;
    albumCoverFileId?: number;
    onSetAlbumCover?: (fileId: number) => void;
    /** Hide mutation chrome (tags, crop, delete, favourite, …). */
    readOnly?: boolean;
}

const resolveViewerStartIndex = (
    files: EnteFile[],
    initialIndex: number | undefined,
    initialFileId: number | undefined,
): number => {
    if (
        initialIndex !== undefined &&
        initialIndex >= 0 &&
        initialIndex < files.length
    ) {
        return initialIndex;
    }
    if (initialFileId !== undefined) {
        const index = files.findIndex((entry) => entry.id === initialFileId);
        return index >= 0 ? index : 0;
    }
    return 0;
};

type SlideStatus = "idle" | "loading" | "ready" | "error";

interface SlideLoader {
    fileId: number;
    cancelled: boolean;
    timeoutId: number;
    /** Cancels the download; absent for loads that cannot be aborted. */
    abortController?: AbortController;
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
    media,
}: {
    kind: "video" | "photo";
    media?: SlideMedia;
}): JSX.Element {
    const { progress, bytesLoaded, bytesTotal } = media ?? {};
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
const TAP_MAX_MOVEMENT_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
/** Window in which a synthesized dblclick after a touch double-tap is ignored. */
const TOUCH_DOUBLE_TAP_DEDUPE_MS = 500;
const DISMISS_THRESHOLD_MIN_PX = 80;
const DISMISS_THRESHOLD_RATIO = 0.15;

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
 * Cancel a slide load. Abortable loads keep counting toward the concurrency
 * cap in {@link unsettledLoaders} until their promise settles; others stop
 * counting immediately since their network work cannot be stopped.
 */
const cancelLoader = (
    loader: SlideLoader,
    unsettledLoaders: Set<SlideLoader>,
): void => {
    loader.cancelled = true;
    window.clearTimeout(loader.timeoutId);
    if (loader.abortController) {
        loader.abortController.abort();
    } else {
        unsettledLoaders.delete(loader);
    }
};

/**
 * Detach a video's source so Safari frees its decoder buffers.
 */
const releaseVideoElement = (video: HTMLVideoElement): void => {
    video.pause();
    video.removeAttribute("src");
    video.load();
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

const errorMessage = (error: unknown, fallback: string): string =>
    error instanceof Error ? error.message : fallback;

const isZoomableKind = (kind: MediaKind | null): boolean =>
    kind === "image" || kind === "gif" || kind === "video";

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

/** Cached gallery thumbnail for {@link fileId}; idle when `undefined`. */
const useThumbnailEntry = (
    fileId: number | undefined,
): ReturnType<typeof getThumbnailEntry> =>
    useSyncExternalStore(
        useCallback(
            (listener: () => void): (() => void) =>
                fileId === undefined ?
                    (): void => {} :
                    subscribeThumbnail(fileId, listener),
            [fileId],
        ),
        () => getThumbnailEntry(fileId ?? 0),
        () => getThumbnailEntry(0),
    );

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
    const thumb = useThumbnailEntry(file.id);

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
 * Slide `<video>` that releases its decoder buffers when it unmounts.
 *
 * @param activeVideoRef set only on the visible slide; tracks its element.
 */
function SlideVideo({
    activeVideoRef,
    ...videoProps
}: ComponentProps<"video"> & {
    activeVideoRef?: RefObject<HTMLVideoElement | null>;
}): JSX.Element {
    const elementRef = useRef<HTMLVideoElement | null>(null);
    const setElement = useCallback(
        (video: HTMLVideoElement | null): void => {
            elementRef.current = video;
            if (activeVideoRef) {
                activeVideoRef.current = video;
            }
        },
        [activeVideoRef],
    );

    useEffect((): (() => void) => {
        const video = elementRef.current;
        return (): void => {
            // Still connected means a dev-mode effect replay, not a real unmount.
            if (video && !video.isConnected) {
                releaseVideoElement(video);
            }
        };
    }, []);

    return <video ref={setElement} {...videoProps} />;
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

const isTextEntryTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

export const PhotoViewer = memo(function PhotoViewer({
    files,
    initialIndex,
    initialFileId,
    onClose,
    onFileUpdated,
    albumCoverFileId,
    onSetAlbumCover,
    readOnly = false,
}: PhotoViewerProps): JSX.Element {
    const [sessionFiles, setSessionFiles] = useState<EnteFile[]>(files);
    const [currentIndex, setCurrentIndex] = useState<number>(() =>
        resolveViewerStartIndex(sessionFiles, initialIndex, initialFileId));
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
    const [deviceViewportLabel, setDeviceViewportLabel] = useState<string>("");
    const [chromeVisible, setChromeVisible] = useState<boolean>(true);
    const [videoScrubbing, setVideoScrubbing] = useState<boolean>(false);
    const coarsePointer = useCoarsePointer();

    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const activeImageRef = useRef<HTMLImageElement>(null);
    const activeVideoRef = useRef<HTMLVideoElement>(null);
    const pinchLayoutRef = useRef<
        { container: HTMLElement; image: HTMLImageElement | HTMLVideoElement } | null
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
    const lastTouchDoubleTapAtRef = useRef<number>(0);
    /** Pending slide change after a swipe animation; cleared on re-entry and unmount. */
    const carouselTransitionTimerRef = useRef<number | undefined>(undefined);
    const zoomPointerStartRef = useRef<
        { x: number; y: number } | undefined
    >(undefined);
    const mediaUrlsRef = useRef<Map<number, string>>(new Map());
    const mediaByteSizesRef = useRef<Map<number, number>>(new Map());
    const loadingIdsRef = useRef<Set<number>>(new Set());
    const mediaLoadersRef = useRef<Map<number, SlideLoader>>(new Map());
    /** Loads whose promise has not settled, including aborted ones; bounds concurrency. */
    const unsettledLoadersRef = useRef<Set<SlideLoader>>(new Set());
    /** Slides whose load failed; not retried until the user asks or they leave the window. */
    const failedIdsRef = useRef<Set<number>>(new Set());
    /** Slides already reloaded once after a media element error. */
    const brokenReloadIdsRef = useRef<Set<number>>(new Set());
    /** Load pump for the current window; a no-op after unmount. */
    const pumpLoadsRef = useRef<() => void>(() => undefined);
    const viewerFileIdRef = useRef<number>(
        sessionFiles[resolveViewerStartIndex(sessionFiles, initialIndex, initialFileId)]
            ?.id ?? initialFileId ?? 0,
    );
    /** Last `initialIndex` prop applied, so local edits to `sessionFiles` do not move the viewer. */
    const appliedInitialIndexRef = useRef<number | undefined>(initialIndex);
    const currentIndexRef = useRef<number>(currentIndex);
    const sessionFilesRef = useRef<EnteFile[]>(sessionFiles);
    const tagBaselineRef = useRef<string[]>([]);
    /** File the open tag draft belongs to; flush writes to it, not the current slide. */
    const tagDraftFileRef = useRef<EnteFile | undefined>(undefined);
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
    const imagePixelSize = file ? filePixelSize(file) : undefined;
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
        !readOnly &&
        relativeSort !== "none" &&
        file !== undefined &&
        !isEnteVideoFile(file) &&
        hasClipEmbedding;
    const zoomEnabled = isZoomableKind(mediaKind);
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
    const activeVideoThumb = useThumbnailEntry(isVideo ? file?.id : undefined);
    const tags = displayFile ? extractUserTags(displayFile) : [];
    const displayTags = stagedTags ?? tags;
    const activeSlideMedia = file ? mediaByFileId.get(file.id) : undefined;

    // Record qualifying full-screen views for Recents (including replays of a
    // past session, which count toward the current session).
    useEffect((): (() => void) | void => {
        if (cropMode || !file) {
            return;
        }
        if (activeSlideMedia?.status !== "ready") {
            return;
        }
        const fileId = file.id;
        const timer = window.setTimeout(() => {
            if (
                !viewerActiveRef.current ||
                sessionFilesRef.current[currentIndexRef.current]?.id !== fileId
            ) {
                return;
            }
            useViewSessionsStore.getState().beginView(fileId);
        }, VIEW_SESSION_QUALIFY_MS);
        return (): void => {
            window.clearTimeout(timer);
            useViewSessionsStore.getState().endView(fileId);
        };
    }, [activeSlideMedia?.status, cropMode, file]);

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
        if (initialIndex !== undefined) {
            if (initialIndex === appliedInitialIndexRef.current) {
                return;
            }
            appliedInitialIndexRef.current = initialIndex;
            if (initialIndex >= 0 && initialIndex < sessionFiles.length) {
                setCurrentIndex(initialIndex);
                const nextFile = sessionFiles[initialIndex];
                if (nextFile) {
                    viewerFileIdRef.current = nextFile.id;
                }
            }
            return;
        }
        if (initialFileId === undefined) {
            return;
        }
        if (initialFileId === viewerFileIdRef.current) {
            return;
        }
        viewerFileIdRef.current = initialFileId;
        const index = sessionFiles.findIndex((entry) => entry.id === initialFileId);
        if (index >= 0) {
            setCurrentIndex(index);
        }
    }, [initialFileId, initialIndex, sessionFiles]);

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

    useEffect(() => {
        const updateDeviceSize = (): void => {
            const size = deviceViewerSize();
            setDeviceViewportLabel(`${size.width}×${size.height}`);
        };
        updateDeviceSize();
        window.addEventListener("resize", updateDeviceSize);
        window.visualViewport?.addEventListener("resize", updateDeviceSize);
        return (): void => {
            window.removeEventListener("resize", updateDeviceSize);
            window.visualViewport?.removeEventListener(
                "resize",
                updateDeviceSize,
            );
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
        const media = activeImageRef.current ?? activeVideoRef.current;
        if (!viewport || !media || zoomScale <= 1.01) {
            return;
        }
        updatePanBounds(viewport, media);
        pinchLayoutRef.current = { container: viewport, image: media };
    }, [updatePanBounds, zoomScale, file?.id, viewportWidth, mediaKind]);

    useEffect(() => {
        const loadingIds = loadingIdsRef.current;
        const loadersByFileId = mediaLoadersRef.current;
        const unsettledLoaders = unsettledLoadersRef.current;
        const failedIds = failedIdsRef.current;
        const keepFiles = preloadSlideIndices(currentIndex, sessionFiles).map(
            (index) => sessionFiles[index],
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
            cancelLoader(loader, unsettledLoaders);
            loadersByFileId.delete(fileId);
            loadingIds.delete(fileId);
            clearLoadingState(fileId);
        }
        for (const fileId of [...failedIds]) {
            if (!keepIds.has(fileId)) {
                failedIds.delete(fileId);
            }
        }

        const startNetworkLoad = (slideFile: EnteFile): void => {
            if (
                mediaUrlsRef.current.has(slideFile.id) ||
                loadingIds.has(slideFile.id)
            ) {
                return;
            }

            loadingIds.add(slideFile.id);
            setSlideMedia(slideFile.id, { status: "loading" });
            const isVideo = slideFile.metadata.fileType === FileType.video;
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
                    cancelLoader(loader, unsettledLoaders);
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
                    sessionFilesRef.current[currentIndexRef.current]?.id !==
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
            const loadBytes =
                isVideo ?
                    loadCachedVideoBytes(
                        slideFile,
                        reportDownloadProgress,
                        loader.abortController?.signal,
                    ) :
                    getEnteCore().getDecryptedFile(
                        slideFile,
                        reportDownloadProgress,
                        loader.abortController?.signal,
                    );

            void loadBytes
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
                    const blob =
                        isVideo ?
                            blobFromUint8Array(
                                bytes,
                                mimeTypeForFile(slideFile),
                            ) :
                            await toRenderableImageBlob(slideFile, bytes);
                    if (loader.cancelled) {
                        releaseLoader(loader);
                        pumpLoadsRef.current();
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    mediaUrlsRef.current.set(slideFile.id, url);
                    if (isVideo) {
                        mediaByteSizesRef.current.set(slideFile.id, blob.size);
                    }
                    releaseLoader(loader);
                    setSlideMedia(slideFile.id, { status: "ready", url });
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
                    mediaUrlsRef.current.has(slideFile.id) ||
                    loadingIds.has(slideFile.id) ||
                    failedIds.has(slideFile.id)
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
            const isVideoSlide = slideFile.metadata.fileType === FileType.video;
            if (isVideoSlide) {
                requestThumbnail(slideFile);
            }

            const mediaOverride = getLocalMediaOverride(slideFile.id);
            if (mediaOverride) {
                if (
                    mediaUrlsRef.current.has(slideFile.id) ||
                    loadingIds.has(slideFile.id)
                ) {
                    continue;
                }
                loadingIds.add(slideFile.id);
                setSlideMedia(slideFile.id, { status: "loading" });
                const overrideLoader: SlideLoader = {
                    fileId: slideFile.id,
                    cancelled: false,
                    timeoutId: 0,
                };
                loadersByFileId.set(slideFile.id, overrideLoader);
                unsettledLoaders.add(overrideLoader);
                void (async (): Promise<void> => {
                    try {
                        const blob =
                            isVideoSlide ?
                                blobFromUint8Array(
                                    mediaOverride,
                                    mimeTypeForFile(slideFile),
                                ) :
                                await toRenderableImageBlob(
                                    slideFile,
                                    mediaOverride,
                                );
                        if (overrideLoader.cancelled) {
                            releaseLoader(overrideLoader);
                            pumpLoadsRef.current();
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
                        if (isVideoSlide) {
                            mediaByteSizesRef.current.set(
                                slideFile.id,
                                blob.size,
                            );
                        }
                        releaseLoader(overrideLoader);
                        setSlideMedia(slideFile.id, { status: "ready", url });
                        pumpLoadsRef.current();
                    } catch {
                        releaseLoader(overrideLoader);
                        if (!overrideLoader.cancelled) {
                            setSlideMedia(slideFile.id, { status: "error" });
                        }
                        pumpLoadsRef.current();
                    }
                })();
                continue;
            }

            if (mediaUrlsRef.current.has(slideFile.id)) {
                continue;
            }

            if (isVideoSlide) {
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

        pumpLoadsRef.current();

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
            retainOrRevokeMediaUrl(leftFile, fileId, url, knownSize);
            setMediaByFileId((current) => withoutSlideMedia(current, fileId));
        }
    }, [currentIndex, retryKey, sessionFiles, setSlideMedia]);

    useEffect((): (() => void) => {
        const urls = mediaUrlsRef.current;
        const sizes = mediaByteSizesRef.current;
        const loaders = mediaLoadersRef.current;
        const unsettledLoaders = unsettledLoadersRef.current;
        const loadingIds = loadingIdsRef.current;
        const pumpLoads = pumpLoadsRef;
        return (): void => {
            // Cancelled loads settle after unmount; they must not start new ones.
            pumpLoads.current = (): void => undefined;
            window.clearTimeout(carouselTransitionTimerRef.current);
            for (const loader of loaders.values()) {
                cancelLoader(loader, unsettledLoaders);
            }
            loaders.clear();
            loadingIds.clear();
            for (const [fileId, url] of [...urls.entries()]) {
                const leftFile = sessionFilesRef.current.find(
                    (entry) => entry.id === fileId,
                );
                retainOrRevokeMediaUrl(
                    leftFile,
                    fileId,
                    url,
                    sizes.get(fileId),
                );
            }
            urls.clear();
            sizes.clear();
        };
    }, []);

    const goToIndex = useCallback(
        (index: number, animate = false): void => {
            window.clearTimeout(carouselTransitionTimerRef.current);
            if (index < 0 || index >= sessionFiles.length || index === currentIndex) {
                setCarouselDragPx(0);
                setCarouselAnimating(false);
                return;
            }
            if (animate && viewportWidth > 0) {
                const goingNext = index > currentIndex;
                setCarouselAnimating(true);
                setCarouselDragPx(goingNext ? -viewportWidth : viewportWidth);
                carouselTransitionTimerRef.current = window.setTimeout(() => {
                    // Files can shrink while the slide animates (delete / trash).
                    const lastIndex = sessionFilesRef.current.length - 1;
                    setCurrentIndex(Math.max(0, Math.min(index, lastIndex)));
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
        if (!isVideo || !activeSlideMedia?.url) {
            return;
        }
        const video = activeVideoRef.current;
        if (!video) {
            return;
        }

        // Muted/volume are applied by their own effect. Depending on the active
        // slide only keeps neighbour preload progress from re-priming (seek to 0)
        // or resuming a video the user is watching or paused.
        if (!videoAutoPlay) {
            primeVideoFirstFrame(video);
            return;
        }
        void video.play().catch(() => undefined);
    }, [currentIndex, isVideo, activeSlideMedia?.url, videoAutoPlay]);

    const cancelSlideLoader = useCallback((fileId: number): void => {
        const activeLoader = mediaLoadersRef.current.get(fileId);
        if (activeLoader) {
            cancelLoader(activeLoader, unsettledLoadersRef.current);
            mediaLoadersRef.current.delete(fileId);
        }
    }, []);

    /** Forget and revoke a slide's blob URL; returns whether one was held. */
    const discardSlideUrl = useCallback((fileId: number): boolean => {
        const url = mediaUrlsRef.current.get(fileId);
        mediaUrlsRef.current.delete(fileId);
        mediaByteSizesRef.current.delete(fileId);
        if (!url) {
            return false;
        }
        URL.revokeObjectURL(url);
        return true;
    }, []);

    const handleRetry = useCallback((): void => {
        if (!file) {
            return;
        }
        cancelSlideLoader(file.id);
        invalidateVideoCache(file.id);
        discardSlideUrl(file.id);
        loadingIdsRef.current.delete(file.id);
        failedIdsRef.current.delete(file.id);
        brokenReloadIdsRef.current.delete(file.id);
        setSlideMedia(file.id, { status: "idle" });
        setRetryKey((k) => k + 1);
    }, [cancelSlideLoader, discardSlideUrl, file, setSlideMedia]);

    /**
     * Blob URL revoked under us (e.g. session LRU) — drop it and reload.
     */
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

    /** A cancelled touch is not a tap: only drop the pointer and drag state. */
    const handleCarouselPointerCancel = (
        event: ReactPointerEvent<HTMLDivElement>,
    ): void => {
        if (carouselPointerIdRef.current !== event.pointerId) {
            return;
        }
        releasePointer(event.pointerId);
        cancelCarouselDrag();
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
        const skipChrome = skipChromeTapRef.current;
        skipChromeTapRef.current = false;
        if (!start || skipChrome) {
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
            lastTouchDoubleTapAtRef.current = now;
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
            // Open sheets/dialogs, the crop/video editor (which guards Escape
            // while saving) and text fields own their keys: an arrow in the tag
            // search must not change slides mid-draft.
            if (
                event.defaultPrevented ||
                cropMode ||
                showTagPicker ||
                showDeleteConfirm ||
                showRevertConfirm ||
                isTextEntryTarget(event.target)
            ) {
                return;
            }
            resetChromeTimer();
            if (event.key === "Escape") {
                if (zoomScale > 1.01 && zoomEnabled) {
                    resetZoom();
                    return;
                }
                onClose();
            } else if (event.key === "ArrowLeft") {
                goPrev();
            } else if (event.key === "ArrowRight") {
                goNext();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return (): void => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [
        cropMode,
        goNext,
        goPrev,
        onClose,
        resetChromeTimer,
        resetZoom,
        showDeleteConfirm,
        showRevertConfirm,
        showTagPicker,
        zoomEnabled,
        zoomScale,
    ]);

    const replaceSessionFile = useCallback(
        (fileId: number, replacement: EnteFile): void => {
            setSessionFiles((current) => current.map((entry) => (
                entry.id === fileId ? replacement : entry
            )));
        },
        [],
    );

    const syncSessionFile = useCallback(
        (fileId: number): void => {
            const updated = useLibraryStore.getState().getFileById(fileId);
            if (updated) {
                replaceSessionFile(fileId, updated);
                notifyFileUpdated(updated);
            }
        },
        [notifyFileUpdated, replaceSessionFile],
    );

    const beginTagDraft = useCallback((): void => {
        const baseline = displayFile ? extractUserTags(displayFile) : [];
        tagDraftFileRef.current = displayFile;
        tagBaselineRef.current = [...baseline];
        stagedTagsRef.current = [...baseline];
        setStagedTags([...baseline]);
        setTagError(undefined);
        setShowTagPicker(true);
    }, [displayFile]);

    const flushTagDraft = useCallback((): void => {
        const draftFile = tagDraftFileRef.current;
        tagDraftFileRef.current = undefined;
        if (!draftFile) {
            stagedTagsRef.current = null;
            setStagedTags(null);
            setShowTagPicker(false);
            return;
        }
        const fileId = draftFile.id;
        const latestFile =
            useLibraryStore.getState().getFileById(fileId) ?? draftFile;
        const intendedTags =
            stagedTagsRef.current ?? extractUserTags(latestFile);
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
                intendedTags: applyTagMutator(mutator, extractTags(latestFile)),
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
                        setTagError(errorMessage(error, "Could not save tags"));
                    })
                    .finally(() => {
                        setTagSaveBusy(false);
                    });
            });
        });
    }, [syncSessionFile, updateTagsOnFile]);

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
            replaceSessionFile(sourceId, uploaded);
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
        [notifyFileUpdated, replaceSessionFile, sessionFiles],
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
            replaceSessionFile(sourceId, result.optimisticFile);
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
                        replaceSessionFile(sourceId, reverted);
                        if (stillViewingSource) {
                            notifyFileUpdated(reverted);
                        }
                    }
                    discardSlideUrl(sourceId);
                    forgetSessionVideoUrl(sourceId);
                    setSlideMedia(sourceId, { status: "loading" });
                    setRetryKey((current) => current + 1);
                    toast.error(errorMessage(error, "Could not save edits"));
                });
        },
        [
            clearPointers,
            discardSlideUrl,
            file,
            handleDerivedFileFinalized,
            notifyFileUpdated,
            replaceSessionFile,
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
                    errorMessage(error, "Could not update favourite"),
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
                toast.error(errorMessage(error, "Could not update archive"));
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
                const blob =
                    sourceFile.metadata.fileType === FileType.video ?
                        new Blob([Uint8Array.from(result.bytes)], {
                            type: mimeTypeForFile(sourceFile),
                        }) :
                        await toRenderableImageBlob(sourceFile, result.bytes);
                if (!viewerActiveRef.current) {
                    return;
                }
                const url = URL.createObjectURL(blob);
                mediaUrlsRef.current.set(sourceId, url);
                mediaByteSizesRef.current.set(sourceId, result.bytes.byteLength);
                setSlideMedia(sourceId, { status: "ready", url });
                if (previousUrl) {
                    URL.revokeObjectURL(previousUrl);
                }
                replaceSessionFile(sourceId, result.optimisticFile);
                notifyFileUpdated(result.optimisticFile);

                await result.finalize.then((uploaded) => {
                    handleDerivedFileFinalized(sourceId, uploaded);
                });
            } catch (error: unknown) {
                const reverted = useLibraryStore.getState().allFiles.find(
                    (entry) => entry.id === sourceId,
                );
                if (reverted) {
                    replaceSessionFile(sourceId, reverted);
                    notifyFileUpdated(reverted);
                }
                discardSlideUrl(sourceId);
                setSlideMedia(sourceId, { status: "loading" });
                setRetryKey((current) => current + 1);
                toast.error(errorMessage(error, "Could not revert edit"));
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

                discardSlideUrl(deletedId);
                invalidateVideoCache(deletedId);
                setMediaByFileId((current) =>
                    withoutSlideMedia(current, deletedId));

                const current = sessionFilesRef.current;
                const deletedAt = current.findIndex(
                    (entry) => entry.id === deletedId,
                );
                const remaining = current.filter(
                    (entry) => entry.id !== deletedId,
                );
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
                    errorMessage(error, "Could not move item to trash"),
                );
            })
            .finally(() => {
                setDeleteBusy(false);
            });
    };

    if (!file) {
        return <></>;
    }

    const chromeShown = chromeVisible && !cropMode;
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
        const zoomProps =
            isActive && slideFile && isZoomableKind(mediaKindForFile(slideFile)) ?
                {
                    style: pinchZoom.transformStyle,
                    onPointerDown: handleZoomPointerDown,
                    onPointerMove: pinchZoom.onPointerMove,
                    onPointerUp: handleZoomPointerUp,
                    onPointerCancel: handleZoomPointerUp,
                    ref: pinchZoom.wheelTargetRef,
                } :
                undefined;
        const registerActiveMedia = (
            media: HTMLImageElement | HTMLVideoElement | null,
        ): void => {
            if (isActive && viewportRef.current && media) {
                pinchLayoutRef.current = {
                    container: viewportRef.current,
                    image: media,
                };
                updatePanBounds(viewportRef.current, media);
            }
        };

        return (
            <div
                key={slideIndex}
                className="relative h-full shrink-0"
                style={{ width: viewportWidth > 0 ? viewportWidth : "100%" }}
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
                    isVideo ? (
                        <VideoSlidePoster file={slideFile}>
                            {isActive ? (
                                <MediaDownloadIndicator
                                    kind="video"
                                    media={slideMedia}
                                />
                            ) : null}
                        </VideoSlidePoster>
                    ) : isActive ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <MediaDownloadIndicator
                                kind="photo"
                                media={slideMedia}
                            />
                        </div>
                    ) : null
                ) : isVideo ? (
                    <div className="absolute inset-0" {...zoomProps}>
                        <VideoSlidePoster file={slideFile} />
                        <SlideVideo
                            activeVideoRef={isActive ? activeVideoRef : undefined}
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
                                handleBrokenSlideMedia(slideFile.id);
                            }}
                            onLoadedData={() => {
                                registerActiveMedia(activeVideoRef.current);
                            }}
                        />
                    </div>
                ) : (
                    <div
                        className="absolute inset-0 flex items-center justify-center"
                        {...zoomProps}
                    >
                        <img
                            ref={isActive ? activeImageRef : undefined}
                            className="block size-full object-contain select-none [-webkit-touch-callout:none]"
                            src={slideMedia.url}
                            alt=""
                            decoding="async"
                            draggable={false}
                            onError={() => {
                                handleBrokenSlideMedia(slideFile.id);
                            }}
                            onLoad={() => {
                                registerActiveMedia(activeImageRef.current);
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
                    chromeShown ?
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
                    {showSetRelative ? (
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
                                setRelativeStartFileId(file.id);
                                onClose();
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
                        {!readOnly ? (
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
                        ) : null}
                        {!readOnly && canRevertEdit ? (
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
                        {!readOnly && onSetAlbumCover ? (
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
                        {!readOnly && (canCrop(file) || canCropVideo(file)) ? (
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
                        {!readOnly ? (
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
                        ) : null}
                        {!readOnly ? (
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
                        ) : null}
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
                    onPointerCancel={handleCarouselPointerCancel}
                    onDoubleClick={(event) => {
                        // Touch browsers also synthesize dblclick after a double-tap we already handled.
                        if (
                            Date.now() - lastTouchDoubleTapAtRef.current <
                            TOUCH_DOUBLE_TAP_DEDUPE_MS
                        ) {
                            return;
                        }
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
                {chromeShown && deviceViewportLabel ? (
                    <div
                        className={cn(
                            "pointer-events-none absolute left-3 z-20 flex flex-col gap-0.5 rounded bg-black/60 px-1.5 py-1 text-[10px] leading-tight text-white tabular-nums",
                            isVideo ? "bottom-40" : "bottom-24",
                        )}
                        aria-hidden
                    >
                        {imagePixelSize ? (
                            <span>
                                Image: {imagePixelSize.width}×
                                {imagePixelSize.height}
                            </span>
                        ) : null}
                        <span>Viewport: {deviceViewportLabel}</span>
                    </div>
                ) : null}
            </div>

            <div
                className={cn(
                    "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-background px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-transform duration-200",
                    isVideo && "rounded-t-xl shadow-lg",
                    chromeShown ?
                        "translate-y-0" :
                        "translate-y-full pointer-events-none",
                )}
            >
                {isVideo ? (
                    <VideoPlaybackControls
                        key={
                            activeSlideMedia?.url ?
                                `${file.id}:${activeSlideMedia.url}` :
                                "idle"
                        }
                        videoRef={activeVideoRef}
                        attachKey={
                            activeSlideMedia?.status === "ready" ?
                                `${file.id}:${activeSlideMedia.url}` :
                                undefined
                        }
                        visible={chromeShown}
                        onScrubbingChange={setVideoScrubbing}
                    />
                ) : null}
                <div className="flex h-8 shrink-0 items-center gap-1.5">
                    {!readOnly ? (
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
                    ) : null}
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain">
                        {displayTags.length === 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {readOnly ? "" : "No tags"}
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

            {!readOnly ? (
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
            ) : null}
            {!readOnly && cropMode && isVideo ? (
                <VideoEditorOverlay
                    file={file}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleEditSaved}
                />
            ) : null}
            {!readOnly && cropMode && !isVideo ? (
                <CropEditorOverlay
                    file={file}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleEditSaved}
                />
            ) : null}
            {!readOnly ? (
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
            ) : null}
            {!readOnly ? (
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
            ) : null}
        </div>
    );
}, (prev, next) => {
    return (
        prev.initialFileId === next.initialFileId &&
        prev.initialIndex === next.initialIndex &&
        prev.onClose === next.onClose &&
        prev.onFileUpdated === next.onFileUpdated &&
        prev.albumCoverFileId === next.albumCoverFileId &&
        prev.onSetAlbumCover === next.onSetAlbumCover &&
        prev.readOnly === next.readOnly
    );
    // `files` is snapshotted into sessionFiles on mount — ignore identity churn
    // from the gallery page while the viewer is open.
});
