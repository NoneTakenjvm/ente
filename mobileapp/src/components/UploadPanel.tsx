import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type JSX,
} from "react";
import { toast } from "sonner";
import { LocalUploadGrid, type LocalUploadItem } from "@/components/LocalUploadGrid";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core/instance";
import {
    beginUploadBatch,
    endUploadBatch,
} from "@/core/upload/upload-url-pool";
import { prepareLocalImage } from "@/lib/prepare-local-image";
import {
    ACCEPT_LOCAL_MEDIA,
    isUploadableLocalFile,
    isVideoFile,
    sanitizeUploadImageTitle,
    sanitizeUploadVideoTitle,
} from "@/lib/local-media";
import { isOrganizerConfigCollection } from "@/lib/organizer-config";
import { prepareLocalVideo } from "@/lib/transcode/prepare-local-video";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import { useUploadJobStore } from "@/stores/ui-store";
import type { Collection } from "ente-media/collection";

type PanelPhase = "idle" | "staging" | "review" | "uploading" | "done" | "error";

interface UploadPanelProps {
    onUploaded?: () => void;
}

interface StagedFile {
    id: string;
    file: File;
    previewUrl: string;
    kind: "image" | "video";
}

const UPLOAD_FOOTER_INSET_PX = 120;
const maxConcurrentUploads = 3;

const uploadableCollections = (collections: Collection[]): Collection[] =>
    collections.filter(
        (collection) =>
            collection.type !== "favorites" &&
            !isOrganizerConfigCollection(collection),
    );

const defaultUploadCollectionId = (
    albums: Collection[],
    activeCollectionId: number | null,
): number | undefined => {
    if (
        activeCollectionId !== null &&
        albums.some((album) => album.id === activeCollectionId)
    ) {
        return activeCollectionId;
    }
    const preferred = albums.find(
        (album) => album.type === "album" || album.type === "folder",
    );
    return preferred?.id ?? albums[0]?.id;
};

const localFileId = (file: File, index: number): string =>
    `${file.name}-${file.lastModified}-${file.size}-${index}`;

const revokeStagedFiles = (staged: StagedFile[]): void => {
    for (const entry of staged) {
        URL.revokeObjectURL(entry.previewUrl);
    }
};

