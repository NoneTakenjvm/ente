import { useEffect, useSyncExternalStore, type JSX } from "react";
import { ImageIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import type { EnteFile } from "ente-media/file";

interface AlbumCoverThumbProps {
    file: EnteFile | undefined;
    className?: string;
    onClick?: () => void;
}

export function AlbumCoverThumb({
    file,
    className,
    onClick,
}: AlbumCoverThumbProps): JSX.Element {
    const entry = useSyncExternalStore(
        (listener) => subscribeThumbnail(file?.id ?? -1, listener),
        () => getThumbnailEntry(file?.id ?? -1),
        () => getThumbnailEntry(file?.id ?? -1),
    );

    useEffect(() => {
        if (file && entry.status === "idle") {
            requestThumbnail(file);
        }
    }, [entry.status, file]);

    const content =
        file && entry.status === "ready" && entry.url ? (
            <img className="size-full object-cover" src={entry.url} alt="" />
        ) : file ? (
            <Skeleton className="size-full rounded-none" aria-hidden />
        ) : (
            <ImageIcon className="size-5 text-muted-foreground" aria-hidden />
        );

    if (onClick) {
        return (
            <button
                type="button"
                className={cn(
                    "relative size-14 shrink-0 overflow-hidden rounded-md bg-muted",
                    className,
                )}
                onClick={onClick}
                aria-label="Change album thumbnail"
            >
                {content}
            </button>
        );
    }

    return (
        <div
            className={cn(
                "relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted",
                className,
            )}
        >
            {content}
        </div>
    );
}
