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
    makeAspectCrop,
    type Crop,
    type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { RotateCcw, RotateCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import {
    bakeRotation,
    containedDisplaySize,
    encodeBakedCrop,
} from "@/lib/crop-editor";
import {
    maxAspectRatioCrop,
    viewportTargetAspectRatio,
} from "@/lib/viewport-fit";
import { getLocalMediaOverride } from "@/lib/local-media-overrides";
import { mimeTypeForFile } from "@/lib/media-kind";
import { useLibraryStore } from "@/stores/library-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

const CROP_WORKSPACE_INSET_PX = 16;

export interface CropSaveResult {
    optimisticFile: EnteFile;
    bytes: Uint8Array;
    finalize: Promise<EnteFile>;
}

interface CropEditorOverlayProps {
    file: EnteFile;
    onCancel: () => void;
    onSaved: (result: CropSaveResult) => void;
}

export function CropEditorOverlay({
    file,
    onCancel,
    onSaved,
}: CropEditorOverlayProps): JSX.Element {
    const cropAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.cropAndReplaceFileOptimistic,
    );
    const viewportTargetWidth = useUIStore((s) => s.viewportTargetWidth);
    const viewportTargetHeight = useUIStore((s) => s.viewportTargetHeight);
    const targetAspect = viewportTargetAspectRatio(
        viewportTargetWidth,
        viewportTargetHeight,
    );

    const [workingBytes, setWorkingBytes] = useState<Uint8Array | undefined>();
    const [workingUrl, setWorkingUrl] = useState<string | undefined>();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const [lockAspect, setLockAspect] = useState<boolean>(true);
    const [cropAspect, setCropAspect] = useState<number | undefined>();
    const [loading, setLoading] = useState<boolean>(true);
    const [rotating, setRotating] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [imageReady, setImageReady] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();
    const [workspaceSize, setWorkspaceSize] = useState<
        { width: number; height: number } | undefined
    >();
    const [displayLayout, setDisplayLayout] = useState<
        { width: number; height: number } | undefined
    >();

    const imageRef = useRef<HTMLImageElement>(null);
    const workingUrlRef = useRef<string | undefined>(undefined);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const mimeType = mimeTypeForFile(file);

    useEffect(() => {
        let cancelled = false;

        const loadBytes = async (): Promise<void> => {
            try {
                const bytes =
                    getLocalMediaOverride(file.id) ??
                    (await getEnteCore().getDecryptedFile(file));
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
                    setError("Could not load the image for editing.");
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

    const replaceWorkingImage = useCallback((bytes: Uint8Array): void => {
        const url = URL.createObjectURL(
            new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
        );
        if (workingUrlRef.current) {
            URL.revokeObjectURL(workingUrlRef.current);
        }
        workingUrlRef.current = url;
        setWorkingBytes(bytes);
        setWorkingUrl(url);
        setDisplayLayout(undefined);
        setCrop(undefined);
        setCompletedCrop(undefined);
        setImageReady(false);
    }, []);

    const applyDisplayLayout = useCallback((
        image: HTMLImageElement,
    ): void => {
        if (
            !workspaceSize ||
            image.naturalWidth <= 0 ||
            image.naturalHeight <= 0
        ) {
            return;
        }
        const layout = containedDisplaySize(
            image.naturalWidth,
            image.naturalHeight,
            workspaceSize.width,
            workspaceSize.height,
        );
        const aspect = targetAspect;
        const nextCrop = maxAspectRatioCrop(
            layout.width,
            layout.height,
            aspect,
        );
        setCropAspect(aspect);
        setDisplayLayout(layout);
        setCrop(nextCrop);
        setCompletedCrop(convertToPixelCrop(nextCrop, layout.width, layout.height));
        setImageReady(true);
    }, [targetAspect, workspaceSize]);

    useEffect(() => {
        const image = imageRef.current;
        if (!image?.complete || image.naturalWidth <= 0) {
            return;
        }
        applyDisplayLayout(image);
    }, [applyDisplayLayout, workspaceSize]);

    const handleImageLoad = useCallback(
        (event: SyntheticEvent<HTMLImageElement>): void => {
            const image = event.currentTarget;
            imageRef.current = image;
            requestAnimationFrame(() => {
                applyDisplayLayout(image);
            });
        },
        [applyDisplayLayout],
    );

    const handleRotate = useCallback(
        (degrees: 90 | 270): void => {
            if (!workingBytes || rotating || saving) {
                return;
            }
            setRotating(true);
            setError(undefined);
            setImageReady(false);
            setCrop(undefined);
            setCompletedCrop(undefined);
            void bakeRotation(workingBytes, "image/jpeg", degrees)
                .then((rotated) => {
                    replaceWorkingImage(rotated.bytes);
                })
                .catch((rotateError: unknown) => {
                    setError(
                        rotateError instanceof Error ?
                            rotateError.message :
                            "Could not rotate image",
                    );
                    setImageReady(true);
                })
                .finally(() => {
                    setRotating(false);
                });
        },
        [replaceWorkingImage, rotating, saving, workingBytes],
    );

    const handleSave = useCallback((): void => {
        const image = imageRef.current;
        if (!workingBytes || !image || !completedCrop || saving || !imageReady) {
            return;
        }
        setSaving(true);
        setError(undefined);
        void encodeBakedCrop(workingBytes, completedCrop, image)
            .then((encoded) => {
                const { optimisticFile, finalize } = cropAndReplaceFileOptimistic(
                    file.id,
                    encoded.bytes,
                    { width: encoded.width, height: encoded.height },
                );
                onSaved({
                    optimisticFile,
                    bytes: encoded.bytes,
                    finalize,
                });
            })
            .catch((saveError: unknown) => {
                setSaving(false);
                setError(
                    saveError instanceof Error ?
                        saveError.message :
                        "Could not save crop",
                );
            });
    }, [
        completedCrop,
        cropAndReplaceFileOptimistic,
        file.id,
        imageReady,
        onSaved,
        saving,
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

    const handleLockAspectChange = useCallback(
        (checked: boolean): void => {
            setLockAspect(checked);
            if (!checked) {
                return;
            }
            const image = imageRef.current;
            const aspect = cropAspect ?? targetAspect;
            if (!image || !crop || aspect <= 0) {
                return;
            }
            const nextCrop = makeAspectCrop(
                {
                    unit: "px",
                    x: crop.x,
                    y: crop.y,
                    width: crop.width,
                    height: crop.height,
                },
                aspect,
                image.clientWidth,
                image.clientHeight,
            );
            setCropAspect(aspect);
            setCrop(nextCrop);
            setCompletedCrop(
                convertToPixelCrop(
                    nextCrop,
                    image.clientWidth,
                    image.clientHeight,
                ),
            );
        },
        [crop, cropAspect, targetAspect],
    );

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
                    disabled={isBusy || !completedCrop || !imageReady}
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
                                {!imageReady ? (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Spinner />
                                    </div>
                                ) : null}
                                <ReactCrop
                                    crop={crop}
                                    keepSelection
                                    aspect={
                                        lockAspect && cropAspect ?
                                            cropAspect :
                                            undefined
                                    }
                                    disabled={isBusy || !imageReady}
                                    onChange={(nextCrop) => {
                                        setCrop(nextCrop);
                                    }}
                                    onComplete={(nextCrop) => {
                                        const image = imageRef.current;
                                        if (!image) {
                                            return;
                                        }
                                        setCompletedCrop(
                                            convertToPixelCrop(
                                                nextCrop,
                                                image.clientWidth,
                                                image.clientHeight,
                                            ),
                                        );
                                    }}
                                    className="max-h-full max-w-full select-none [-webkit-touch-callout:none]"
                                >
                                    <img
                                        key={workingUrl}
                                        ref={imageRef}
                                        src={workingUrl}
                                        alt=""
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
                                        onLoad={handleImageLoad}
                                        draggable={false}
                                    />
                                </ReactCrop>
                            </>
                        )}
                    </div>
                )}

                <div className="relative z-10 flex shrink-0 flex-col items-center gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                        <Checkbox
                            checked={lockAspect}
                            disabled={isBusy || !imageReady}
                            onCheckedChange={(checked) => {
                                handleLockAspectChange(checked === true);
                            }}
                        />
                        Lock aspect ratio
                    </label>
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