const stageFilesAsync = async (
    files: File[],
    onProgress?: (done: number, total: number) => void,
): Promise<StagedFile[]> => {
    const staged: StagedFile[] = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        staged.push({
            id: localFileId(file, index),
            file,
            previewUrl: URL.createObjectURL(file),
            kind: isVideoFile(file) ? "video" : "image",
        });
        if (index % 16 === 15) {
            onProgress?.(index + 1, files.length);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    return staged;
};

interface FilePickButtonProps {
    children: string;
    disabled?: boolean;
    variant?: "default" | "outline";
    size?: "default" | "sm";
    onFilesChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * iOS Safari needs the file input overlaid on the tappable label — not sr-only,
 * not portaled, and not opened via programmatic .click().
 */
function FilePickButton({
    children,
    disabled = false,
    variant = "default",
    size = "default",
    onFilesChange,
}: FilePickButtonProps): JSX.Element {
    return (
        <label
            className={cn(
                buttonVariants({ variant, size }),
                "relative inline-flex cursor-pointer",
                disabled && "pointer-events-none opacity-50",
            )}
        >
            <input
                type="file"
                multiple
                accept={ACCEPT_LOCAL_MEDIA}
                disabled={disabled}
                className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                onChange={onFilesChange}
            />
            <span className="pointer-events-none">{children}</span>
        </label>
    );
}

export function UploadPanel({
    onUploaded,
}: UploadPanelProps): JSX.Element {
    const collections = useLibraryStore((s) => s.collections);
    const activeCollectionId = useLibraryStore((s) => s.activeCollectionId);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const uploadImageFile = useLibraryStore((s) => s.uploadImageFile);
    const uploadVideoFile = useLibraryStore((s) => s.uploadVideoFile);
    const setUploadJobStatus = useUploadJobStore((s) => s.setStatus);
    const setUploadJobProgress = useUploadJobStore((s) => s.setProgress);
    const resetUploadJob = useUploadJobStore((s) => s.resetJob);
    const panelOpen = useUploadJobStore((s) => s.panelOpen);
    const setPanelOpen = useUploadJobStore((s) => s.setPanelOpen);
    const requestCancel = useUploadJobStore((s) => s.requestCancel);

    const albums = useMemo(
        () => uploadableCollections(collections),
        [collections],
    );

    const selectedCollectionId = useMemo(
        (): number | undefined =>
            defaultUploadCollectionId(albums, activeCollectionId),
        [activeCollectionId, albums],
    );

    const [phase, setPhase] = useState<PanelPhase>("idle");
    const [error, setError] = useState<string | undefined>();
    const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [stagingProgress, setStagingProgress] = useState<{ current: number; total: number }>({
        current: 0,
        total: 0,
    });
    const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number }>({
        current: 0,
        total: 0,
    });
    const [resultMessage, setResultMessage] = useState<string | undefined>();
    const stagedFilesRef = useRef<StagedFile[]>([]);
    const stagingGenerationRef = useRef<number>(0);
    const uploadStartedRef = useRef<boolean>(false);

    const staging = phase === "staging";
    const uploading = phase === "uploading";

    useEffect(() => {
        stagedFilesRef.current = stagedFiles;
    }, [stagedFiles]);

    useEffect(() => {
        return (): void => {
            if (!uploadStartedRef.current) {
                revokeStagedFiles(stagedFilesRef.current);
            }
        };
    }, []);

    const runUpload = useCallback(
        async (filesToUpload: StagedFile[]): Promise<void> => {
            if (
                selectedCollectionId === undefined ||
                filesToUpload.length === 0 ||
                uploadStartedRef.current
            ) {
                return;
            }

            uploadStartedRef.current = true;
            useUploadJobStore.setState({ cancelRequested: false });
            setPhase("uploading");
            setError(undefined);
            setResultMessage(undefined);
            setUploadProgress({ current: 0, total: filesToUpload.length });
            setUploadJobStatus("running");
            setUploadJobProgress(0, filesToUpload.length);

            let completed = 0;
            let failed = 0;
            const errors: string[] = [];
            let nextIndex = 0;

            const uploadStagedFile = async (entry: StagedFile): Promise<void> => {
                if (entry.kind === "video") {
                    const prepared = await prepareLocalVideo(entry.file);
                    await uploadVideoFile(
                        selectedCollectionId,
                        prepared.bytes,
                        {
                            width: prepared.width,
                            height: prepared.height,
                        },
                        prepared.duration,
                        sanitizeUploadVideoTitle(entry.file.name),
                        entry.file.lastModified * 1000,
                        prepared.mimeType,
                    );
                    return;
                }

                const prepared = await prepareLocalImage(entry.file);
                await uploadImageFile(
                    selectedCollectionId,
                    prepared.bytes,
                    {
                        width: prepared.width,
                        height: prepared.height,
                    },
                    sanitizeUploadImageTitle(entry.file.name),
                    entry.file.lastModified * 1000,
                );
            };

            const reportFileFinished = (): void => {
                const finished = completed + failed;
                setUploadProgress({ current: finished, total: filesToUpload.length });
                setUploadJobProgress(finished, filesToUpload.length);
            };

            const worker = async (): Promise<void> => {
                while (true) {
                    if (useUploadJobStore.getState().cancelRequested) {
                        return;
                    }
                    const index = nextIndex;
                    nextIndex += 1;
                    if (index >= filesToUpload.length) {
                        return;
                    }
                    const entry = filesToUpload[index]!;
                    try {
                        await uploadStagedFile(entry);
                        completed += 1;
                    } catch (uploadError: unknown) {
                        failed += 1;
                        errors.push(
                            uploadError instanceof Error ?
                                `${entry.file.name}: ${uploadError.message}` :
                                `${entry.file.name}: upload failed`,
                        );
                    }
                    reportFileFinished();
                }
            };

            try {
                await beginUploadBatch(
                    getEnteCore().getHttpClient(),
                    filesToUpload.length,
                );

                const workerCount = Math.min(
                    maxConcurrentUploads,
                    filesToUpload.length,
                );
                await Promise.all(
                    Array.from({ length: workerCount }, () => worker()),
                );

                const cancelled = useUploadJobStore.getState().cancelRequested;
                const skipped = filesToUpload.length - completed - failed;

                if (cancelled) {
                    setPhase("done");
                    setResultMessage(
                        completed > 0 ?
                            `Cancelled after ${completed} upload${completed === 1 ? "" : "s"}. ${skipped} skipped.` :
                            "Upload cancelled.",
                    );
                    toast.message("Upload cancelled");
                    return;
                }

                if (failed === 0) {
                    setPhase("done");
                    setResultMessage(
                        `Uploaded ${completed} file${completed === 1 ? "" : "s"}.`,
                    );
                    toast.success(
                        `Uploaded ${completed} file${completed === 1 ? "" : "s"}`,
                    );
                    onUploaded?.();
                    return;
                }

                setPhase("error");
                setError(errors[0]);
                setResultMessage(
                    `Uploaded ${completed} · ${failed} failed`,
                );
                toast.error(errors[0] ?? "Some uploads failed");
            } finally {
                endUploadBatch();
                resetUploadJob();
                uploadStartedRef.current = false;
            }
        },
        [
            onUploaded,
            resetUploadJob,
            selectedCollectionId,
            setUploadJobProgress,
            setUploadJobStatus,
            uploadImageFile,
            uploadVideoFile,
        ],
    );

    const handleFilesChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            const picked = event.target.files;
            const rawFiles = picked?.length ? Array.from(picked) : [];
            event.target.value = "";

            const files = rawFiles.filter(isUploadableLocalFile);
            const skipped = rawFiles.length - files.length;

            if (!files.length) {
                if (skipped > 0) {
                    toast.error("Only photos and videos can be uploaded");
                }
                return;
            }
            if (selectedCollectionId === undefined) {
                toast.error("No Ente album available to upload into yet");
                return;
            }

            const generation = ++stagingGenerationRef.current;

            toast.message(
                `Selected ${files.length} file${files.length === 1 ? "" : "s"}…`,
            );
            if (skipped > 0) {
                toast.message(`Skipped ${skipped} unsupported file${skipped === 1 ? "" : "s"}`);
            }

            setError(undefined);
            setResultMessage(undefined);
            setPhase("staging");
            setStagingProgress({ current: 0, total: files.length });

            void stageFilesAsync(files, (current, total) => {
                if (generation !== stagingGenerationRef.current) {
                    return;
                }
                setStagingProgress({ current, total });
            })
                .then((nextStaged) => {
                    if (generation !== stagingGenerationRef.current) {
                        revokeStagedFiles(nextStaged);
                        return;
                    }

                    const existingIds = new Set(
                        stagedFilesRef.current.map((entry) => entry.id),
                    );
                    const newStaged = nextStaged.filter(
                        (entry) => !existingIds.has(entry.id),
                    );
                    for (const entry of nextStaged) {
                        if (existingIds.has(entry.id)) {
                            URL.revokeObjectURL(entry.previewUrl);
                        }
                    }

                    const merged = [...stagedFilesRef.current, ...newStaged];
                    setStagedFiles(merged);
                    setSelectedIds(new Set(merged.map((entry) => entry.id)));
                    setPhase("review");
                    void runUpload(merged);
                })
                .catch((stagingError: unknown) => {
                    if (generation !== stagingGenerationRef.current) {
                        return;
                    }
                    const message =
                        stagingError instanceof Error ?
                            stagingError.message :
                            "Could not prepare selected files";
                    setPhase(stagedFilesRef.current.length > 0 ? "review" : "idle");
                    setError(message);
                    toast.error(message);
                });
        },
        [runUpload, selectedCollectionId],
    );

    const toggleFile = useCallback((id: string): void => {
        if (staging || uploading) {
            return;
        }
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, [staging, uploading]);

    const selectMany = useCallback((ids: string[], mode: "add" | "toggle"): void => {
        if (staging || uploading) {
            return;
        }
        setSelectedIds((current) => {
            const next = new Set(current);
            for (const id of ids) {
                if (mode === "add") {
                    next.add(id);
                } else if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
            }
            return next;
        });
    }, [staging, uploading]);

    const stagedIds = useMemo(
        () => new Set(stagedFiles.map((entry) => entry.id)),
        [stagedFiles],
    );

    const activeSelectedIds = useMemo(() => {
        const next = new Set<string>();
        for (const id of selectedIds) {
            if (stagedIds.has(id)) {
                next.add(id);
            }
        }
        return next;
    }, [selectedIds, stagedIds]);

    const selectedFiles = useMemo(
        () => stagedFiles.filter((entry) => activeSelectedIds.has(entry.id)),
        [activeSelectedIds, stagedFiles],
    );

    const gridItems: LocalUploadItem[] = useMemo(
        () =>
            stagedFiles.map((entry) => ({
                id: entry.id,
                previewUrl: entry.previewUrl,
                label: entry.file.name,
                kind: entry.kind,
            })),
        [stagedFiles],
    );

    const allSelected =
        stagedFiles.length > 0 &&
        stagedFiles.every((entry) => activeSelectedIds.has(entry.id));

    const toggleAll = (): void => {
        if (staging || uploading) {
            return;
        }
        setSelectedIds(
            allSelected ?
                new Set() :
                new Set(stagedFiles.map((entry) => entry.id)),
        );
    };

    const handleManualUpload = useCallback((): void => {
        void runUpload(selectedFiles);
    }, [runUpload, selectedFiles]);

    const handleClose = useCallback((): void => {
        if (staging) {
            return;
        }
        if (!uploading) {
            stagingGenerationRef.current += 1;
            uploadStartedRef.current = false;
            revokeStagedFiles(stagedFiles);
            setStagedFiles([]);
            setSelectedIds(new Set());
            useUploadJobStore.getState().reset();
        }
        setPanelOpen(false);
    }, [setPanelOpen, staging, stagedFiles, uploading]);

    const handleCancelUpload = useCallback((): void => {
        if (!uploading) {
            return;
        }
        requestCancel();
    }, [requestCancel, uploading]);

    const handleSheetOpenChange = useCallback(
        (nextOpen: boolean): void => {
            if (nextOpen) {
                setPanelOpen(true);
                return;
            }
            handleClose();
        },
        [handleClose, setPanelOpen],
    );

    const gridSelection = useMemo(
        () => ({
            selectedIds: activeSelectedIds,
            onToggle: toggleFile,
            onSelectMany: selectMany,
            disabled: staging || uploading,
        }),
        [activeSelectedIds, selectMany, staging, toggleFile, uploading],
    );

    const albumsLoading =
        albums.length === 0 &&
        (syncStatus === "syncing" || syncStatus === "loadingFromCache");

    const canPick =
        selectedCollectionId !== undefined &&
        albums.length > 0 &&
        !staging &&
        !uploading &&
        !albumsLoading;

    const canManualUpload =
        phase === "review" &&
        activeSelectedIds.size > 0 &&
        !staging &&
        !uploading;

    const progressPercent =
        uploadProgress.total > 0 ?
            Math.round((uploadProgress.current / uploadProgress.total) * 100) :
            0;

    const stagingPercent =
        stagingProgress.total > 0 ?
            Math.round((stagingProgress.current / stagingProgress.total) * 100) :
            0;

    const closeLabel =
        phase === "done" ?
            "Done" :
            uploading ?
                "Close" :
                "Cancel";

    return (
        <Sheet open={panelOpen} onOpenChange={handleSheetOpenChange}>
            <SheetContent
                side="bottom"
                showCloseButton={false}
                className="flex h-[92dvh] max-h-[92dvh] flex-col gap-0 overflow-hidden rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)]"
            >
                <SheetHeader className="shrink-0 px-4 pt-4">
                    <SheetTitle>
                        {uploading ?
                            "Uploading" :
                            phase === "done" ?
                                "Upload complete" :
                                "Upload photos & videos"}
                    </SheetTitle>
                    <SheetDescription>
                        {phase === "idle" ?
                            "Choose photos or videos from your device. Upload starts automatically after you confirm in the picker." :
                            staging ?
                                "Preparing your selection…" :
                                uploading ?
                                    "Tap Close to hide this panel, or Cancel upload to stop. Tap the progress bar at the top to reopen." :
                                    "Tap thumbnails to exclude files before uploading again."}
                    </SheetDescription>
                </SheetHeader>

                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3">
                    {albumsLoading ? (
                        <p className="text-sm text-muted-foreground">
                            Loading your library…
                        </p>
                    ) : albums.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No Ente album found to upload into yet.
                        </p>
                    ) : (
                        <p className="shrink-0 text-sm text-muted-foreground">
                            Photos and videos are added to your Media library and
                            appear in All photos. Tag and organise them here after
                            upload.
                        </p>
                    )}

                    {staging ? (
                        <div className="flex flex-col gap-3 py-2">
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                Preparing {stagingProgress.total} file
                                {stagingProgress.total === 1 ? "" : "s"}…
                            </p>
                            {stagingProgress.total > 0 ? (
                                <Progress value={stagingPercent} />
                            ) : null}
                        </div>
                    ) : null}

                    {stagedFiles.length > 0 &&
                    (phase === "review" || uploading || phase === "done" || phase === "error") ? (
                            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                                <p className="text-xs text-muted-foreground">
                                    {stagedFiles.length} file
                                    {stagedFiles.length === 1 ? "" : "s"}
                                    {uploading ?
                                        ` · uploading ${uploadProgress.current}/${uploadProgress.total}` :
                                        ` · ${activeSelectedIds.size} selected`}
                                </p>
                                {phase === "review" ? (
                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            disabled={staging || uploading || stagedFiles.length === 0}
                                            onClick={toggleAll}
                                        >
                                            {allSelected ? "Deselect all" : "Select all"}
                                        </Button>
                                        <FilePickButton
                                            variant="outline"
                                            size="sm"
                                            disabled={!canPick}
                                            onFilesChange={handleFilesChange}
                                        >
                                            Add more
                                        </FilePickButton>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                    {(phase === "review" || uploading) && stagedFiles.length > 0 ? (
                        <LocalUploadGrid
                            items={gridItems}
                            selection={gridSelection}
                            footerInsetPx={UPLOAD_FOOTER_INSET_PX}
                        />
                    ) : null}

                    {uploading ? (
                        <div className="flex flex-col gap-3 py-2">
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                Encrypting and uploading {uploadProgress.current} of{" "}
                                {uploadProgress.total}…
                            </p>
                            <Progress value={progressPercent} />
                        </div>
                    ) : null}

                    {resultMessage ? (
                        <Alert className="shrink-0">
                            <AlertDescription>{resultMessage}</AlertDescription>
                        </Alert>
                    ) : null}

                    {phase === "error" && error ? (
                        <Alert variant="destructive" className="shrink-0">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}
                </div>

                <SheetFooter className="sticky bottom-0 shrink-0 flex-row justify-end gap-2 border-t bg-popover px-4 py-3">
                    {uploading ? (
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={handleCancelUpload}
                        >
                            Cancel upload
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleClose}
                        disabled={staging}
                    >
                        {closeLabel}
                    </Button>
                    {phase === "idle" || staging ? (
                        <>
                            <FilePickButton
                                disabled={!canPick}
                                onFilesChange={handleFilesChange}
                            >
                                Choose files
                            </FilePickButton>
                            {stagedFiles.length > 0 ? (
                                <Button
                                    type="button"
                                    onClick={handleManualUpload}
                                    disabled={!canManualUpload}
                                >
                                    Upload {activeSelectedIds.size} file
                                    {activeSelectedIds.size === 1 ? "" : "s"}
                                </Button>
                            ) : null}
                        </>
                    ) : phase === "review" ? (
                        <Button
                            type="button"
                            onClick={handleManualUpload}
                            disabled={!canManualUpload}
                        >
                            Upload {activeSelectedIds.size} file
                            {activeSelectedIds.size === 1 ? "" : "s"}
                        </Button>
                    ) : null}
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
