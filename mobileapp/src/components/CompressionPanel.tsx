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
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
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
import {
    DEFAULT_VIDEO_CRF,
    formatSizeDelta,
    isWorthReplacing,
    MAX_VIDEO_CRF,
    MIN_SIZE_FILTER_PRESETS,
    MIN_VIDEO_CRF,
    readCompressMinSizeBytes,
    writeCompressMinSizeBytes,
    CompressionSkippedError,
    type SizeDelta,
} from "@/lib/compress";
import { loadMediaBytesForEdit } from "@/lib/load-media-bytes";
import { mediaKindForFile, mimeTypeForFile } from "@/lib/media-kind";
import {
    compressMediaBytes,
    VIDEO_COMPRESS_PREVIEW_MAX_LONG_EDGE,
    type CompressMediaResult,
} from "@/lib/transcode/compress-media";
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
    const compressAndReplaceMediaOptimistic = useLibraryStore(
        (s) => s.compressAndReplaceMediaOptimistic,
    );

    const mediaKind = mediaKindForFile(file);
    const usesFfmpeg = mediaKind === "gif" || mediaKind === "video";

    const [phase, setPhase] = useState<PanelPhase>("loading");
    const [videoCrf, setVideoCrf] = useState<number>(DEFAULT_VIDEO_CRF);
    const [minSizeBytes, setMinSizeBytes] = useState<number>(
        readCompressMinSizeBytes,
    );
    const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
    const [originalBytes, setOriginalBytes] = useState<Uint8Array | undefined>();
    const [compressedResult, setCompressedResult] = useState<
        CompressMediaResult | undefined
    >();
    const [originalUrl, setOriginalUrl] = useState<string | undefined>();
    const [compressedUrl, setCompressedUrl] = useState<string | undefined>();
    const [encodeProgress, setEncodeProgress] = useState<number | undefined>();
    const [error, setError] = useState<string | undefined>();

    const encodeRequestId = useRef<number>(0);

    const sizeDelta: SizeDelta | undefined = useMemo(() => {
        if (!originalBytes || !compressedResult) {
            return undefined;
        }
        return formatSizeDelta(
            originalBytes.length,
            compressedResult.bytes.length,
        );
    }, [originalBytes, compressedResult]);

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;

        const loadOriginal = async (): Promise<void> => {
            try {
                const bytes = await loadMediaBytesForEdit(file);
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
            setEncodeProgress(undefined);
            setError(undefined);
            try {
                const result = await compressMediaBytes(file, originalBytes, {
                    videoCrf,
                    minSizeBytes,
                    maxLongEdge:
                        mediaKind === "video" ?
                            VIDEO_COMPRESS_PREVIEW_MAX_LONG_EDGE :
                            undefined,
                    onProgress: (ratio) => {
                        if (
                            cancelled ||
                            requestId !== encodeRequestId.current
                        ) {
                            return;
                        }
                        setEncodeProgress(Math.round(ratio * 100));
                    },
                });

                if (cancelled || requestId !== encodeRequestId.current) {
                    return;
                }

                setCompressedResult(result);
                setCompressedUrl((prev) => {
                    if (prev) {
                        URL.revokeObjectURL(prev);
                    }
                    return URL.createObjectURL(
                        new Blob([Uint8Array.from(result.bytes)], {
                            type: result.mimeType,
                        }),
                    );
                });
                setEncodeProgress(100);
                setPhase("ready");
            } catch (encodeError) {
                if (cancelled || requestId !== encodeRequestId.current) {
                    return;
                }
                setCompressedResult(undefined);
                setPhase("error");
                setError(
                    encodeError instanceof CompressionSkippedError ?
                        "Already under the minimum file size — skipped." :
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
    }, [file, mediaKind, minSizeBytes, originalBytes, videoCrf]);

    useEffect(() => {
        return (): void => {
            if (compressedUrl) {
                URL.revokeObjectURL(compressedUrl);
            }
        };
    }, [compressedUrl]);

    const handleUpload = useCallback((): void => {
        if (!originalBytes || !compressedResult) {
            return;
        }
        setPhase("uploading");
        setError(undefined);

        try {
            const { optimisticFile, finalize } =
                compressAndReplaceMediaOptimistic(
                    file.id,
                    compressedResult,
                    originalBytes.length,
                );
            onUploaded?.(optimisticFile);
            setPhase("success");
            void finalize.catch((uploadError: unknown) => {
                setPhase("error");
                setError(
                    uploadError instanceof Error ?
                        uploadError.message :
                        "Upload failed",
                );
            });
        } catch (uploadError: unknown) {
            setPhase("error");
            setError(
                uploadError instanceof Error ?
                    uploadError.message :
                    "Upload failed",
            );
        }
    }, [
        compressAndReplaceMediaOptimistic,
        compressedResult,
        file.id,
        onUploaded,
        originalBytes,
    ]);

    const minSizePreset = MIN_SIZE_FILTER_PRESETS.find(
        (preset) => preset.bytes === minSizeBytes,
    ) ?? MIN_SIZE_FILTER_PRESETS[0]!;
    const settingsSummary =
        mediaKind === "video" ?
            `Video CRF ${videoCrf}` :
            `Skip under ${minSizePreset.label.replace(/\+$/u, "")}`;

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
                            <div className="flex flex-col gap-2">
                                <p className="text-sm text-muted-foreground">
                                    Encoding preview…
                                    {encodeProgress !== undefined ?
                                        ` ${encodeProgress}%` :
                                        ""}
                                </p>
                                {encodeProgress !== undefined ? (
                                    <Progress
                                        value={encodeProgress}
                                        className="w-full"
                                    />
                                ) : (
                                    <div className="h-1.5 w-full animate-pulse rounded-full bg-primary/50" />
                                )}
                            </div>
                        ) : null}

                        {phase === "uploading" ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                Starting upload…
                            </p>
                        ) : null}

                        {phase === "success" ? (
                            <Alert>
                                <AlertDescription>
                                    {usesFfmpeg ?
                                        "Compressed version ready — uploading in the background." :
                                        "Original replaced with compressed version."}
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
                                !compressedResult ||
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
                            <FieldLabel>Minimum file size</FieldLabel>
                            <Select
                                value={String(minSizeBytes)}
                                disabled={phase === "uploading"}
                                onValueChange={(value) => {
                                    const next = Number(value);
                                    setMinSizeBytes(next);
                                    writeCompressMinSizeBytes(next);
                                }}
                            >
                                <SelectTrigger>
                                    <SelectValue>{minSizePreset.label}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {MIN_SIZE_FILTER_PRESETS.map((preset) => (
                                        <SelectItem
                                            key={preset.bytes}
                                            value={String(preset.bytes)}
                                        >
                                            {preset.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
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
