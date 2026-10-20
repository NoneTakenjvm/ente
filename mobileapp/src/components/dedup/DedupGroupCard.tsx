import type { JSX } from "react";
import { ThumbnailImage } from "@/components/ThumbnailImage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import type { DedupItemFacts } from "@/lib/dedup-facts";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";
import { Expand, Heart } from "lucide-react";

interface DedupGroupCardProps {
    items: EnteFile[];
    /** One entry per item, in the same order. */
    facts: DedupItemFacts[];
    keeperFileId: number;
    isSelected: boolean;
    subtitle?: string;
    onToggleSelected: () => void;
    onSelectKeeper: (fileId: number) => void;
    onCompare: () => void;
    /** When set, the card offers a button to stop flagging this group. */
    onExempt?: () => void;
}

/**
 * One duplicate group: big side-by-side tiles with each photo's facts (tap to
 * keep it), a compare button for close calls, and the cleanup toggle.
 */
export function DedupGroupCard({
    items,
    facts,
    keeperFileId,
    isSelected,
    subtitle,
    onToggleSelected,
    onSelectKeeper,
    onCompare,
    onExempt,
}: DedupGroupCardProps): JSX.Element {
    const trashCount = items.length - 1;
    return (
        <Card
            size="sm"
            className={cn(
                "shrink-0 gap-3 overflow-visible",
                isSelected && "ring-2 ring-destructive/50",
            )}
        >
            <div className="flex items-center justify-between gap-2 px-3">
                <p className="min-w-0 truncate text-xs text-muted-foreground">
                    {subtitle}
                </p>
                <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={onCompare}
                >
                    <Expand />
                    Compare
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 px-3">
                {items.map((file, index) => (
                    <DedupTile
                        key={file.id}
                        file={file}
                        facts={facts[index]}
                        isKeeper={file.id === keeperFileId}
                        willTrash={isSelected && file.id !== keeperFileId}
                        onSelect={() => onSelectKeeper(file.id)}
                    />
                ))}
            </div>
            <div className="flex items-center justify-between gap-2 px-3">
                <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm font-medium">
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleSelected()}
                    />
                    <span className="truncate">
                        {trashCount === 1 ?
                            "Trash the other" :
                            `Trash the other ${trashCount}`}
                    </span>
                </label>
                {onExempt ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 text-muted-foreground"
                        onClick={onExempt}
                    >
                        Exempt pair
                    </Button>
                ) : null}
            </div>
        </Card>
    );
}

function DedupTile({
    file,
    facts,
    isKeeper,
    willTrash,
    onSelect,
}: {
    file: EnteFile;
    facts: DedupItemFacts | undefined;
    isKeeper: boolean;
    willTrash: boolean;
    onSelect: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            className="flex min-w-0 flex-col gap-1.5 text-left"
            onClick={onSelect}
            aria-label={isKeeper ? "Keeper" : "Keep this one"}
            aria-pressed={isKeeper}
        >
            <span
                className={cn(
                    "relative block aspect-square w-full overflow-hidden rounded-lg bg-muted ring-offset-2 ring-offset-card transition-opacity",
                    isKeeper && "ring-2 ring-primary",
                    willTrash && "opacity-60",
                )}
            >
                <ThumbnailImage file={file} contain />
                {isKeeper ? (
                    <Badge className="absolute top-1.5 left-1.5">Keep</Badge>
                ) : (
                    <Badge
                        variant={willTrash ? "destructive" : "secondary"}
                        className="absolute top-1.5 left-1.5"
                    >
                        {willTrash ? "Trash" : "Tap to keep"}
                    </Badge>
                )}
            </span>
            {facts ? <DedupFacts facts={facts} /> : null}
        </button>
    );
}

/** A photo's facts, with the value that leads the group emphasised. */
function DedupFacts({ facts }: { facts: DedupItemFacts }): JSX.Element {
    return (
        <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span className="flex flex-wrap items-center gap-x-1.5">
                {facts.dimensions ? (
                    <Fact leads={facts.hasMostPixels}>{facts.dimensions}</Fact>
                ) : null}
                {facts.size ? (
                    <Fact leads={facts.isLargestFile}>{facts.size}</Fact>
                ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-1.5">
                {facts.quality !== undefined ? (
                    <Fact leads={facts.hasBestQuality}>
                        {`Quality ${facts.quality}`}
                    </Fact>
                ) : null}
                {facts.isFavorite ? (
                    <Heart
                        className="size-3 fill-current text-rose-500"
                        aria-label="Favourite"
                    />
                ) : null}
            </span>
            <span className="truncate">{facts.takenAt}</span>
        </span>
    );
}

function Fact({
    leads,
    children,
}: {
    leads: boolean;
    children: string;
}): JSX.Element {
    return (
        <span className={cn(leads && "font-semibold text-foreground")}>
            {children}
            {leads ? " ▲" : ""}
        </span>
    );
}
