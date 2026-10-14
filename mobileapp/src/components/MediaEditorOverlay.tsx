import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type JSX,
    type SyntheticEvent,
} from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import { CropBox } from "@/components/CropBox";
import { formatTime } from "@/components/VideoPlaybackControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { encodeNormalizedCroppedJpeg } from "@/lib/crop";
import {
    defaultNormalizedCrop,
    fitRectToRatio,
    type NormalizedCropRect,
} from "@/lib/crop-draft";
import {
    containedDisplaySize,
    cropRectForVideoSave,
    trimRangeChanged,
    videoCropChanged,
} from "@/lib/crop-editor";
import { rotateImageBytes } from "@/lib/rotate";
import { viewportTargetAspectRatio } from "@/lib/viewport-fit";
import { loadMediaBytesForEdit } from "@/lib/load-media-bytes";
import { logJsHeap } from "@/lib/memory-probe";
import {
    applyVideoEdits,
    probeVideoDurationSec,
    rotateVideoBytes,
    type VideoTrimRange,
} from "@/lib/video-edit";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import { mimeTypeForFile } from "@/lib/media-kind";
import { useLibraryStore } from "@/stores/library-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";
import { errorMessage } from "@/lib/format";

const CROP_WORKSPACE_INSET_PX = 16;
const MIN_TRIM_GAP_SEC = 0.25;

export interface MediaEditSaveResult {
    optimisticFile: EnteFile;
    bytes: Uint8Array;
    finalize: Promise<EnteFile>;
}

interface MediaEditorOverlayProps {
    file: EnteFile;
    /** Image editing crops and rotates; video editing also trims. */
    kind: "image" | "video";
    onCancel: () => void;
    onSaved: (result: MediaEditSaveResult) => void;
}

interface Size {
    width: number;
    height: number;
}

type MediaElement = HTMLImageElement | HTMLVideoElement;

