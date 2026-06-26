import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type JSX,
    type SyntheticEvent,
} from "react";
import ReactCrop, {
    convertToPixelCrop,
    type Crop,
    type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { RotateCcw, RotateCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import {
    containedDisplaySize,
    cropRectForVideoSave,
    detectContentBoundsFromVideo,
    initialCropForDisplay,
    trimRangeChanged,
    videoCropChanged,
} from "@/lib/crop-editor";
import { mimeTypeForFile } from "@/lib/media-kind";
import {
    applyVideoEdits,
    probeVideoDurationSec,
    rotateVideoBytes,
    type VideoTrimRange,
} from "@/lib/video-edit";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

const CROP_WORKSPACE_INSET_PX = 16;
const MIN_TRIM_GAP_SEC = 0.25;

export interface VideoSaveResult {
    optimisticFile: EnteFile;
    bytes: Uint8Array;
    finalize: Promise<EnteFile>;
}

interface VideoEditorOverlayProps {
    file: EnteFile;
    onCancel: () => void;
    onSaved: (result: VideoSaveResult) => void;
}

const formatTime = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export function VideoEditorOverlay({
    file,
    onCancel,
    onSaved,
}: VideoEditorOverlayProps): JSX.Element {
    const editVideoAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.editVideoAndReplaceFileOptimistic,
    );

    const [workingBytes, setWorkingBytes] = useState<Uint8Array | undefined>();
    const [workingUrl, setWorkingUrl] = useState<string | undefined>();
    const [sourceDimensions, setSourceDimensions] = useState<
        { width: number; height: number } | undefined
    >();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const [loading, setLoading] = useState<boolean>(true);
    const [rotating, setRotating] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [videoReady, setVideoReady] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();
    const [workspaceSize, setWorkspaceSize] = useState<
        { width: number; height: number } | undefined
    >();
    const [displayLayout, setDisplayLayout] = useState<
        { width: number; height: number } | undefined
    >();
    const [durationSec, setDurationSec] = useState<number>(0);
    const [trimStartSec, setTrimStartSec] = useState<number>(0);
    const [trimEndSec, setTrimEndSec] = useState<number>(0);
    const [trimScrubbing, setTrimScrubbing] = useState<boolean>(false);

    const videoRef = useRef<HTMLVideoElement>(null);
    const workingUrlRef = useRef<string | undefined>(undefined);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const layoutGenerationRef = useRef<number>(0);
    const mimeType = mimeTypeForFile(file);

    useEffect(() => {
        let cancelled = false;

        const loadBytes = async (): Promise<void> => {
            try {
                const bytes = await getEnteCore().getDecryptedFile(file);
                if (cancelled) {
                    return;
                }
                const url = URL.createObjectURL(
                    new Blob([Uint8Array.from(bytes)], { type: mimeType }),
                );
                workingUrlRef.current = url;
                setWorkingBytes(bytes);
                setWorkingUrl(url);
                setLoading(false);
            } catch {
                if (!cancelled) {
                    setError("Could not load the video for editing.");
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
    }, [file, mimeType]);

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
            const nextSize = {
                width: Math.max(0, width - CROP_WORKSPACE_INSET_PX * 2),
                height: Math.max(0, height - CROP_WORKSPACE_INSET_PX * 2),
            };
            setWorkspaceSize(nextSize);
        });
        observer.observe(element);
        return (): void => {
            observer.disconnect();
        };
    }, [loading]);

    const replaceWorkingVideo = useCallback((
        bytes: Uint8Array,
        dimensions: { width: number; height: number },
        duration: number,
    ): void => {
        const url = URL.createObjectURL(
            new Blob([Uint8Array.from(bytes)], { type: "video/mp4" }),
        );
        if (workingUrlRef.current) {
            URL.revokeObjectURL(workingUrlRef.current);
        }
        workingUrlRef.current = url;
        setWorkingBytes(bytes);
        setWorkingUrl(url);
        setSourceDimensions(dimensions);
        setDurationSec(duration);
        setTrimStartSec(0);
        setTrimEndSec(duration);
        setDisplayLayout(undefined);
        setCrop(undefined);
        setCompletedCrop(undefined);
        setVideoReady(false);
    }, []);

    const applyDisplayLayout = useCallback(async (
        video: HTMLVideoElement,
    ): Promise<void> => {
        if (
            !workspaceSize ||
            video.videoWidth <= 0 ||
            video.videoHeight <= 0
        ) {
            return;
        }
        const generation = ++layoutGenerationRef.current;
        const layout = containedDisplaySize(
            video.videoWidth,
            video.videoHeight,
            workspaceSize.width,
            workspaceSize.height,
        );
        const contentBounds = await detectContentBoundsFromVideo(video);
        if (generation !== layoutGenerationRef.current) {
            return;
        }
        const nextCrop = initialCropForDisplay(
            layout.width,
            layout.height,
            video.videoWidth,
            video.videoHeight,
            contentBounds,
        );
        setDisplayLayout(layout);
        setCrop(nextCrop);
        setCompletedCrop(convertToPixelCrop(nextCrop, layout.width, layout.height));
        setVideoReady(true);
    }, [workspaceSize]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || video.videoWidth <= 0) {
            return;
        }
        void applyDisplayLayout(video);
    }, [applyDisplayLayout, workspaceSize]);

    const handleVideoLoaded = useCallback(
        (event: SyntheticEvent<HTMLVideoElement>): void => {
            const video = event.currentTarget;
            videoRef.current = video;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
                setSourceDimensions({
                    width: video.videoWidth,
                    height: video.videoHeight,
                });
            }
            if (Number.isFinite(video.duration) && video.duration > 0) {
                setDurationSec(video.duration);
                setTrimStartSec(0);
                setTrimEndSec(video.duration);
            }
            requestAnimationFrame(() => {
                void applyDisplayLayout(video);
            });
        },
        [applyDisplayLayout],
    );

    useEffect(() => {
        const video = videoRef.current;
        if (!video || durationSec <= 0 || trimScrubbing) {
            return;
        }
        const onTimeUpdate = (): void => {
            if (video.currentTime < trimStartSec) {
                video.currentTime = trimStartSec;
            } else if (video.currentTime >= trimEndSec) {
                video.currentTime = trimStartSec;
                void video.play().catch(() => undefined);
            }
        };
        video.addEventListener("timeupdate", onTimeUpdate);
        return (): void => {
            video.removeEventListener("timeupdate", onTimeUpdate);
        };
    }, [durationSec, trimEndSec, trimScrubbing, trimStartSec, workingUrl]);

    const handleRotate = useCallback(
        (degrees: 90 | 270): void => {
            if (!workingBytes || !sourceDimensions || rotating || saving) {
                return;
            }
            setRotating(true);
            setError(undefined);
            setVideoReady(false);
            setCrop(undefined);
            setCompletedCrop(undefined);
            void rotateVideoBytes(
                workingBytes,
                mimeType,
                degrees,
                sourceDimensions,
            )
                .then((rotated) => {
                    replaceWorkingVideo(
                        rotated.bytes,
                        { width: rotated.width, height: rotated.height },
                        rotated.duration,
                    );
                })
                .catch((rotateError: unknown) => {
                    setError(
                        rotateError instanceof Error ?
                            rotateError.message :
                            "Could not rotate video",
                    );
                    setVideoReady(true);
                })
                .finally(() => {
                    setRotating(false);
                });
        },
        [
            mimeType,
            replaceWorkingVideo,
            rotating,
            saving,
            sourceDimensions,
            workingBytes,
        ],
    );

    const handleSave = useCallback((): void => {
        const video = videoRef.current;
        if (
            !workingBytes ||
            !video ||
            !completedCrop ||
            !displayLayout ||
            !sourceDimensions ||
            saving ||
            !videoReady
        ) {
            return;
        }
        setSaving(true);
        setError(undefined);

        const cropRect = cropRectForVideoSave(completedCrop, video);
        const trim: VideoTrimRange | undefined =
            trimRangeChanged(
                { startSec: trimStartSec, endSec: trimEndSec },
                durationSec,
            ) ?
                { startSec: trimStartSec, endSec: trimEndSec } :
                undefined;
        const crop = videoCropChanged(
            completedCrop,
            displayLayout.width,
            displayLayout.height,
        ) ?
            cropRect :
            undefined;

        const saveEdits = async () => {
            if (!crop && !trim) {
                const duration = await probeVideoDurationSec(workingBytes, mimeType);
                return {
                    bytes: workingBytes,
                    width: sourceDimensions.width,
                    height: sourceDimensions.height,
                    duration,
                };
            }
            return applyVideoEdits(
                workingBytes,
                mimeType,
                { crop, trim },
                sourceDimensions,
            );
        };

        void saveEdits()
            .then((edited) => {
                const { optimisticFile, finalize } =
                    editVideoAndReplaceFileOptimistic(file.id, edited);
                onSaved({
                    optimisticFile,
                    bytes: edited.bytes,
                    finalize,
                });
            })
            .catch((saveError: unknown) => {
                setSaving(false);
                setError(
                    saveError instanceof Error ?
                        saveError.message :
                        "Could not save video edits",
                );
            });
    }, [
        completedCrop,
        displayLayout,
        durationSec,
        editVideoAndReplaceFileOptimistic,
        file.id,
        mimeType,
        onSaved,
        saving,
        sourceDimensions,
        trimEndSec,
        trimStartSec,
        videoReady,
        workingBytes,
    ]);

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

    const handleTrimChange = useCallback((value: number | readonly number[]): void => {
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
        const video = videoRef.current;
        if (video) {
            video.currentTime = nextStart;
            video.pause();
        }
    }, [durationSec, trimStartPercent]);

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
                    disabled={isBusy || !completedCrop || !videoReady}
                >
                    {saving ? (
                        <>
                            <Spinner />
                            Saving…
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
            </div>

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
                        className="relative flex min-h-0 w-full flex-1 touch-none select-none items-center justify-center [-webkit-touch-callout:none]"
                        style={{ padding: CROP_WORKSPACE_INSET_PX }}
                    >
                        {!workspaceSize ? (
                            <Spinner />
                        ) : (
                            <>
                                {!videoReady ? (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Spinner />
                                    </div>
                                ) : null}
                                <ReactCrop
                                    crop={crop}
                                    disabled={isBusy || !videoReady}
                                    onChange={(nextCrop) => {
                                        setCrop(nextCrop);
                                    }}
                                    onComplete={(nextCrop) => {
                                        const video = videoRef.current;
                                        if (!video) {
                                            return;
                                        }
                                        setCompletedCrop(
                                            convertToPixelCrop(
                                                nextCrop,
                                                video.clientWidth,
                                                video.clientHeight,
                                            ),
                                        );
                                    }}
                                    className="max-h-full max-w-full select-none [-webkit-touch-callout:none]"
                                >
                                    <video
                                        key={workingUrl}
                                        ref={videoRef}
                                        src={workingUrl}
                                        className="block select-none [-webkit-touch-callout:none]"
                                        style={
                                            displayLayout ?
                                                {
                                                    width: displayLayout.width,
                                                    height: displayLayout.height,
                                                } :
                                                {
                                                    maxWidth: workspaceSize.width,
                                                    maxHeight: workspaceSize.height,
                                                    visibility: "hidden",
                                                }
                                        }
                                        muted
                                        playsInline
                                        loop
                                        autoPlay
                                        onLoadedMetadata={handleVideoLoaded}
                                    />
                                </ReactCrop>
                            </>
                        )}
                    </div>
                )}

                {durationSec > 0 ? (
                    <div
                        className="relative z-10 flex shrink-0 flex-col gap-1 px-2 pt-2"
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center gap-2">
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
                                    videoRef.current?.pause();
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
                    </div>
                ) : null}

                <div className="relative z-10 flex shrink-0 items-center justify-center gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
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
    );
}
