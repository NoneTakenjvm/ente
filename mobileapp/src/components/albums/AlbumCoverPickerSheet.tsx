import { useCallback, useMemo, useState, type JSX } from "react";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import type { EnteFile } from "ente-media/file";

interface AlbumCoverPickerSheetProps {
    open: boolean;
    files: EnteFile[];
    selectedFileId: number | undefined;
    onOpenChange: (open: boolean) => void;
    onSelect: (fileId: number) => void;
}

export function AlbumCoverPickerSheet({
    open,
    files,
    selectedFileId,
    onOpenChange,
    onSelect,
}: AlbumCoverPickerSheetProps): JSX.Element {
    const [draftId, setDraftId] = useState<number | undefined>(selectedFileId);

    const handleOpenChange = (nextOpen: boolean): void => {
        if (nextOpen) {
            setDraftId(selectedFileId);
        }
        onOpenChange(nextOpen);
    };

    const selection = useMemo(
        () => ({
            selectedIds: draftId !== undefined ? new Set([draftId]) : new Set<number>(),
            onToggle: (file: EnteFile): void => {
                setDraftId(file.id);
            },
        }),
        [draftId],
    );

    const handleConfirm = useCallback((): void => {
        if (draftId !== undefined) {
            onSelect(draftId);
        }
        onOpenChange(false);
    }, [draftId, onOpenChange, onSelect]);

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent
                side="bottom"
                className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden rounded-t-xl p-0"
            >
                <SheetHeader className="shrink-0 border-b border-border px-4 py-3 text-left">
                    <SheetTitle>Album thumbnail</SheetTitle>
                    <SheetDescription>
                        Choose a photo from this album.
                    </SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 overflow-hidden">
                    <ThumbnailGrid
                        files={files}
                        selection={selection}
                        footerInsetPx={72}
                    />
                </div>
                <div className="shrink-0 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                    <Button
                        type="button"
                        className="w-full"
                        disabled={draftId === undefined}
                        onClick={handleConfirm}
                    >
                        Use this photo
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
}