/** Full-screen crop/rotate editor (plus trim for video) over a working copy of the file. */
export function MediaEditorOverlay({
    file,
    kind,
    onCancel,
    onSaved,
}: MediaEditorOverlayProps): JSX.Element {
    const isVideo = kind === "video";
    const cropAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.cropAndReplaceFileOptimistic,
    );
    const editVideoAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.editVideoAndReplaceFileOptimistic,
    );
    const viewportTargetWidth = useUIStore((s) => s.viewportTargetWidth);
    const viewportTargetHeight = useUIStore((s) => s.viewportTargetHeight);
    const lockAspect = useUIStore((s) => s.cropLockAspect);
    const setCropLockAspect = useUIStore((s) => s.setCropLockAspect);
    const targetAspect = viewportTargetAspectRatio(
        viewportTargetWidth,
        viewportTargetHeight,
    );

    const [workingBytes, setWorkingBytes] = useState<Uint8Array | undefined>();
    const [workingUrl, setWorkingUrl] = useState<string | undefined>();
    const [crop, setCrop] = useState<NormalizedCropRect>();
    const [loading, setLoading] = useState<boolean>(true);
    const [rotating, setRotating] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [mediaReady, setMediaReady] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();
    const [workspaceSize, setWorkspaceSize] = useState<Size | undefined>();
    const [displayLayout, setDisplayLayout] = useState<Size | undefined>();
    // Video only.
    const [sourceDimensions, setSourceDimensions] = useState<
        Size | undefined
    >();
    const [encodeProgress, setEncodeProgress] = useState<number | undefined>();
    const [durationSec, setDurationSec] = useState<number>(0);
    const [trimStartSec, setTrimStartSec] = useState<number>(0);
    const [trimEndSec, setTrimEndSec] = useState<number>(0);
    const [trimScrubbing, setTrimScrubbing] = useState<boolean>(false);

    const mediaRef = useRef<MediaElement | null>(null);
    const workingUrlRef = useRef<string | undefined>(undefined);
    const workspaceRef = useRef<HTMLDivElement>(null);
    /** Latest file for the load effect, which reruns only when the file id changes. */
    const fileRef = useRef<EnteFile>(file);
    const mountedRef = useRef<boolean>(false);
    const mimeType = mimeTypeForFile(file);
    useEffect((): void => {
        fileRef.current = file;
    });

    useEffect((): (() => void) => {
        mountedRef.current = true;
        return (): void => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadBytes = async (): Promise<void> => {
            try {
                const bytes = await loadMediaBytesForEdit(fileRef.current);
                if (cancelled) {
                    return;
                }
                const url = URL.createObjectURL(
                    blobFromUint8Array(bytes, mimeType),
                );
                workingUrlRef.current = url;
                setWorkingBytes(bytes);
                setWorkingUrl(url);
                setLoading(false);
            } catch {
                if (!cancelled) {
                    setError(
                        `Could not load the ${kind} for editing.`,
                    );
                    setLoading(false);
                }
            }
        };

        void loadBytes();

        return (): void => {
            cancelled = true;
            if (workingUrlRef.current) {
                URL.revokeObjectURL(workingUrlRef.current);
                workingUrlRef.current = undefined;
            }
        };
    }, [file.id, kind, mimeType]);

    useEffect(() => {
        const element = workspaceRef.current;
        if (!element) {
            return;
        }
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            const { width, height } = entry.contentRect;
            setWorkspaceSize({
                width: Math.max(0, width - CROP_WORKSPACE_INSET_PX * 2),
                height: Math.max(0, height - CROP_WORKSPACE_INSET_PX * 2),
            });
        });
        observer.observe(element);
        return (): void => {
            observer.disconnect();
        };
    }, [loading]);

    /** Swap in new working bytes (after rotate) and reset everything derived from them. */
    const replaceWorking = useCallback(
        (bytes: Uint8Array, bytesMimeType: string): void => {
            if (!mountedRef.current) {
                return;
            }
            const url = URL.createObjectURL(
                blobFromUint8Array(bytes, bytesMimeType),
            );
            if (workingUrlRef.current) {
                URL.revokeObjectURL(workingUrlRef.current);
            }
            workingUrlRef.current = url;
            setWorkingBytes(bytes);
            setWorkingUrl(url);
            setDisplayLayout(undefined);
            setCrop(undefined);
            setMediaReady(false);
        },
        [],
    );

    const applyDisplayLayout = useCallback(
        (element: MediaElement): void => {
            const intrinsic = intrinsicSize(element);
            if (!workspaceSize || intrinsic.width <= 0 || intrinsic.height <= 0) {
                return;
            }
            const layout = containedDisplaySize(
                intrinsic.width,
                intrinsic.height,
                workspaceSize.width,
                workspaceSize.height,
            );
            setDisplayLayout(layout);
            setCrop(
                defaultNormalizedCrop(
                    layout.width / layout.height,
                    targetAspect,
                ),
            );
            setMediaReady(true);
        },
        [targetAspect, workspaceSize],
    );

    useEffect(() => {
        const element = mediaRef.current;
        if (!element || intrinsicSize(element).width <= 0) {
            return;
        }
        applyDisplayLayout(element);
    }, [applyDisplayLayout, workspaceSize]);

    const handleMediaLoad = useCallback(
        (event: SyntheticEvent<MediaElement>): void => {
            const element = event.currentTarget;
            if (element instanceof HTMLVideoElement) {
                if (element.videoWidth > 0 && element.videoHeight > 0) {
                    setSourceDimensions({
                        width: element.videoWidth,
                        height: element.videoHeight,
                    });
                }
                if (Number.isFinite(element.duration) && element.duration > 0) {
                    setDurationSec(element.duration);
                    setTrimStartSec(0);
                    setTrimEndSec(element.duration);
                }
            }
            requestAnimationFrame(() => {
                applyDisplayLayout(element);
            });
        },
        [applyDisplayLayout],
    );

    // Loop the preview inside the trim range.
    useEffect(() => {
        const element = mediaRef.current;
        if (
            !(element instanceof HTMLVideoElement) ||
            durationSec <= 0 ||
            trimScrubbing
        ) {
            return;
        }
        const onTimeUpdate = (): void => {
            if (element.currentTime < trimStartSec) {
                element.currentTime = trimStartSec;
            } else if (element.currentTime >= trimEndSec) {
                element.currentTime = trimStartSec;
                void element.play().catch(() => undefined);
            }
        };
        element.addEventListener("timeupdate", onTimeUpdate);
        return (): void => {
            element.removeEventListener("timeupdate", onTimeUpdate);
        };
    }, [durationSec, trimEndSec, trimScrubbing, trimStartSec, workingUrl]);

    const handleRotate = useCallback(
        (degrees: 90 | 270): void => {
            if (!workingBytes || rotating || saving) {
                return;
            }
            if (isVideo && !sourceDimensions) {
                return;
            }
            setRotating(true);
            setEncodeProgress(undefined);
            setError(undefined);
            setMediaReady(false);
            setCrop(undefined);

            const rotate = async (): Promise<void> => {
                if (!isVideo || !sourceDimensions) {
                    const rotated = await rotateImageBytes(
                        workingBytes,
                        "image/jpeg",
                        degrees,
                    );
                    if (mountedRef.current) {
                        replaceWorking(rotated.bytes, "image/jpeg");
                    }
                    return;
                }
                const rotated = await rotateVideoBytes(
                    workingBytes,
                    mimeType,
                    degrees,
                    sourceDimensions,
                    (ratio) => {
                        setEncodeProgress(Math.round(ratio * 100));
                    },
                );
                if (!mountedRef.current) {
                    return;
                }
                replaceWorking(rotated.bytes, "video/mp4");
                setSourceDimensions({
                    width: rotated.width,
                    height: rotated.height,
                });
                setDurationSec(rotated.duration);
                setTrimStartSec(0);
                setTrimEndSec(rotated.duration);
            };

            void rotate()
                .catch((rotateError: unknown) => {
                    setError(
                        errorMessage(rotateError, `Could not rotate ${kind}`),
                    );
                    setMediaReady(true);
                })
                .finally(() => {
                    setRotating(false);
                    setEncodeProgress(undefined);
                });
        },
        [
            isVideo,
            kind,
            mimeType,
            replaceWorking,
            rotating,
            saving,
            sourceDimensions,
            workingBytes,
        ],
    );

    const saveImage = useCallback((): void => {
        if (!workingBytes || !crop) {
            return;
        }
        setSaving(true);
        setError(undefined);
        void encodeNormalizedCroppedJpeg(workingBytes, crop)
            .then((encoded) => {
                const { optimisticFile, finalize } =
                    cropAndReplaceFileOptimistic(file.id, encoded.bytes, {
                        width: encoded.width,
                        height: encoded.height,
                    });
                onSaved({
                    optimisticFile,
                    bytes: encoded.bytes,
                    finalize,
                });
            })
            .catch((saveError: unknown) => {
                setSaving(false);
                setError(errorMessage(saveError, "Could not save crop"));
            });
    }, [
        crop,
        cropAndReplaceFileOptimistic,
        file.id,
        onSaved,
        workingBytes,
    ]);

    const saveVideo = useCallback((): void => {
        if (
            !workingBytes ||
            !mediaRef.current ||
            !crop ||
            !sourceDimensions
        ) {
            return;
        }
        setSaving(true);
        setEncodeProgress(undefined);
        setError(undefined);

        const trim: VideoTrimRange | undefined = trimRangeChanged(
            { startSec: trimStartSec, endSec: trimEndSec },
            durationSec,
        ) ?
            { startSec: trimStartSec, endSec: trimEndSec } :
            undefined;
        const videoCrop = videoCropChanged(crop) ?
            cropRectForVideoSave(
                crop,
                sourceDimensions.width,
                sourceDimensions.height,
            ) :
            undefined;

        const saveEdits = async () => {
            const sourceBytes = workingBytes;
            // Drop the playing preview before encode so Chromium can reclaim it
            // while ffmpeg WASM is allocated.
            if (workingUrlRef.current) {
                URL.revokeObjectURL(workingUrlRef.current);
                workingUrlRef.current = undefined;
            }
            setWorkingUrl(undefined);
            logJsHeap("video-editor:before-encode");

            if (!videoCrop && !trim) {
                const duration = await probeVideoDurationSec(
                    sourceBytes,
                    mimeType,
                );
                return {
                    bytes: sourceBytes,
                    width: sourceDimensions.width,
                    height: sourceDimensions.height,
                    duration,
                };
            }
            return applyVideoEdits(
                sourceBytes,
                mimeType,
                {
                    crop: videoCrop,
                    trim,
                    onProgress: (ratio) => {
                        setEncodeProgress(Math.round(ratio * 100));
                    },
                },
                sourceDimensions,
            );
        };

        void saveEdits()
            .then((edited) => {
                setWorkingBytes(undefined);
                logJsHeap("video-editor:after-encode");
                const { optimisticFile, finalize } =
                    editVideoAndReplaceFileOptimistic(file.id, edited);
                onSaved({
                    optimisticFile,
                    bytes: edited.bytes,
                    finalize,
                });
            })
            .catch((saveError: unknown) => {
                // Restore preview URL if encode failed and we still have bytes.
                if (workingBytes && !workingUrlRef.current) {
                    const url = URL.createObjectURL(
                        blobFromUint8Array(workingBytes, mimeType),
                    );
                    workingUrlRef.current = url;
                    setWorkingUrl(url);
                }
                setSaving(false);
                setEncodeProgress(undefined);
                setError(
                    errorMessage(saveError, "Could not save video edits"),
                );
            });
    }, [
        crop,
        durationSec,
        editVideoAndReplaceFileOptimistic,
        file.id,
        mimeType,
        onSaved,
        sourceDimensions,
        trimEndSec,
        trimStartSec,
        workingBytes,
    ]);

    const handleSave = useCallback((): void => {
        if (saving || !mediaReady) {
            return;
        }
        if (isVideo) {
            saveVideo();
        } else {
            saveImage();
        }
    }, [isVideo, mediaReady, saveImage, saveVideo, saving]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && !saving) {
                onCancel();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return (): void => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [onCancel, saving]);

    const isBusy = loading || rotating || saving;
    const trimStartPercent =
        durationSec > 0 ? (trimStartSec / durationSec) * 100 : 0;
    const trimEndPercent =
        durationSec > 0 ? (trimEndSec / durationSec) * 100 : 100;

    /** Normalized width / height of a crop with the target's pixel aspect. */
    const targetRatio =
        displayLayout ?
            (targetAspect * displayLayout.height) / displayLayout.width :
            undefined;
    const lockedRatio = !isVideo && lockAspect ? targetRatio : undefined;

    const handleLockAspectChange = useCallback(
        (checked: boolean): void => {
            setCropLockAspect(checked);
            if (checked && crop && targetRatio !== undefined) {
                setCrop(fitRectToRatio(crop, targetRatio));
            }
        },
        [crop, setCropLockAspect, targetRatio],
    );

    const handleTrimChange = useCallback(
        (value: number | readonly number[]): void => {
            if (!Array.isArray(value) || value.length < 2 || durationSec <= 0) {
                return;
            }
            const [startPercent, endPercent] = value;
            if (startPercent === undefined || endPercent === undefined) {
                return;
            }
            let nextStart = (startPercent / 100) * durationSec;
            let nextEnd = (endPercent / 100) * durationSec;
            if (nextEnd - nextStart < MIN_TRIM_GAP_SEC) {
                if (startPercent !== trimStartPercent) {
                    nextStart = Math.max(0, nextEnd - MIN_TRIM_GAP_SEC);
                } else {
                    nextEnd = Math.min(durationSec, nextStart + MIN_TRIM_GAP_SEC);
                }
            }
            setTrimStartSec(nextStart);
            setTrimEndSec(nextEnd);
            const video = mediaRef.current;
            if (video instanceof HTMLVideoElement) {
                video.currentTime = nextStart;
                video.pause();
            }
        },
        [durationSec, trimStartPercent],
    );

    const mediaClassName = "block select-none [-webkit-touch-callout:none]";
    const mediaStyle = displayLayout ?
        { width: displayLayout.width, height: displayLayout.height } :
        {
            maxWidth: workspaceSize?.width,
            maxHeight: workspaceSize?.height,
            visibility: "hidden" as const,
        };

    return (
        <div
            className="fixed inset-0 z-[60] flex select-none flex-col bg-black/90 [-webkit-touch-callout:none]"
            onPointerDown={(event) => {
                event.stopPropagation();
            }}
        >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-background/95 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancel}
                    disabled={saving}
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    size="sm"
                    onClick={handleSave}
                    disabled={isBusy || !crop || !mediaReady}
                >
                    {saving ? (
                        <>
                            <Spinner />
                            {encodeProgress !== undefined ?
                                `Saving ${encodeProgress}%` :
                                "Saving…"}
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
            </div>

            {(rotating || saving) && encodeProgress !== undefined ? (
                <div className="shrink-0 border-b border-border/50 bg-background/95 px-3 py-2">
                    <Progress value={encodeProgress} className="w-full" />
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
                {error ? (
                    <Alert variant="destructive" className="mb-2 max-w-md shrink-0">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                ) : null}

                {loading || !workingUrl ? (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Spinner />
                        Loading…
                    </div>
                ) : (
                    <div
                        ref={workspaceRef}
                        className="relative flex min-h-0 w-full flex-1 touch-none overflow-hidden select-none items-center justify-center [-webkit-touch-callout:none]"
                        style={{ padding: CROP_WORKSPACE_INSET_PX }}
                    >
                        {!workspaceSize ? (
                            <Spinner />
                        ) : (
                            <>
                                {!mediaReady ? (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Spinner />
                                    </div>
                                ) : null}
                                <div
                                    className="relative shrink-0"
                                    style={displayLayout}
                                >
                                    {isVideo ? (
                                        <video
                                            key={workingUrl}
                                            ref={(element) => {
                                                mediaRef.current = element;
                                            }}
                                            src={workingUrl}
                                            className={mediaClassName}
                                            style={mediaStyle}
                                            muted
                                            playsInline
                                            loop
                                            autoPlay
                                            onLoadedMetadata={handleMediaLoad}
                                        />
                                    ) : (
                                        <img
                                            key={workingUrl}
                                            ref={(element) => {
                                                mediaRef.current = element;
                                            }}
                                            src={workingUrl}
                                            alt=""
                                            className={mediaClassName}
                                            style={mediaStyle}
                                            onLoad={handleMediaLoad}
                                            draggable={false}
                                        />
                                    )}
                                    {crop && displayLayout ? (
                                        <CropBox
                                            imageBox={{
                                                left: 0,
                                                top: 0,
                                                ...displayLayout,
                                            }}
                                            rect={crop}
                                            onCommit={setCrop}
                                            disabled={isBusy || !mediaReady}
                                            lockedRatio={lockedRatio}
                                            edgeHandles
                                        />
                                    ) : null}
                                </div>
                            </>
                        )}
                    </div>
                )}

                <div className="relative z-10 flex shrink-0 flex-col items-center gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
                    {durationSec > 0 ? (
                        <div
                            className="flex w-full items-center gap-2 px-2"
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <span className="w-9 shrink-0 text-right text-[0.65rem] tabular-nums text-muted-foreground">
                                {formatTime(trimStartSec)}
                            </span>
                            <Slider
                                className="min-w-0 flex-1"
                                min={0}
                                max={100}
                                step={0.1}
                                value={[trimStartPercent, trimEndPercent]}
                                disabled={isBusy}
                                onPointerDown={() => {
                                    setTrimScrubbing(true);
                                    if (mediaRef.current instanceof HTMLVideoElement) {
                                        mediaRef.current.pause();
                                    }
                                }}
                                onPointerUp={() => {
                                    setTrimScrubbing(false);
                                }}
                                onValueChange={handleTrimChange}
                            />
                            <span className="w-9 shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">
                                {formatTime(trimEndSec)}
                            </span>
                        </div>
                    ) : null}
                    {isVideo ? null : (
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                            <Checkbox
                                checked={lockAspect}
                                disabled={isBusy || !mediaReady}
                                onCheckedChange={(checked) => {
                                    handleLockAspectChange(checked === true);
                                }}
                            />
                            Lock aspect ratio
                        </label>
                    )}
                    <div className="flex items-center justify-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => handleRotate(270)}
                            disabled={isBusy || !workingBytes}
                            aria-label="Rotate left"
                        >
                            {rotating ? <Spinner /> : <RotateCcw />}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => handleRotate(90)}
                            disabled={isBusy || !workingBytes}
                            aria-label="Rotate right"
                        >
                            {rotating ? <Spinner /> : <RotateCw />}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Decoded pixel size of the element, or 0x0 until it has loaded. */
function intrinsicSize(element: MediaElement): Size {
    if (element instanceof HTMLVideoElement) {
        return { width: element.videoWidth, height: element.videoHeight };
    }
    return element.complete ?
        { width: element.naturalWidth, height: element.naturalHeight } :
        { width: 0, height: 0 };
}
