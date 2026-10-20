import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useThumbnailEntry } from "@/hooks/use-thumbnail-entry";
import type { EnteFile } from "ente-media/file";

/**
 * Thumbnail of {@link file}, or a skeleton until it is loaded. Crops to fill
 * by default; `contain` shows the whole photo instead.
 */
export function ThumbnailImage({
    file,
    contain = false,
}: {
    file: EnteFile;
    contain?: boolean;
}): JSX.Element {
    const entry = useThumbnailEntry(file);

    return entry.status === "ready" && entry.url ? (
        <img
            className={contain ? "size-full object-contain" : "size-full object-cover"}
            src={entry.url}
            alt=""
        />
    ) : (
        <Skeleton className="size-full rounded-none" aria-hidden />
    );
}
