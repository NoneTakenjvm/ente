import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type JSX,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { DEFAULT_JPEG_QUALITY, encodeJpegFromBytes } from "@/lib/compress";
import { useLibraryStore } from "@/stores/library-store";
import type { Collection } from "ente-media/collection";

type PanelPhase = "idle" | "reading" | "uploading" | "success" | "error";

interface UploadPanelProps {
    onClose: () => void;
    onUploaded?: () => void;
}

const uploadableCollections = (collections: Collection[]): Collection[] =>
    collections.filter((collection) => collection.type !== "favorites");

const sanitizeUploadTitle = (fileName: string): string => {
    const trimmed = fileName.trim() || "upload";
    const safe = trimmed.replace(/[^\w.\- ]+/gu, "").trim() || "upload";
    if (/\.jpe?g$/iu.test(safe)) {
        return safe;
    }
    const base = safe.replace(/\.[^.]+$/u, "") || "upload";
    return `${base}.jpg`;
};

export function UploadPanel({
    onClose,
    onUploaded,
}: UploadPanelProps): JSX.Element {
    const collections = useLibraryStore((s) => s.collections);
    const uploadImageFile = useLibraryStore((s) => s.uploadImageFile);

    const albums = useMemo(
        () => uploadableCollections(collections),
        [collections],
    );

    const defaultCollectionId = useMemo((): number | undefined => {
        return albums[0]?.id;
    }, [albums]);

    const [phase, setPhase] = useState<PanelPhase>("idle");
    const [error, setError] = useState<string | undefined>();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const selectedCollectionId = defaultCollectionId;

    const busy = phase === "uploading" || phase === "reading";

    const handlePickFile = useCallback((): void => {
        fileInputRef.current?.click();
    }, []);

    const handleFileChange = useCallback(
        (event: ChangeEvent<HTMLInputElement>): void => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file || selectedCollectionId === undefined) {
                return;
            }

            setPhase("reading");
            setError(undefined);

            void file.arrayBuffer()
                .then(async (buffer) => {
                    const bytes = new Uint8Array(buffer);
                    const encoded = await encodeJpegFromBytes(
                        bytes,
                        DEFAULT_JPEG_QUALITY,
                    );
                    setPhase("uploading");
                    await uploadImageFile(
                        selectedCollectionId,
                        encoded.bytes,
                        {
                            width: encoded.width,
                            height: encoded.height,
                        },
                        sanitizeUploadTitle(file.name),
                        file.lastModified * 1000,
                    );
                    setPhase("success");
                    onUploaded?.();
                })
                .catch((uploadError: unknown) => {
                    setPhase("error");
                    setError(
                        uploadError instanceof Error ?
                            uploadError.message :
                            "Upload failed",
                    );
                });
        },
        [onUploaded, selectedCollectionId, uploadImageFile],
    );

    const canUpload =
        !busy &&
        selectedCollectionId !== undefined &&
        albums.length > 0;

    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open && !busy) {
                    onClose();
                }
            }}
        >
            <SheetContent
                side="bottom"
                className="max-h-[90dvh] overflow-y-auto rounded-t-xl"
            >
                <SheetHeader>
                    <SheetTitle>Upload photo</SheetTitle>
                    <SheetDescription>
                        Select an image to encrypt and upload to your library.
                    </SheetDescription>
                </SheetHeader>

                <div className="flex flex-col gap-4 px-4">
                    {albums.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No albums available to upload into.
                        </p>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            Uploads go to{" "}
                            <span className="font-medium text-foreground">
                                {albums.find((a) => a.id === selectedCollectionId)?.name ??
                                    albums[0]?.name}
                            </span>
                        </p>
                    )}

                    {phase === "reading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            Reading image…
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
                            <AlertDescription>Photo uploaded.</AlertDescription>
                        </Alert>
                    ) : null}
                    {phase === "error" && error ? (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}

                    <input
                        ref={fileInputRef}
                        className="sr-only"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleFileChange}
                    />
                </div>

                <SheetFooter className="flex-row justify-end gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        disabled={busy}
                    >
                        {phase === "success" ? "Done" : "Cancel"}
                    </Button>
                    <Button
                        type="button"
                        onClick={handlePickFile}
                        disabled={!canUpload}
                    >
                        Choose image
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
