import type { JSX } from "react";
import { ThumbnailImage } from "@/components/ThumbnailImage";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import type { TagHelperLogEntry } from "@/stores/tag-helper-store";

interface TagHelperLogProps {
    open: boolean;
    /** Newest first. */
    entries: readonly TagHelperLogEntry[];
    onOpenChange: (open: boolean) => void;
    onUndo: (entry: TagHelperLogEntry) => void;
}

/**
 * Session log of the tags the Tag Helper added, each with Undo. A bottom sheet
 * on touch screens and a right-hand sheet elsewhere.
 */
export function TagHelperLog({
    open,
    entries,
    onOpenChange,
    onUndo,
}: TagHelperLogProps): JSX.Element {
    const isCoarsePointer = useCoarsePointer();
    const allFiles = useLibraryStore((s) => s.allFiles);
    const fileIndexById = useLibraryStore((s) => s.fileIndexById);

    // Entries whose photo has left the library have nothing to show.
    const rows = entries.flatMap((entry) => {
        const fileIndex = fileIndexById.get(entry.fileId);
        const file = fileIndex === undefined ? undefined : allFiles[fileIndex];
        return file ? [{ entry, file }] : [];
    });

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side={isCoarsePointer ? "bottom" : "right"}
                className={cn(
                    "flex flex-col gap-0 p-0",
                    isCoarsePointer && "max-h-[80dvh]",
                )}
            >
                <SheetHeader className="shrink-0 border-b border-border">
                    <SheetTitle>Tag log</SheetTitle>
                </SheetHeader>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {rows.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">
                            Nothing tagged yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {rows.map(({ entry, file }) => (
                                <li
                                    key={entry.id}
                                    className="flex items-center gap-3 px-4 py-3"
                                >
                                    <div className="size-12 shrink-0 overflow-hidden rounded bg-muted">
                                        <ThumbnailImage file={file} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {entry.label}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {entry.tags.join(", ")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {new Date(entry.at).toLocaleTimeString(
                                                undefined,
                                                { hour: "2-digit", minute: "2-digit" },
                                            )}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            onUndo(entry);
                                        }}
                                    >
                                        Undo
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
