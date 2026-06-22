import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { Settings } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import {
    DEFAULT_JPEG_QUALITY,
    DEFAULT_VIDEO_CRF,
    encodeJpegFromBytes,
    formatSizeDelta,
    isWorthReplacing,
    MAX_JPEG_QUALITY,
    MIN_JPEG_QUALITY,
    MAX_VIDEO_CRF,
    MIN_VIDEO_CRF,
    type SizeDelta,
} from "@/lib/compress";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import { compressMediaBytes } from "@/lib/transcode/compress-media";
import { useLibraryStore } from "@/stores/library-store";
import type { EnteFile } from "ente-media/file";

type PanelPhase =
    "loading" |
    "encoding" |
    "ready" |
    "uploading" |
    "success" |
    "error";

interface CompressionPanelProps {
    file: EnteFile;
    onClose: () => void;
    onUploaded?: (file: EnteFile) => void;
}

export function CompressionPanel({
    file,
    onClose,
    onUploaded,
}: CompressionPanelProps): JSX.Element {
    const compressAndUploadFile = useLibraryStore((s) => s.compressAndUploadFile);
    const compressAndUploadMedia = useLibraryStore((s) => s.compressAndUploadMedia);

    const mediaKind = mediaKindForFile(file);
    const usesFfmpeg = mediaKind === "gif" || mediaKind === "video";

    const [phase, setPhase] = useState<PanelPhase>("loading");
    const [quality, setQuality] = useState<number>(DEFAULT_JPEG_QUALITY);
    const [videoCrf, setVideoCrf] = useState<number>(DEFAULT_VIDEO_CRF);
    const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
    const [originalBytes, setOriginalBytes] = useState<Uint8Array | undefined>();
    const [compressedBytes, setCompressedBytes] = useState<Uint8Array | undefined>();
    const [dimensions, setDimensions] = useState<
        { width: number; height: number } | undefined
    >();
    const [originalUrl, setOriginalUrl] = useState<string | undefined>();
    const [compressedUrl, setCompressedUrl] = useState<string | undefined>();
    const [uploadPhase, setUploadPhase] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();

    const encodeRequestId = useRef<number>(0);

    const sizeDelta: SizeDelta | undefined = useMemo(() => {
        if (!originalBytes || !compressedBytes) {
            return undefined;
        }
        return formatSizeDelta(originalBytes.length, compressedBytes.length);
    }, [originalBytes, compressedBytes]);

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
                    new Blob([Uint8Array.from(bytes)], {
                        type: mimeTypeForFile(file),
                    }),
                );
                setOriginalBytes(bytes);
                setOriginalUrl(objectUrl);
                setPhase("encoding");
            } catch {
                if (!cancelled) {
                    setPhase("error");
                    setError("Could not load the original file.");
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
        if (!originalBytes) {
            return;
        }

        const requestId = ++encodeRequestId.current;
        let cancelled = false;

        const runEncode = async (): Promise<void> => {
            setPhase("encoding");
            setError(undefined);
            try {
                const result = usesFfmpeg ?
                    await compressMediaBytes(file, originalBytes, {
                        quality,
                        videoCrf,
                    }) :
                    await encodeJpegFromBytes(originalBytes, quality);

                if (cancelled || requestId !== encodeRequestId.current) {
                    return;
                }

                const bytes = result.bytes;
                setCompressedBytes(bytes);
                setDimensions({
                    width: result.width,
                    height: result.height,
                });
                setCompressedUrl((prev) => {
                    if (prev) {
                        URL.revokeObjectURL(prev);
                    }
                    const mimeType = usesFfmpeg ?
                        (result as { mimeType?: string }).mimeType ??
                            mimeTypeForFile(file) :
                        "image/jpeg";
                    return URL.createObjectURL(
                        new Blob([Uint8Array.from(bytes)], { type: mimeType }),
                    );
                });
                setPhase("ready");
            } catch (encodeError) {
                if (cancelled || requestId !== encodeRequestId.current) {
                    return;
                }
                setPhase("error");
                setError(
                    encodeError instanceof Error ?
                        encodeError.message :
                        "Could not encode preview",
                );
            }
        };

        void runEncode();

        return (): void => {
            cancelled = true;
        };
    }, [file, originalBytes, quality, usesFfmpeg, videoCrf]);

    useEffect(() => {
        return (): void => {
            if (compressedUrl) {
                URL.revokeObjectURL(compressedUrl);
            }
        };
    }, [compressedUrl]);

    const handleUpload = useCallback((): void => {
        setPhase("uploading");
        setUploadPhase("Encrypting and uploading…");
        setError(undefined);

        const uploadPromise = usesFfmpeg ?
            compressAndUploadMedia(file.id, { quality, videoCrf }) :
            compressAndUploadFile(
                file.id,
                compressedBytes!,
                dimensions!,
            );

        void uploadPromise
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
    }, [
        compressedBytes,
        compressAndUploadFile,
        compressAndUploadMedia,
        dimensions,
        file.id,
        onUploaded,
        quality,
        usesFfmpeg,
        videoCrf,
    ]);

    const qualityPercent = Math.round(quality * 100);
    const settingsSummary =
        mediaKind === "video" ?
            `Video CRF ${videoCrf}` :
            `JPEG quality ${qualityPercent}%`;

    const previewFrameClassName =
        "flex min-h-48 w-full items-center justify-center rounded-md bg-muted";

    return (
        <>
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
                        <SheetTitle>Compress media</SheetTitle>
                    </SheetHeader>

                    <div className="flex flex-col gap-4 px-4">
                        {phase === "loading" ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                Loading original…
                            </p>
                        ) : null}

                        {usesFfmpeg && phase === "encoding" && !originalUrl ? (
                            <p className="text-sm text-muted-foreground">
                                Loading encoder…
                            </p>
                        ) : null}

                        {phase === "error" && error ? (
                            <Alert variant="destructive">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        ) : null}

                        {originalUrl ? (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        Before
                                    </span>
                                    <div className={previewFrameClassName}>
                                        {mediaKind === "video" ? (
                                            <video
                                                className="max-h-48 max-w-full object-contain"
                                                src={originalUrl}
                                                muted
                                                playsInline
                                            />
                                        ) : (
                                            <img
                                                className="max-h-48 max-w-full object-contain"
                                                src={originalUrl}
                                                alt="Original"
                                            />
                                        )}
                                    </div>
                                    {sizeDelta ? (
                                        <span className="text-xs text-muted-foreground">
                                            {sizeDelta.originalLabel}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        After
                                    </span>
                                    <div className={previewFrameClassName}>
                                        {compressedUrl ? (
                                            mediaKind === "video" ? (
                                                <video
                                                    className="max-h-48 max-w-full object-contain"
                                                    src={compressedUrl}
                                                    muted
                                                    playsInline
                                                />
                                            ) : (
                                                <img
                                                    className="max-h-48 max-w-full object-contain"
                                                    src={compressedUrl}
                                                    alt="Compressed preview"
                                                />
                                            )
                                        ) : (
                                            <Skeleton className="h-40 w-full max-w-full" />
                                        )}
                                    </div>
                                    {sizeDelta ? (
                                        <span className="text-xs text-muted-foreground">
                                            {sizeDelta.compressedLabel}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {sizeDelta && phase !== "loading" ? (
                            <p className="text-sm text-muted-foreground">
                                {isWorthReplacing(
                                    sizeDelta.originalBytes,
                                    sizeDelta.compressedBytes,
                                ) ?
                                    <>
                                        Saves {sizeDelta.savedLabel} (
                                        {sizeDelta.savedPercent}%)
                                    </> :
                                    "Compressed output is larger — replace is disabled."}
                            </p>
                        ) : null}

                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">
                                {settingsSummary}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={phase === "uploading"}
                                onClick={() => setSettingsOpen(true)}
                            >
                                <Settings className="size-4" />
                                Settings
                            </Button>
                        </div>

                        {phase === "encoding" ? (
                            <p className="text-sm text-muted-foreground">
                                Updating preview…
                            </p>
                        ) : null}

                        {phase === "uploading" && uploadPhase ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                {uploadPhase}
                            </p>
                        ) : null}

                        {phase === "success" ? (
                            <Alert>
                                <AlertDescription>
                                    Original replaced with compressed version.
                                </AlertDescription>
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
                                (!usesFfmpeg && (!compressedBytes || !dimensions)) ||
                                (sizeDelta !== undefined &&
                                    !isWorthReplacing(
                                        sizeDelta.originalBytes,
                                        sizeDelta.compressedBytes,
                                    ))
                            }
                        >
                            Compress and replace
                        </Button>
                    </SheetFooter>
                </SheetContent>
            </Sheet>

            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Compression settings</DialogTitle>
                    </DialogHeader>
                    {mediaKind !== "video" ? (
                        <Field>
                            <FieldLabel>Quality {qualityPercent}%</FieldLabel>
                            <Slider
                                min={MIN_JPEG_QUALITY * 100}
                                max={MAX_JPEG_QUALITY * 100}
                                value={[qualityPercent]}
                                disabled={phase === "uploading" || !originalBytes}
                                onValueChange={(value) => {
                                    const next = Array.isArray(value) ?
                                        value[0] :
                                        value;
                                    if (next !== undefined) {
                                        setQuality(next / 100);
                                    }
                                }}
                            />
                        </Field>
                    ) : (
                        <Field>
                            <FieldLabel>Video CRF {videoCrf}</FieldLabel>
                            <Slider
                                min={MIN_VIDEO_CRF}
                                max={MAX_VIDEO_CRF}
                                value={[videoCrf]}
                                disabled={phase === "uploading" || !originalBytes}
                                onValueChange={(value) => {
                                    const next = Array.isArray(value) ?
                                        value[0] :
                                        value;
                                    if (next !== undefined) {
                                        setVideoCrf(next);
                                    }
                                }}
                            />
                        </Field>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            onClick={() => setSettingsOpen(false)}
                        >
                            Done
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
