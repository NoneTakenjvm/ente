import {
    useEffect,
    useSyncExternalStore,
    type JSX,
} from "react";
import { ImageOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import type { EnteFile } from "ente-media/file";

interface SessionViewThumbProps {
    file: EnteFile | undefined;
    index: number;
    onOpen?: (carouselIndex: number) => void;
    /** Index into the live-files carousel; omit when deleted. */
    carouselIndex?: number;
}

/**
 * Chronological session tile. Deleted slots show a placeholder and are not
 * openable.
 */
export function SessionViewThumb({
    file,
    index,
    onOpen,
    carouselIndex,
}: SessionViewThumbProps): JSX.Element {
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

    if (!file) {
        return (
            <div
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md bg-muted p-2 text-center"
                aria-label={`Deleted image at position ${index + 1}`}
            >
                <ImageOff
                    className="size-6 text-muted-foreground"
                    aria-hidden
                />
                <span className="text-[0.65rem] leading-tight text-muted-foreground">
                    Deleted Image
                </span>
            </div>
        );
    }

    const ready = entry.status === "ready" && entry.url;
    const openable = carouselIndex !== undefined && onOpen;

    return (
        <button
            type="button"
            className={cn(
                "relative aspect-square overflow-hidden rounded-md bg-muted",
                openable && "cursor-pointer",
            )}
            disabled={!openable}
            onClick={() => {
                if (carouselIndex !== undefined && onOpen) {
                    onOpen(carouselIndex);
                }
            }}
            aria-label={`Open media ${index + 1}`}
        >
            {ready ? (
                <img
                    className="size-full object-cover"
                    src={entry.url}
                    alt=""
                />
            ) : (
                <Skeleton className="size-full rounded-none" aria-hidden />
            )}
        </button>
    );
}
