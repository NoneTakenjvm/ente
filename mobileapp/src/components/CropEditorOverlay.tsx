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
import { Spinner } from "@/components/ui/spinner";
import {
    encodeCroppedJpeg,
    pixelCropToSourceRect,
} from "@/lib/crop";
import { rotateImageBytes } from "@/lib/rotate";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

const CROP_WORKSPACE_INSET_PX = 16;

const fullImageCrop = (width: number, height: number): Crop => ({
    unit: "px",
    x: 0,
    y: 0,
    width,
    height,
});

export interface CropSaveResult {
    optimisticFile: EnteFile;
    bytes: Uint8Array;
    finalize: Promise<EnteFile>;
}

interface CropEditorOverlayProps {
    file: EnteFile;
    imageUrl: string;
    mimeType: string;
    onCancel: () => void;
    onSaved: (result: CropSaveResult) => void;
}

export function CropEditorOverlay({
    file,
    imageUrl,
    mimeType,
    onCancel,
    onSaved,
}: CropEditorOverlayProps): JSX.Element {
    const cropAndReplaceFileOptimistic = useLibraryStore(
        (s) => s.cropAndReplaceFileOptimistic,
    );

    const [workingBytes, setWorkingBytes] = useState<Uint8Array | undefined>();
    const [workingUrl, setWorkingUrl] = useState<string | undefined>();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const [loading, setLoading] = useState<boolean>(true);
    const [rotating, setRotating] = useState<boolean>(false);
    const [saving, setSaving] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>();

    const imageRef = useRef<HTMLImageElement>(null);
    const workingUrlRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        const loadBytes = async (): Promise<void> => {
            try {
                const response = await fetch(imageUrl);
                const buffer = await response.arrayBuffer();
                if (cancelled) {
                    return;
                }
                const bytes = new Uint8Array(buffer);
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
    }, [imageUrl, mimeType]);

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
    }, []);

    const handleImageLoad = useCallback(
        (event: SyntheticEvent<HTMLImageElement>): void => {
            const image = event.currentTarget;
            imageRef.current = image;
            const nextCrop = fullImageCrop(image.width, image.height);
            setCrop(nextCrop);
            setCompletedCrop(convertToPixelCrop(nextCrop, image.width, image.height));
        },
        [],
    );

    const handleRotate = useCallback(
        (degrees: 90 | 270): void => {
            if (!workingBytes || rotating || saving) {
                return;
            }
            setRotating(true);
            setError(undefined);
            void rotateImageBytes(workingBytes, mimeType, degrees)
                .then((rotated) => {
                    replaceWorkingImage(rotated.bytes);
                })
                .catch((rotateError: unknown) => {
                    setError(
                        rotateError instanceof Error ?
                            rotateError.message :
                            "Could not rotate image",
                    );
                })
                .finally(() => {
                    setRotating(false);
                });
        },
        [mimeType, replaceWorkingImage, rotating, saving, workingBytes],
    );

    const handleSave = useCallback((): void => {
        const image = imageRef.current;
        if (!workingBytes || !image || !completedCrop || saving) {
            return;
        }
        setSaving(true);
        setError(undefined);
        const cropRect = pixelCropToSourceRect(completedCrop, image);
        void encodeCroppedJpeg(workingBytes, cropRect)
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

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-black/80">
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
                    disabled={isBusy || !completedCrop}
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
                        className="flex min-h-0 w-full flex-1 items-center justify-center"
                        style={{ padding: CROP_WORKSPACE_INSET_PX }}
                    >
                        <ReactCrop
                            crop={crop}
                            disabled={isBusy}
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
                                        image.width,
                                        image.height,
                                    ),
                                );
                            }}
                            className="max-h-full max-w-full"
                        >
                            <img
                                ref={imageRef}
                                src={workingUrl}
                                alt=""
                                className="block max-h-full max-w-full object-contain"
                                onLoad={handleImageLoad}
                                draggable={false}
                            />
                        </ReactCrop>
                    </div>
                )}

                <div className="flex shrink-0 items-center justify-center gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
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
