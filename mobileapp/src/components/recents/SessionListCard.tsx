import type { JSX } from "react";
import { ImageOff } from "lucide-react";
import { AlbumCoverThumb } from "@/components/albums/AlbumCoverThumb";
import { MediaListCard } from "@/components/MediaListCard";
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
        <MediaListCard
            className="cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/40"
            onClick={onOpen}
            name={name}
            badge={viewCount}
            subtitle={<p className="text-xs text-muted-foreground">{lore}</p>}
            leading={
                coverFile ? (
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
                )
            }
        />
    );
}
