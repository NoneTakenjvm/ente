import {
    useCallback,
    useEffect,
    useRef,
    useState,
    memo,
    type JSX,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
    MediaEditorOverlay,
    type MediaEditSaveResult,
} from "@/components/MediaEditorOverlay";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import {
    MediaDownloadIndicator,
    primeVideoFirstFrame,
    SlideVideo,
    VideoSlidePoster,
} from "@/components/photo-viewer/SlideParts";
import { ViewerChrome } from "@/components/photo-viewer/ViewerChrome";
import { Button } from "@/components/ui/button";
import { slideBlob, useSlideMedia } from "@/hooks/use-slide-media";
import { useSlideshow } from "@/hooks/use-slideshow";
import { useThumbnailEntry } from "@/hooks/use-thumbnail-entry";
import { useViewerGestures } from "@/hooks/use-viewer-gestures";
import { useViewerTagDraft } from "@/hooks/use-viewer-tag-draft";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { hasEditHistory } from "@/lib/edit-history";
import { errorMessage } from "@/lib/format";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import {
    isEnteVideoFile,
    mediaKindForFile,
    mimeTypeForFile,
    type MediaKind,
} from "@/lib/media-kind";
import { extractUserTags } from "@/lib/tags";
import { VIEW_SESSION_QUALIFY_MS } from "@/lib/view-sessions";
import {
    forgetSessionVideoUrl,
    invalidateVideoCache,
} from "@/lib/video-media-cache";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import { useVideoPlaybackStore } from "@/stores/video-playback-store";
import { useViewSessionsStore } from "@/stores/view-sessions-store";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { toast } from "sonner";

interface PhotoViewerProps {
    files: EnteFile[];
    /** Start position, read on mount only. Preferred when the file list may contain duplicate ids (e.g. Recents). */
    initialIndex?: number;
    /** Start file, read on mount only. */
    initialFileId?: number;
    onClose: () => void;
    albumCoverFileId?: number;
    onSetAlbumCover?: (fileId: number) => void;
    /** Hide mutation chrome (tags, crop, delete, favourite, …). */
    readOnly?: boolean;
}

/** History-state marker so Safari edge-back can be absorbed while the viewer is open. */
const VIEWER_HISTORY_STATE = { entePhotoViewer: true } as const;

