import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useThumbnailEntry } from "@/hooks/use-thumbnail-entry";
import type { EnteFile } from "ente-media/file";

/** Cover-fit thumbnail of {@link file}, or a skeleton until it is loaded. */
export function ThumbnailImage({ file }: { file: EnteFile }): JSX.Element {
    const entry = useThumbnailEntry(file);

    return entry.status === "ready" && entry.url ? (
        <img className="size-full object-cover" src={entry.url} alt="" />
    ) : (
        <Skeleton className="size-full rounded-none" aria-hidden />
    );
}
