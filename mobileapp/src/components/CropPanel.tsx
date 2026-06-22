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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getEnteCore } from "@/core";
import { encodeCroppedJpeg, type CropRect } from "@/lib/crop";
import type { RotationDegrees } from "@/lib/rotate";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

type PanelPhase =
    "loading" |
    "ready" |
    "encoding" |
    "preview" |
    "uploading" |
    "success" |
    "error";

type CropRotation = 0 | RotationDegrees;

const fullImageCrop = (width: number, height: number): Crop => ({
    unit: "px",
    x: 0,
    y: 0,
    width,
    height,
});

const pixelCropToSourceRect = (
    pixelCrop: PixelCrop,
    image: HTMLImageElement,
): CropRect => {
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    return {
        x: Math.round(pixelCrop.x * scaleX),
        y: Math.round(pixelCrop.y * scaleY),
        width: Math.round(pixelCrop.width * scaleX),
        height: Math.round(pixelCrop.height * scaleY),
    };
};

interface CropPanelProps {
    file: EnteFile;
    onClose: () => void;
    onUploaded?: (file: EnteFile) => void;
}

export function CropPanel({
    file,
    onClose,
    onUploaded,
}: CropPanelProps): JSX.Element {
    const cropAndUploadFile = useLibraryStore((s) => s.cropAndUploadFile);

    const [phase, setPhase] = useState<PanelPhase>("loading");
    const [originalBytes, setOriginalBytes] = useState<Uint8Array | undefined>();
    const [imageUrl, setImageUrl] = useState<string | undefined>();
    const [rotation, setRotation] = useState<CropRotation>(0);
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const [croppedBytes, setCroppedBytes] = useState<Uint8Array | undefined>();
    const [croppedUrl, setCroppedUrl] = useState<string | undefined>();
    const [dimensions, setDimensions] = useState<
        { width: number; height: number } | undefined
    >();
    const [error, setError] = useState<string | undefined>();

    const imageRef = useRef<HTMLImageElement>(null);

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;

        const loadOriginal = async (): Promise<void> => {
            try {
                const bytes = await getEnteCore().getDecryptedFile(file);
                if (cancelled) {
                    return;
                }
                objectUrl = URL.createObjectURL(
                    new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
                );
                setOriginalBytes(bytes);
                setImageUrl(objectUrl);
                setPhase("ready");
            } catch {
                if (!cancelled) {
                    setPhase("error");
                    setError("Could not load the original image.");
                }
            }
        };

        void loadOriginal();

        return (): void => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [file]);

    useEffect(() => {
        return (): void => {
            if (croppedUrl) {
                URL.revokeObjectURL(croppedUrl);
            }
        };
    }, [croppedUrl]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && phase !== "uploading") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return (): void => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose, phase]);

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

    const handleRotationChange = useCallback((next: CropRotation): void => {
        setRotation(next);
        const image = imageRef.current;
        if (!image) {
            return;
        }
        const nextCrop = fullImageCrop(image.width, image.height);
        setCrop(nextCrop);
        setCompletedCrop(convertToPixelCrop(nextCrop, image.width, image.height));
    }, []);

    const handleApplyCrop = useCallback((): void => {
        const image = imageRef.current;
        if (!originalBytes || !image || !completedCrop) {
            return;
        }
        const cropRect = pixelCropToSourceRect(completedCrop, image);
        setPhase("encoding");
        setError(undefined);
        void encodeCroppedJpeg(originalBytes, cropRect, undefined, rotation)
            .then((result) => {
                setCroppedBytes(result.bytes);
                setDimensions({ width: result.width, height: result.height });
                setCroppedUrl((prev) => {
                    if (prev) {
                        URL.revokeObjectURL(prev);
                    }
                    return URL.createObjectURL(
                        new Blob([Uint8Array.from(result.bytes)], {
                            type: "image/jpeg",
                        }),
                    );
                });
                setPhase("preview");
            })
            .catch((cropError: unknown) => {
                setPhase("error");
                setError(
                    cropError instanceof Error ?
                        cropError.message :
                        "Could not crop image",
                );
            });
    }, [completedCrop, originalBytes, rotation]);

    const handleUpload = useCallback((): void => {
        if (!croppedBytes || !dimensions) {
            return;
        }
        setPhase("uploading");
        setError(undefined);
        void cropAndUploadFile(file.id, croppedBytes, dimensions)
            .then((uploaded) => {
                setPhase("success");
                onUploaded?.(uploaded);
            })
            .catch((uploadError: unknown) => {
                setPhase("error");
                setError(
                    uploadError instanceof Error ?
                        uploadError.message :
                        "Upload failed",
                );
            });
    }, [cropAndUploadFile, croppedBytes, dimensions, file.id, onUploaded]);

    const handleBackToCrop = useCallback((): void => {
        setPhase("ready");
        setCroppedBytes(undefined);
        setCroppedUrl((prev) => {
            if (prev) {
                URL.revokeObjectURL(prev);
            }
            return undefined;
        });
        setDimensions(undefined);
    }, []);

    const isBusy = phase === "uploading" || phase === "encoding";

    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open && phase !== "uploading") {
                    onClose();
                }
            }}
        >
            <SheetContent
                side="bottom"
                className="max-h-[95dvh] overflow-y-auto rounded-t-xl"
            >
                <SheetHeader>
                    <SheetTitle>Crop photo</SheetTitle>
                </SheetHeader>

                <div className="flex flex-col gap-4 px-4">
                    {phase === "loading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Loading original…
                        </p>
                    ) : null}

                    {phase === "error" && error ? (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    {imageUrl && (phase === "ready" || phase === "encoding") ? (
                        <>
                            <div className="flex min-h-[45dvh] w-full items-center justify-center overflow-hidden rounded-lg bg-muted">
                                <ReactCrop
                                    crop={crop}
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
                                    className="max-h-[45dvh] max-w-full"
                                >
                                    <img
                                        ref={imageRef}
                                        src={imageUrl}
                                        alt=""
                                        className="max-h-[45dvh] max-w-full object-contain"
                                        style={{
                                            transform: `rotate(${rotation}deg)`,
                                        }}
                                        onLoad={handleImageLoad}
                                    />
                                </ReactCrop>
                            </div>
                            <ToggleGroup
                                value={[String(rotation)]}
                                onValueChange={(next) => {
                                    const selected = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (
                                        selected === "0" ||
                                        selected === "90" ||
                                        selected === "180" ||
                                        selected === "270"
                                    ) {
                                        handleRotationChange(
                                            Number(selected) as CropRotation,
                                        );
                                    }
                                }}
                                spacing={2}
                                className="w-full"
                            >
                                {(
                                    [
                                        ["0", "0°"],
                                        ["90", "90°"],
                                        ["180", "180°"],
                                        ["270", "270°"],
                                    ] as const
                                ).map(([value, label]) => (
                                    <ToggleGroupItem
                                        key={value}
                                        value={value}
                                        size="sm"
                                        disabled={isBusy}
                                    >
                                        {label}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </>
                    ) : null}

                    {croppedUrl && phase === "preview" ? (
                        <>
                            <img
                                className="max-h-[60dvh] w-full rounded-lg object-contain"
                                src={croppedUrl}
                                alt="Cropped preview"
                            />
                            {dimensions ? (
                                <p className="text-sm text-muted-foreground">
                                    {dimensions.width} × {dimensions.height}
                                </p>
                            ) : null}
                        </>
                    ) : null}

                    {phase === "encoding" ? (
                        <p className="text-sm text-muted-foreground">
                            Applying crop…
                        </p>
                    ) : null}

                    {phase === "uploading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Encrypting and uploading…
                        </p>
                    ) : null}

                    {phase === "success" ? (
                        <Alert>
                            <AlertDescription>
                                Cropped copy uploaded and tagged.
                            </AlertDescription>
                        </Alert>
                    ) : null}
                </div>

                <SheetFooter className="flex-row justify-end gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={
                            phase === "preview" ?
                                handleBackToCrop :
                                onClose
                        }
                        disabled={phase === "uploading"}
                    >
                        {phase === "success" ?
                            "Done" :
                            phase === "preview" ?
                                "Adjust crop" :
                                "Cancel"}
                    </Button>
                    {phase === "ready" || phase === "encoding" ? (
                        <Button
                            type="button"
                            onClick={handleApplyCrop}
                            disabled={
                                phase !== "ready" ||
                                !completedCrop ||
                                isBusy
                            }
                        >
                            Apply crop
                        </Button>
                    ) : null}
                    {phase === "preview" ? (
                        <Button
                            type="button"
                            onClick={handleUpload}
                            disabled={!croppedBytes || !dimensions}
                        >
                            Upload cropped copy
                        </Button>
                    ) : null}
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
