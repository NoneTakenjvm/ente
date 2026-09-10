import type { JSX } from "react";
import { ImageOff } from "lucide-react";
import { AlbumCoverThumb } from "@/components/albums/AlbumCoverThumb";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";

interface SessionListCardProps {
    name: string;
    lore: string;
    viewCount: number;
    coverFile: EnteFile | undefined;
    onOpen: () => void;
}

/**
 * Album-style row for a browsing session on the Recents list.
 */
export function SessionListCard({
    name,
    lore,
    viewCount,
    coverFile,
    onOpen,
}: SessionListCardProps): JSX.Element {
    return (
        <Card
            className={cn(
                "cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/40",
            )}
            onClick={onOpen}
        >
            <div className="flex items-center gap-3 px-4 py-3">
                {coverFile ? (
                    <AlbumCoverThumb
                        file={coverFile}
                        className="size-16 rounded-lg"
                    />
                ) : (
                    <div
                        className="flex size-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg bg-muted px-1 text-center"
                        aria-label="Deleted image"
                    >
                        <ImageOff
                            className="size-5 text-muted-foreground"
                            aria-hidden
                        />
                        <span className="text-[0.55rem] leading-tight text-muted-foreground">
                            Deleted
                        </span>
                    </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 text-base font-medium leading-snug break-words">
                            {name}
                        </span>
                        <Badge
                            variant="secondary"
                            className="mt-0.5 shrink-0 tabular-nums"
                        >
                            {viewCount}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{lore}</p>
                </div>
            </div>
        </Card>
    );
}
