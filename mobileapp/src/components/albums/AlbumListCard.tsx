import {
    useCallback,
    useRef,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { GripVertical, Pencil } from "lucide-react";
import { AlbumCoverThumb } from "@/components/albums/AlbumCoverThumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";

interface AlbumListCardProps {
    albumId: string;
    name: string;
    matchCount: number;
    coverFile: EnteFile | undefined;
    reorderMode: boolean;
    isDragging: boolean;
    isDragOver: boolean;
    onOpen: () => void;
    onEdit: () => void;
    onDragStart: (albumId: string) => void;
    onDragMove: (clientY: number) => void;
    onDragEnd: () => void;
}

export function AlbumListCard({
    albumId,
    name,
    matchCount,
    coverFile,
    reorderMode,
    isDragging,
    isDragOver,
    onOpen,
    onEdit,
    onDragStart,
    onDragMove,
    onDragEnd,
}: AlbumListCardProps): JSX.Element {
    const cardRef = useRef<HTMLDivElement>(null);

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        if (!reorderMode) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        onDragStart(albumId);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        if (!reorderMode || !event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
        }
        event.preventDefault();
        onDragMove(event.clientY);
    };

    const handlePointerUp = useCallback(
        (event: ReactPointerEvent<HTMLButtonElement>): void => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
            }
            event.currentTarget.releasePointerCapture(event.pointerId);
            onDragEnd();
        },
        [onDragEnd],
    );

    return (
        <Card
            ref={cardRef}
            data-album-id={albumId}
            className={cn(
                "gap-0 py-0 transition-colors",
                !reorderMode && "cursor-pointer hover:bg-muted/40",
                isDragging && "opacity-50",
                isDragOver && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
            onClick={reorderMode ? undefined : onOpen}
        >
            <div className="flex items-center gap-3 px-4 py-3">
                {reorderMode ? (
                    <button
                        type="button"
                        className="flex shrink-0 touch-none items-center justify-center rounded-md p-1 text-muted-foreground"
                        aria-label={`Reorder ${name}`}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                    >
                        <GripVertical className="size-5" />
                    </button>
                ) : null}
                <AlbumCoverThumb
                    file={coverFile}
                    className="size-16 rounded-lg"
                />
                <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="min-w-0 flex-1 text-base font-medium leading-snug break-words">
                        {name}
                    </span>
                    <Badge
                        variant="secondary"
                        className="mt-0.5 shrink-0 tabular-nums"
                    >
                        {matchCount}
                    </Badge>
                </div>
                {!reorderMode ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={`Edit ${name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            onEdit();
                        }}
                    >
                        <Pencil className="size-4" />
                    </Button>
                ) : null}
            </div>
        </Card>
    );
}
