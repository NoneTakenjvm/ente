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

/** Tags shown per photo before the rest fold into "+N". */
const maxShownTags = 6;

/**
 * One duplicate group: a compact row per photo with a small preview and its
 * facts (tap a row to keep it), a compare button for close calls, and the
 * cleanup toggle.
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
                "shrink-0 gap-2 overflow-visible",
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
            <div className="flex flex-col gap-1.5 px-3">
                {items.map((file, index) => (
                    <DedupRow
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
                        Not a duplicate
                    </Button>
                ) : null}
            </div>
        </Card>
    );
}

function DedupRow({
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
            className={cn(
                "flex min-w-0 gap-2.5 rounded-lg border p-1.5 text-left transition-colors",
                isKeeper ?
                    "border-primary bg-primary/5" :
                    "border-transparent bg-muted/40",
            )}
            onClick={onSelect}
            aria-label={isKeeper ? "Keeper" : "Keep this one"}
            aria-pressed={isKeeper}
        >
            <span
                className={cn(
                    "relative block size-20 shrink-0 overflow-hidden rounded-md bg-muted transition-opacity",
                    willTrash && "opacity-50",
                )}
            >
                <ThumbnailImage file={file} contain />
                {isKeeper || willTrash ? (
                    <Badge
                        variant={isKeeper ? "default" : "destructive"}
                        className="absolute bottom-1 left-1 h-4 px-1.5 text-[0.65rem]"
                    >
                        {isKeeper ? "Keep" : "Trash"}
                    </Badge>
                ) : null}
            </span>
            {facts ? <DedupFacts facts={facts} /> : null}
        </button>
    );
}

/** A photo's facts, with the value that leads the group emphasised. */
function DedupFacts({ facts }: { facts: DedupItemFacts }): JSX.Element {
    const hiddenTagCount = facts.tags.length - maxShownTags;
    return (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-muted-foreground">
            <span className="flex flex-wrap items-center gap-x-1.5">
                {facts.dimensions ? (
                    <Fact leads={facts.hasMostPixels}>{facts.dimensions}</Fact>
                ) : null}
                {facts.size ? (
                    <Fact leads={facts.isLargestFile}>{facts.size}</Fact>
                ) : null}
                {facts.quality !== undefined ? (
                    <Fact leads={facts.hasBestQuality}>
                        {`Q ${facts.quality}`}
                    </Fact>
                ) : null}
                {facts.isFavorite ? (
                    <Heart
                        className="size-3 fill-current text-rose-500"
                        aria-label="Favourite"
                    />
                ) : null}
            </span>
            <span className="truncate">
                Uploaded {facts.uploadedAt}
                {facts.editedAt ? ` · edited ${facts.editedAt}` : ""}
            </span>
            <span className="truncate">Taken {facts.takenAt}</span>
            <span className="truncate">{facts.album}</span>
            {facts.tags.length > 0 ? (
                <span className="mt-0.5 flex flex-wrap gap-1">
                    {facts.tags.slice(0, maxShownTags).map((tag) => (
                        <Badge
                            key={tag.name}
                            variant={tag.onlyHere ? "outline" : "secondary"}
                            className="h-4 max-w-[8rem] px-1.5 text-[0.65rem]"
                            title={
                                tag.onlyHere ?
                                    "Only this copy has this tag; cleanup copies it to the keeper" :
                                    undefined
                            }
                        >
                            <span className="truncate">{tag.name}</span>
                        </Badge>
                    ))}
                    {hiddenTagCount > 0 ? (
                        <span className="text-[0.65rem]">+{hiddenTagCount}</span>
                    ) : null}
                </span>
            ) : (
                <span className="italic">No tags</span>
            )}
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
