import {
    useCallback,
    useEffect,
    useState,
    type JSX,
} from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
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
import { getEnteCore } from "@/core";
import { mimeTypeForFile } from "@/lib/media-kind";
import type { VideoCropRect } from "@/lib/video-edit";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

type PanelPhase = "loading" | "ready" | "uploading" | "success" | "error";

interface VideoCropPanelProps {
    file: EnteFile;
    onClose: () => void;
    onUploaded?: (file: EnteFile) => void;
}

export function VideoCropPanel({
    file,
    onClose,
    onUploaded,
}: VideoCropPanelProps): JSX.Element {
    const cropVideoAndUploadFile = useLibraryStore(
        (s) => s.cropVideoAndUploadFile,
    );

    const [phase, setPhase] = useState<PanelPhase>("loading");
    const [videoUrl, setVideoUrl] = useState<string | undefined>();
    const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
    const [zoom, setZoom] = useState<number>(1);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;

        const loadVideo = async (): Promise<void> => {
            try {
                const bytes = await getEnteCore().getDecryptedFile(file);
                if (cancelled) {
                    return;
                }
                objectUrl = URL.createObjectURL(
                    new Blob([Uint8Array.from(bytes)], {
                        type: mimeTypeForFile(file),
                    }),
                );
                setVideoUrl(objectUrl);
                setPhase("ready");
            } catch {
                if (!cancelled) {
                    setPhase("error");
                    setError("Could not load the video.");
                }
            }
        };

        void loadVideo();

        return (): void => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [file]);

    const handleUpload = useCallback((): void => {
        if (!croppedAreaPixels) {
            return;
        }
        const cropRect: VideoCropRect = {
            x: Math.round(croppedAreaPixels.x),
            y: Math.round(croppedAreaPixels.y),
            width: Math.round(croppedAreaPixels.width),
            height: Math.round(croppedAreaPixels.height),
        };
        setPhase("uploading");
        setError(undefined);
        void cropVideoAndUploadFile(file.id, cropRect)
            .then((uploaded) => {
                setPhase("success");
                onUploaded?.(uploaded);
            })
            .catch((uploadError: unknown) => {
                setPhase("error");
                setError(
                    uploadError instanceof Error ?
                        uploadError.message :
                        "Video crop upload failed",
                );
            });
    }, [cropVideoAndUploadFile, croppedAreaPixels, file.id, onUploaded]);

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
                    <SheetTitle>Crop video</SheetTitle>
                </SheetHeader>

                <div className="flex flex-col gap-4 px-4">
                    {phase === "loading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Loading video…
                        </p>
                    ) : null}

                    {videoUrl && phase !== "loading" ? (
                        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
                            <Cropper
                                video={videoUrl}
                                crop={crop}
                                zoom={zoom}
                                aspect={undefined}
                                onCropChange={setCrop}
                                onZoomChange={setZoom}
                                onCropComplete={(_, area) =>
                                    setCroppedAreaPixels(area)
                                }
                            />
                        </div>
                    ) : null}

                    {phase === "uploading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Transcoding and uploading…
                        </p>
                    ) : null}

                    {phase === "success" ? (
                        <Alert>
                            <AlertDescription>
                                Cropped video uploaded and tagged.
                            </AlertDescription>
                        </Alert>
                    ) : null}

                    {phase === "error" && error ? (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}
                </div>

                <SheetFooter className="flex-row justify-end gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        disabled={phase === "uploading"}
                    >
                        {phase === "success" ? "Done" : "Cancel"}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleUpload}
                        disabled={
                            phase !== "ready" ||
                            !croppedAreaPixels
                        }
                    >
                        Upload cropped copy
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
