import { useEffect, useSyncExternalStore, type JSX } from "react";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardHeader,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import type { EnteFile } from "ente-media/file";

interface DedupGroupCardProps {
    items: EnteFile[];
    keeperFileId: number;
    isSelected: boolean;
    subtitle?: string;
    onToggleSelected: () => void;
    onSelectKeeper: (fileId: number) => void;
}

function DedupThumb({
    file,
    isKeeper,
    onSelect,
}: {
    file: EnteFile;
    isKeeper: boolean;
    onSelect: () => void;
}): JSX.Element {
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

    return (
        <button
            type="button"
            className={cn(
                "relative size-20 shrink-0 overflow-hidden rounded-md bg-muted",
                isKeeper && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
            onClick={onSelect}
            aria-label={isKeeper ? "Keeper" : "Select as keeper"}
            aria-pressed={isKeeper}
        >
            {entry.status === "ready" && entry.url ? (
                <img className="size-full object-cover" src={entry.url} alt="" />
            ) : (
                <Skeleton className="size-full rounded-none" aria-hidden />
            )}
            {isKeeper ? (
                <Badge className="absolute bottom-1 left-1 px-1.5 py-0 text-[0.6rem]">
                    Keep
                </Badge>
            ) : null}
        </button>
    );
}

export function DedupGroupCard({
    items,
    keeperFileId,
    isSelected,
    subtitle,
    onToggleSelected,
    onSelectKeeper,
}: DedupGroupCardProps): JSX.Element {
    return (
        <Card className="shrink-0 gap-0 overflow-visible py-0">
            <CardHeader className="px-4 py-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleSelected()}
                    />
                    <span>
                        {items.length} similar items
                        {subtitle ? ` · ${subtitle}` : ""}
                    </span>
                </label>
            </CardHeader>
            <CardContent className="px-4 pb-4">
                <div className="flex min-h-20 gap-2 overflow-x-auto pb-1">
                    {items.map((file) => (
                        <DedupThumb
                            key={file.id}
                            file={file}
                            isKeeper={file.id === keeperFileId}
                            onSelect={() => onSelectKeeper(file.id)}
                        />
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