export const PhotoViewer = memo(function PhotoViewer({
    files,
    initialIndex,
    initialFileId,
    onClose,
    albumCoverFileId,
    onSetAlbumCover,
    readOnly = false,
}: PhotoViewerProps): JSX.Element {
    const [sessionFiles, setSessionFiles] = useState<EnteFile[]>(files);
    const [currentIndex, setCurrentIndex] = useState<number>(() =>
        resolveViewerStartIndex(sessionFiles, initialIndex, initialFileId));
    const [favoriteBusy, setFavoriteBusy] = useState<boolean>(false);
    const [favoriteError, setFavoriteError] = useState<string | undefined>();
    const [archiveBusy, setArchiveBusy] = useState<boolean>(false);
    const [revertBusy, setRevertBusy] = useState<boolean>(false);
    const [showRevertConfirm, setShowRevertConfirm] = useState<boolean>(false);
    const [cropMode, setCropMode] = useState<boolean>(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
    const [deleteBusy, setDeleteBusy] = useState<boolean>(false);
    const [deleteError, setDeleteError] = useState<string | undefined>();
    /** File whose playback scrubber is being dragged; resets itself when the slide changes. */
    const [scrubbingFileId, setScrubbingFileId] = useState<number | undefined>();
    const [slideshowPlaying, setSlideshowPlaying] = useState<boolean>(false);

    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const activeImageRef = useRef<HTMLImageElement>(null);
    const activeVideoRef = useRef<HTMLVideoElement>(null);
    const currentIndexRef = useRef<number>(currentIndex);
    const sessionFilesRef = useRef<EnteFile[]>(sessionFiles);
    const viewerActiveRef = useRef<boolean>(true);

    useEffect((): void => {
        currentIndexRef.current = currentIndex;
        sessionFilesRef.current = sessionFiles;
    }, [currentIndex, sessionFiles]);

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

    const file = sessionFiles[currentIndex];
    const mediaKind = file ? mediaKindForFile(file) : null;
    const isVideo = file?.metadata.fileType === FileType.video;
    const relativeActive = useUIStore((s) => s.ordering?.kind === "relative");
    const relativeStartFileId = useUIStore((s) => {
        const { ordering } = s;
        return ordering?.kind === "relative" ? ordering.startFileId : undefined;
    });
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
        relativeActive &&
        file !== undefined &&
        !isEnteVideoFile(file) &&
        hasClipEmbedding;
    const zoomEnabled = isZoomableKind(mediaKind);

    const viewerFileId = file?.id;
    const storeFile = useLibraryStore((s) =>
        viewerFileId === undefined ? undefined : s.getFileById(viewerFileId));
    const displayFile = storeFile ?? file;
    const batchSetFavorite = useLibraryStore((s) => s.batchSetFavorite);
    const batchSetArchived = useLibraryStore((s) => s.batchSetArchived);
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
    const slideshowSeconds = useSettingsStore((s) => s.slideshowSeconds);
    // The slideshow advances on `ended`, so its videos must play and not loop.
    const videoAutoPlayActive = videoAutoPlay || slideshowPlaying;
    const videoLoopActive = videoLoop && !slideshowPlaying;
    const activeVideoThumb = useThumbnailEntry(isVideo ? file : undefined);

    const slides = useSlideMedia(sessionFiles, currentIndex);
    const { mediaByFileId } = slides;
    const activeSlideMedia = file ? mediaByFileId.get(file.id) : undefined;

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
            }
        },
        [replaceSessionFile],
    );

    const tagDraft = useViewerTagDraft(displayFile, syncSessionFile);
    const displayTags =
        tagDraft.stagedTags ?? (displayFile ? extractUserTags(displayFile) : []);

    const gestures = useViewerGestures({
        fileId: file?.id,
        fileCount: sessionFiles.length,
        currentIndex,
        setCurrentIndex,
        zoomEnabled,
        cropMode,
        chromePaused:
            cropMode ||
            showDeleteConfirm ||
            tagDraft.showTagPicker ||
            scrubbingFileId === file?.id,
        keysBlocked:
            cropMode ||
            tagDraft.showTagPicker ||
            showDeleteConfirm ||
            showRevertConfirm,
        onClose,
        viewportRef,
        activeImageRef,
        activeVideoRef,
    });
    const { clearPointers, resetChromeTimer, resetZoom } = gestures;

    const { goNext, goToIndex } = gestures;
    const hasNext = currentIndex < sessionFiles.length - 1;
    // The slideshow loops: after the last slide it jumps back to the first.
    const advanceSlideshow = useCallback((): void => {
        if (hasNext) {
            goNext();
        } else {
            goToIndex(0);
        }
    }, [goNext, goToIndex, hasNext]);
    useSlideshow({
        playing: slideshowPlaying,
        paused:
            gestures.zoomed ||
            gestures.carouselAnimating ||
            cropMode ||
            tagDraft.showTagPicker ||
            showDeleteConfirm ||
            showRevertConfirm,
        fileId: file?.id,
        mediaSettled:
            activeSlideMedia?.status === "ready" ||
            activeSlideMedia?.status === "error",
        advanceOnVideoEnd:
            isVideo &&
            activeSlideMedia?.status === "ready" &&
            activeSlideMedia.url !== undefined,
        seconds: slideshowSeconds,
        activeVideoRef,
        advance: advanceSlideshow,
    });

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
        if (!videoAutoPlayActive) {
            primeVideoFirstFrame(video);
            return;
        }
        void video.play().catch(() => undefined);
    }, [currentIndex, isVideo, activeSlideMedia?.url, videoAutoPlayActive]);

    /**
     * Show a derived edit (crop, video edit or revert) immediately from its
     * bytes, then swap in the uploaded file; on failure fall back to the store's file.
     */
    const applyDerivedEdit = async (
        sourceFile: EnteFile,
        result: MediaEditSaveResult,
        blob: Blob | Promise<Blob>,
        failureLabel: string,
    ): Promise<void> => {
        const sourceId = sourceFile.id;
        try {
            const editedBlob = await blob;
            if (!viewerActiveRef.current) {
                return;
            }
            forgetSessionVideoUrl(sourceId);
            slides.setSlideUrl(
                sourceId,
                URL.createObjectURL(editedBlob),
                result.bytes.byteLength,
            );
            replaceSessionFile(sourceId, result.optimisticFile);
            const uploaded = await result.finalize;
            slides.transferSlide(sourceId, uploaded.id);
            replaceSessionFile(sourceId, uploaded);
        } catch (error: unknown) {
            const reverted = useLibraryStore.getState().getFileById(sourceId);
            if (reverted) {
                replaceSessionFile(sourceId, reverted);
            }
            forgetSessionVideoUrl(sourceId);
            slides.reloadSlide(sourceId);
            toast.error(errorMessage(error, failureLabel));
        }
    };

    const handleEditSaved = (result: MediaEditSaveResult): void => {
        if (!file) {
            return;
        }
        clearPointers();
        resetZoom();
        setCropMode(false);
        void applyDerivedEdit(
            file,
            result,
            blobFromUint8Array(result.bytes, mimeTypeForFile(file)),
            "Could not save edits",
        );
    };

    const handleRevertLastEdit = (): void => {
        if (!file) {
            return;
        }
        const result = revertLastEdit(file.id);
        if (!result) {
            setShowRevertConfirm(false);
            return;
        }
        clearPointers();
        resetZoom();
        setRevertBusy(true);
        setShowRevertConfirm(false);
        void applyDerivedEdit(
            file,
            result,
            slideBlob(file, result.bytes),
            "Could not revert edit",
        ).finally(() => {
            setRevertBusy(false);
        });
    };

    const handleToggleFavorite = (): void => {
        if (!file) {
            return;
        }
        clearPointers();
        setFavoriteBusy(true);
        setFavoriteError(undefined);
        void batchSetFavorite([file.id], !isFavorite)
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
        void batchSetArchived([file.id], !isArchived)
            .catch((error: unknown) => {
                toast.error(errorMessage(error, "Could not update archive"));
            })
            .finally(() => {
                setArchiveBusy(false);
            });
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

                slides.removeSlide(deletedId);
                invalidateVideoCache(deletedId);

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

    const chromeShown = gestures.chromeVisible && !cropMode;

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
        const isVideoSlide =
            slideFile?.metadata.fileType === FileType.video;
        const zoomProps =
            isActive && slideFile && isZoomableKind(mediaKindForFile(slideFile)) ?
                gestures.zoomProps :
                undefined;

        return (
            <div
                key={slideIndex}
                className="relative h-full shrink-0"
                style={{
                    width:
                        gestures.viewportWidth > 0 ?
                            gestures.viewportWidth :
                            "100%",
                }}
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
                                onClick={() => {
                                    slides.retrySlide(slideFile.id);
                                }}
                            >
                                Retry
                            </Button>
                        </div>
                    ) : null
                ) : slideMedia?.status === "loading" || !slideMedia?.url ? (
                    isVideoSlide ? (
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
                ) : isVideoSlide ? (
                    <div className="absolute inset-0" {...zoomProps}>
                        <VideoSlidePoster file={slideFile} />
                        <SlideVideo
                            activeVideoRef={isActive ? activeVideoRef : undefined}
                            className="pointer-events-none absolute inset-0 size-full object-contain select-none [-webkit-touch-callout:none]"
                            src={slideMedia.url}
                            loop={videoLoopActive}
                            playsInline
                            preload={videoAutoPlay ? "metadata" : "auto"}
                            poster={
                                isActive && activeVideoThumb.url ?
                                    activeVideoThumb.url :
                                    undefined
                            }
                            onError={() => {
                                slides.handleBrokenSlideMedia(slideFile.id);
                            }}
                            onLoadedData={() => {
                                if (isActive) {
                                    gestures.registerActiveMedia(
                                        activeVideoRef.current,
                                    );
                                }
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
                                slides.handleBrokenSlideMedia(slideFile.id);
                            }}
                            onLoad={() => {
                                if (isActive) {
                                    gestures.registerActiveMedia(
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
            onPointerDownCapture={resetChromeTimer}
        >
            <div className="relative min-h-0 flex-1 bg-black/40">
                <div
                    ref={viewportRef}
                    className="absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top,0px)] touch-none overflow-hidden"
                    {...gestures.viewportHandlers}
                >
                    <div
                        ref={trackRef}
                        className="flex h-full min-h-0 items-stretch"
                        style={gestures.trackStyle}
                    >
                        {([-1, 0, 1] as const).map((offset) =>
                            renderSlide(offset))}
                    </div>
                </div>
            </div>

            <ViewerChrome
                shown={chromeShown}
                readOnly={readOnly}
                file={file}
                isVideo={isVideo}
                currentIndex={currentIndex}
                fileCount={sessionFiles.length}
                activeSlideMedia={activeSlideMedia}
                activeVideoRef={activeVideoRef}
                carouselAnimating={gestures.carouselAnimating}
                slideshowPlaying={slideshowPlaying}
                isFavorite={isFavorite}
                favoriteDisabled={favoriteBusy || favoritePending}
                isArchived={isArchived}
                archiveBusy={archiveBusy}
                canRevertEdit={canRevertEdit}
                revertBusy={revertBusy}
                albumCoverFileId={albumCoverFileId}
                onSetAlbumCover={onSetAlbumCover}
                showSetRelative={showSetRelative}
                relativeStartFileId={relativeStartFileId}
                tags={displayTags}
                tagSaveBusy={tagDraft.tagSaveBusy}
                showTagPicker={tagDraft.showTagPicker}
                errors={{
                    tag: tagDraft.tagError,
                    favorite: favoriteError,
                    delete: deleteError,
                }}
                onClose={onClose}
                onPrev={gestures.goPrev}
                onNext={gestures.goNext}
                onToggleSlideshow={() => {
                    setSlideshowPlaying((playing) => !playing);
                }}
                onSetRelative={() => {
                    setRelativeStartFileId(file.id);
                    onClose();
                }}
                onToggleFavorite={handleToggleFavorite}
                onToggleArchive={handleToggleArchive}
                onRevert={() => setShowRevertConfirm(true)}
                onCrop={() => setCropMode(true)}
                onDelete={() => setShowDeleteConfirm(true)}
                onEditTags={tagDraft.beginTagDraft}
                onScrubbingChange={(scrubbing) => {
                    setScrubbingFileId(scrubbing ? file.id : undefined);
                }}
            />

            {!readOnly ? (
                <TagPickerSheet
                    open={tagDraft.showTagPicker}
                    appliedTags={displayTags}
                    knownTags={knownTags}
                    error={tagDraft.tagError}
                    batchSelectionHint="Tap tags to stage changes. Closing saves."
                    onOpenChange={(open) => {
                        if (open) {
                            tagDraft.beginTagDraft();
                            return;
                        }
                        tagDraft.flushTagDraft();
                    }}
                    onAddTag={tagDraft.addTag}
                    onRemoveTag={tagDraft.removeTag}
                />
            ) : null}
            {!readOnly && cropMode ? (
                <MediaEditorOverlay
                    file={file}
                    kind={isVideo ? "video" : "image"}
                    onCancel={() => setCropMode(false)}
                    onSaved={handleEditSaved}
                />
            ) : null}
            {!readOnly ? (
                <ConfirmDialog
                    open={showDeleteConfirm}
                    title="Move this photo to trash?"
                    description="It can be restored from Manage → Trash within 30 days."
                    confirmLabel="Move to trash"
                    destructive
                    isWorking={deleteBusy}
                    onCancel={() => setShowDeleteConfirm(false)}
                    onConfirm={handleConfirmDelete}
                />
            ) : null}
            {!readOnly ? (
                <ConfirmDialog
                    open={showRevertConfirm}
                    title="Revert last edit?"
                    description="This restores the previous version of this photo from this device. The change uploads in the background."
                    confirmLabel="Revert"
                    workingLabel="Reverting…"
                    isWorking={revertBusy}
                    onCancel={() => setShowRevertConfirm(false)}
                    onConfirm={handleRevertLastEdit}
                />
            ) : null}
        </div>
    );
});

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

const isZoomableKind = (kind: MediaKind | null): boolean =>
    kind === "image" || kind === "gif" || kind === "video";
