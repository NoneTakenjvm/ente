import { memo, useEffect, useSyncExternalStore, type JSX } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import { Check, CircleCheck, Play } from "lucide-react";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";

interface ThumbnailCellProps {
    file: EnteFile;
    size: number;
    onOpen?: (file: EnteFile) => void;
    isSelected?: boolean;
    onToggleSelect?: (file: EnteFile) => void;
    isAlreadyCompressed?: boolean;
    disabled?: boolean;
}

export const ThumbnailCell = memo(function ThumbnailCell({
    file,
    size,
    onOpen,
    isSelected = false,
    onToggleSelect,
    isAlreadyCompressed = false,
    disabled = false,
}: ThumbnailCellProps): JSX.Element {
    const entry = useSyncExternalStore(
        (listener) => subscribeThumbnail(file.id, listener),
        () => getThumbnailEntry(file.id),
        () => getThumbnailEntry(file.id),
    );

    useEffect(() => {
        if (entry.status === "idle") {
            requestThumbnail(file);
        }
    }, [entry.status, file]);

    const hasSelectToggle = onToggleSelect !== undefined;
    const handleOpen = (): void => {
        if (disabled) {
            return;
        }
        onOpen?.(file);
    };

    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-md bg-muted",
                disabled && "pointer-events-none opacity-50",
            )}
            style={{ width: size, height: size }}
        >
            <button
                type="button"
                className={cn(
                    "size-full",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}
                onClick={handleOpen}
                disabled={disabled || !onOpen}
                aria-label={`Open media ${file.id}`}
            >
                {file.metadata.fileType === FileType.video && !hasSelectToggle ? (
                    <span className="absolute bottom-1 right-1 z-10 rounded-full bg-black/60 p-1 text-white">
                        <Play className="size-3 fill-current" aria-hidden />
                    </span>
                ) : null}
                {entry.status === "ready" && entry.url ? (
                    <img
                        className="size-full object-cover"
                        src={entry.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                    />
                ) : entry.status === "error" ? (
                    <span
                        className="flex size-full items-center justify-center text-sm text-destructive"
                        aria-hidden
                    >
                        !
                    </span>
                ) : (
                    <Skeleton className="size-full rounded-none" aria-hidden />
                )}
            </button>
            {isAlreadyCompressed ? (
                <span
                    className="absolute top-1.5 left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-green-600 text-white"
                    aria-hidden
                >
                    <CircleCheck className="size-3.5" strokeWidth={2.5} />
                </span>
            ) : null}
            {hasSelectToggle ? (
                <label
                    className="absolute top-1.5 right-1.5 z-20 flex size-6 cursor-pointer items-center justify-center rounded-md bg-background/80 p-0"
                    onClick={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <Checkbox
                        checked={isSelected}
                        disabled={disabled}
                        onCheckedChange={() => {
                            onToggleSelect(file);
                        }}
                        aria-label={
                            isSelected ?
                                `Deselect media ${file.id}` :
                                `Select media ${file.id}`
                        }
                    />
                </label>
            ) : null}
            {hasSelectToggle && isSelected ? (
                <>
                    <span
                        className="pointer-events-none absolute inset-0 z-[1] bg-primary/30"
                        aria-hidden
                    />
                    <span
                        className="pointer-events-none absolute right-1.5 bottom-1.5 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"
                        aria-hidden
                    >
                        <Check className="size-4" strokeWidth={3} />
                    </span>
                </>
            ) : null}
        </div>
    );
});
