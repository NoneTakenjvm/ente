import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TagPreset } from "@/lib/tag-presets";

interface RankedKit {
    preset: TagPreset;
    count: number;
}

interface KitListProps {
    rankedKits: RankedKit[];
    /** Highlights the kit the tool is currently using. */
    isActive: (preset: TagPreset) => boolean;
    onSelect: (preset: TagPreset) => void;
    /** Appended to "No kits yet." when there are no kits. */
    emptyHint?: string;
}

/**
 * Kit rows ranked by how many files match each kit, with the active kit
 * highlighted. Shared by the stamp and kit review footers.
 */
export function KitList({
    rankedKits,
    isActive,
    onSelect,
    emptyHint,
}: KitListProps): JSX.Element {
    if (rankedKits.length === 0) {
        return (
            <p className="text-xs text-muted-foreground">
                No kits yet.{emptyHint ? ` ${emptyHint}` : null}
            </p>
        );
    }
    return (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            {rankedKits.map(({ preset, count }) => (
                <li key={preset.id}>
                    <Button
                        type="button"
                        variant={isActive(preset) ? "secondary" : "ghost"}
                        className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5"
                        onClick={() => onSelect(preset)}
                    >
                        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                            <span className="truncate text-sm font-medium">
                                {preset.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                                {preset.tags.join(", ")}
                            </span>
                        </span>
                        <Badge
                            variant="secondary"
                            className="shrink-0 tabular-nums"
                        >
                            {count}
                        </Badge>
                    </Button>
                </li>
            ))}
        </ul>
    );
}
