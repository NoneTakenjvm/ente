import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type JSX,
    type PointerEvent as ReactPointerEvent,
    type TouchEvent as ReactTouchEvent,
} from "react";
import {
    ChevronLeft,
    ChevronRight,
    Crop,
    Heart,
    Image,
    Tag,
    Trash2,
    X,
} from "lucide-react";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import {
    CropEditorOverlay,
    type CropSaveResult,
} from "@/components/CropEditorOverlay";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { VideoCropPanel } from "@/components/VideoCropPanel";
import { VideoPlaybackControls } from "@/components/VideoPlaybackControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import { usePinchZoom } from "@/hooks/use-pinch-zoom";
import { canCrop, canCropVideo } from "@/lib/crop";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import { cn } from "@/lib/utils";
import {
    extractUserTags,
    isReservedTag,
} from "@/lib/tags";
import { addTagNames, applyTagMutator, normalizeTagName, removeTagNames, tagsEqual } from "@/lib/tag-writes";
import { FileType } from "ente-media/file-type";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
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
    cancelled: boolean;
    timedOut: boolean;
    timeoutId: number;
}

interface SlideMedia {
    status: SlideStatus;
    url?: string;
}

const CAROUSEL_TRANSITION_MS = 280;
const SWIPE_THRESHOLD_RATIO = 0.22;
const SWIPE_THRESHOLD_MIN_PX = 40;
const CAROUSEL_DRAG_DEAD_ZONE_PX = 8;
const CHROME_HIDE_MS = 2000;
const MEDIA_LOAD_TIMEOUT_MS = 5000;
const TAP_MAX_MOVEMENT_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;
const DISMISS_THRESHOLD_MIN_PX = 80;
const DISMISS_THRESHOLD_RATIO = 0.15;
const VIDEO_CHROME_TAP_DEADZONE_RATIO = 0.25;

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
    const [favoriteBusy, setFavoriteBusy] = useState<boolean>(false);
    const [favoriteError, setFavoriteError] = useState<string | undefined>();
    const [cropMode, setCropMode] = useState<boolean>(false);
    const [showVideoCrop, setShowVideoCrop] = useState<boolean>(false);
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
    const loadingIdsRef = useRef<Set<number>>(new Set());
    const viewerFileIdRef = useRef<number>(initialFileId);
    const currentIndexRef = useRef<number>(currentIndex);
    const tagBaselineRef = useRef<string[]>([]);
    const viewerActiveRef = useRef<boolean>(true);

    currentIndexRef.current = currentIndex;

    useEffect((): (() => void) => {
        viewerActiveRef.current = true;
        return (): void => {
            viewerActiveRef.current = false;
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
    const zoomEnabled = mediaKind === "image" || mediaKind === "gif";
    const chromePaused =
        cropMode ||
        showVideoCrop ||
        showDeleteConfirm ||
        showTagPicker ||
        videoScrubbing;

    const updateTagsOnFile = useLibraryStore((s) => s.updateTagsOnFile);
    const applyLocalTagsOnFile = useLibraryStore((s) => s.applyLocalTagsOnFile);
    const storeFile = useLibraryStore((s) => file ?
        s.allFiles.find((entry) => entry.id === file.id) :
        undefined);
    const displayFile = storeFile ?? file;
    const setFileFavorite = useLibraryStore((s) => s.setFileFavorite);
    const moveFilesToTrash = useLibraryStore((s) => s.moveFilesToTrash);
    const isFavorite = useFavoritesStore((s) =>
        file ? s.favoriteFileIds.has(file.id) : false);
    const favoritePending = useFavoritesStore((s) =>
        file ? s.pendingFavoriteFileIds.has(file.id) : false);
    const knownTags = useTagStore((s) => s.tags);
    const hydrateVideoPlayback = useVideoPlaybackStore((s) => s.hydrate);
    const videoVolume = useVideoPlaybackStore((s) => s.volume);
    const videoMuted = useVideoPlaybackStore((s) => s.muted);
    const tags = displayFile ? extractUserTags(displayFile) : [];
    const activeSlideMedia = file ? mediaByFileId.get(file.id) : undefined;

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

    const handlePanRelease = useCallback(
        (edgeOverflowX: number): void => {
            const threshold = Math.max(
                SWIPE_THRESHOLD_MIN_PX,
                viewportWidth * SWIPE_THRESHOLD_RATIO,
            );
            if (edgeOverflowX > threshold && currentIndex > 0) {
                goToIndexRef.current(currentIndex - 1, true);
            } else if (
                edgeOverflowX < -threshold &&
                currentIndex < sessionFiles.length - 1
            ) {
                goToIndexRef.current(currentIndex + 1, true);
            }
        },
        [currentIndex, sessionFiles.length, viewportWidth],
    );

    const pinchZoom = usePinchZoom({
        enabled: zoomEnabled,
        onPanRelease: handlePanRelease,
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
        const visibleIndices = [
            currentIndex - 1,
            currentIndex,
            currentIndex + 1,
        ];
        const visibleIds = new Set<number>();
        const loaders: SlideLoader[] = [];

        for (const index of visibleIndices) {
            if (index < 0 || index >= sessionFiles.length) {
                continue;
            }
            const slideFile = sessionFiles[index];
            visibleIds.add(slideFile.id);

            const mediaOverride = getLocalMediaOverride(slideFile.id);
            if (mediaOverride) {
                const mimeType = mimeTypeForFile(slideFile);
                const blob = new Blob([Uint8Array.from(mediaOverride)], {
                    type: mimeType,
                });
                const url = URL.createObjectURL(blob);
                const previousUrl = mediaUrlsRef.current.get(slideFile.id);
                if (previousUrl) {
                    URL.revokeObjectURL(previousUrl);
                }
                mediaUrlsRef.current.set(slideFile.id, url);
                loadingIdsRef.current.delete(slideFile.id);
                setSlideMedia(slideFile.id, { status: "ready", url });
                continue;
            }

            if (
                mediaUrlsRef.current.has(slideFile.id) ||
                loadingIdsRef.current.has(slideFile.id)
            ) {
                continue;
            }

            loadingIdsRef.current.add(slideFile.id);
            setSlideMedia(slideFile.id, { status: "loading" });
            const loader: SlideLoader = {
                cancelled: false,
                timedOut: false,
                timeoutId: window.setTimeout(() => {
                    if (loader.cancelled) {
                        return;
                    }
                    loader.timedOut = true;
                    loadingIdsRef.current.delete(slideFile.id);
                    setSlideMedia(slideFile.id, { status: "error" });
                }, MEDIA_LOAD_TIMEOUT_MS),
            };
            loaders.push(loader);

            void getEnteCore()
                .getDecryptedFile(slideFile)
                .then((bytes) => {
                    window.clearTimeout(loader.timeoutId);
                    if (loader.cancelled || loader.timedOut) {
                        return;
                    }
                    const mimeType = mimeTypeForFile(slideFile);
                    const blob = new Blob([Uint8Array.from(bytes)], {
                        type: mimeType,
                    });
                    const url = URL.createObjectURL(blob);
                    mediaUrlsRef.current.set(slideFile.id, url);
                    loadingIdsRef.current.delete(slideFile.id);
                    setSlideMedia(slideFile.id, { status: "ready", url });
                })
                .catch(() => {
                    window.clearTimeout(loader.timeoutId);
                    loadingIdsRef.current.delete(slideFile.id);
                    if (!loader.cancelled && !loader.timedOut) {
                        setSlideMedia(slideFile.id, { status: "error" });
                    }
                });
        }

        for (const [fileId, url] of [...mediaUrlsRef.current.entries()]) {
            if (!visibleIds.has(fileId)) {
                URL.revokeObjectURL(url);
                mediaUrlsRef.current.delete(fileId);
                loadingIdsRef.current.delete(fileId);
                setMediaByFileId((current) => {
                    if (!current.has(fileId)) {
                        return current;
                    }
                    const next = new Map(current);
                    next.delete(fileId);
                    return next;
                });
            }
        }

        return (): void => {
            for (const loader of loaders) {
                loader.cancelled = true;
                window.clearTimeout(loader.timeoutId);
            }
        };
    }, [currentIndex, retryKey, sessionFiles, setSlideMedia]);

    useEffect((): (() => void) => {
        const urls = mediaUrlsRef.current;
        return (): void => {
            for (const url of urls.values()) {
                URL.revokeObjectURL(url);
            }
            urls.clear();
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

    const handleMediaTap = useCallback((clientY?: number): void => {
        if (isVideo && clientY !== undefined) {
            const viewport = viewportRef.current;
            if (viewport) {
                const { top, height } = viewport.getBoundingClientRect();
                const relativeY = clientY - top;
                const deadzone = height * VIDEO_CHROME_TAP_DEADZONE_RATIO;
                if (relativeY < deadzone || relativeY > height - deadzone) {
                    return;
                }
            }
        }
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
    }, [chromePaused, chromeVisible, isVideo]);

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
        void activeVideoRef.current?.play().catch(() => undefined);
    }, [currentIndex, file?.id, file?.metadata.fileType, mediaByFileId]);

    const handleRetry = useCallback((): void => {
        if (!file) {
            return;
        }
        const url = mediaUrlsRef.current.get(file.id);
        if (url) {
            URL.revokeObjectURL(url);
            mediaUrlsRef.current.delete(file.id);
        }
        loadingIdsRef.current.delete(file.id);
        setSlideMedia(file.id, { status: "idle" });
        setRetryKey((k) => k + 1);
    }, [file, setSlideMedia]);

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
                handleMediaTap(event.clientY);
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
            const updated = useLibraryStore.getState().allFiles.find(
                (entry) => entry.id === fileId,
            );
            if (updated) {
                setSessionFiles((current) => current.map((entry) => (
                    entry.id === fileId ? updated : entry
                )));
                notifyFileUpdated(updated);
            }
        },
        [notifyFileUpdated],
    );

    const flushTagDraft = useCallback(async (): Promise<void> => {
        if (!displayFile) {
            return;
        }
        const fileId = displayFile.id;
        const currentFile =
            useLibraryStore.getState().allFiles.find(
                (entry) => entry.id === fileId,
            ) ?? displayFile;
        const currentTags = extractUserTags(currentFile);
        if (tagsEqual(tagBaselineRef.current, currentTags)) {
            return;
        }
        setTagSaveBusy(true);
        setTagError(undefined);
        try {
            await updateTagsOnFile(fileId, () => currentTags);
            tagBaselineRef.current = currentTags;
            syncSessionFile(fileId);
        } catch (error: unknown) {
            syncSessionFile(fileId);
            setTagError(
                error instanceof Error ?
                    error.message :
                    "Could not save tags",
            );
        } finally {
            setTagSaveBusy(false);
        }
    }, [displayFile, syncSessionFile, updateTagsOnFile]);

    const applyTagChange = useCallback(
        (mutator: (current: string[]) => string[]): void => {
            if (!displayFile) {
                return;
            }
            const fileId = displayFile.id;
            if (showTagPicker) {
                const intended = applyTagMutator(
                    mutator,
                    extractUserTags(displayFile),
                );
                applyLocalTagsOnFile(fileId, intended);
                syncSessionFile(fileId);
                return;
            }
            setTagError(undefined);
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
                });
        },
        [
            applyLocalTagsOnFile,
            displayFile,
            showTagPicker,
            syncSessionFile,
            updateTagsOnFile,
        ],
    );

    const handleAddTag = useCallback(
        (name: string): void => {
            const normalized = normalizeTagName(name);
            if (!normalized || isReservedTag(normalized)) {
                return;
            }
            applyTagChange((current) => addTagNames(current, normalized));
        },
        [applyTagChange],
    );

    const handleRemoveTag = useCallback(
        (tag: string): void => {
            applyTagChange((current) => removeTagNames(current, tag));
        },
        [applyTagChange],
    );

    const handleDerivedFileFinalized = useCallback(
        (sourceId: number, uploaded: EnteFile): void => {
            const stillViewingSource =
                sessionFiles[currentIndexRef.current]?.id === sourceId;
            const url = mediaUrlsRef.current.get(sourceId);
            if (url) {
                mediaUrlsRef.current.delete(sourceId);
                mediaUrlsRef.current.set(uploaded.id, url);
            }
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

    const handleCropSaved = useCallback(
        (result: CropSaveResult): void => {
            if (!file) {
                return;
            }
            const sourceId = file.id;
            const previousUrl = mediaUrlsRef.current.get(sourceId);
            if (previousUrl) {
                URL.revokeObjectURL(previousUrl);
            }
            const url = URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                    type: "image/jpeg",
                }),
            );
            mediaUrlsRef.current.set(sourceId, url);
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
                    if (staleUrl) {
                        URL.revokeObjectURL(staleUrl);
                        mediaUrlsRef.current.delete(sourceId);
                    }
                    setSlideMedia(sourceId, { status: "loading" });
                    setRetryKey((current) => current + 1);
                    toast.error(
                        error instanceof Error ?
                            error.message :
                            "Could not save crop",
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

    const handleDerivedFileUploaded = useCallback(
        (uploaded: EnteFile): void => {
            if (file) {
                const sourceId = file.id;
                setSessionFiles((current) => current.map((entry) => (
                    entry.id === sourceId ? uploaded : entry
                )));
            }
            notifyFileUpdated(uploaded);
        },
        [file, notifyFileUpdated],
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

    const handleConfirmDelete = (): void => {
        if (!file) {
            return;
        }
        setDeleteBusy(true);
        setDeleteError(undefined);
        void moveFilesToTrash([file.id])
            .then(() => {
                setShowDeleteConfirm(false);
                onClose();
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
                    isActive ? (
                        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Loading…
                        </div>
                    ) : null
                ) : isVideo ? (
                    <div className="absolute inset-0">
                        <video
                            ref={isActive ? activeVideoRef : undefined}
                            className="pointer-events-none size-full object-contain select-none [-webkit-touch-callout:none]"
                            src={slideMedia.url}
                            loop
                            playsInline
                            preload="metadata"
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
            className="fixed inset-0 z-50 flex select-none flex-col bg-background [-webkit-touch-callout:none]"
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
                    <span className="text-xs text-muted-foreground">
                        {currentIndex + 1} / {sessionFiles.length}
                    </span>
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
                        {canCrop(file) ? (
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
                                aria-label="Crop image"
                            >
                                <Crop />
                            </Button>
                        ) : null}
                        {canCropVideo(file) ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                    resetChromeTimer();
                                    setShowVideoCrop(true);
                                }}
                                aria-label="Crop video"
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
                    </div>
                </div>
            </div>

            <div
                ref={viewportRef}
                className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black/40"
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
                            tagBaselineRef.current = [...tags];
                            setTagError(undefined);
                            setShowTagPicker(true);
                        }}
                    >
                        {tagSaveBusy ? <Spinner /> : <Tag />}
                        Tags
                    </Button>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain">
                        {tags.length === 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                                No tags
                            </span>
                        ) : (
                            tags.map((tag) => (
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
                appliedTags={tags}
                knownTags={knownTags}
                error={tagError}
                onOpenChange={(open) => {
                    if (open) {
                        tagBaselineRef.current = [...tags];
                        setTagError(undefined);
                        setShowTagPicker(true);
                        return;
                    }
                    setShowTagPicker(false);
                    void flushTagDraft();
                }}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
            />
            {showVideoCrop ? (
                <VideoCropPanel
                    file={file}
                    onClose={() => setShowVideoCrop(false)}
                    onUploaded={(uploaded) => {
                        setShowVideoCrop(false);
                        handleDerivedFileUploaded(uploaded);
                    }}
                />
            ) : null}
            {cropMode && file ? (
                <CropEditorOverlay
                    file={file}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleCropSaved}
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
        </div>
    );
}
