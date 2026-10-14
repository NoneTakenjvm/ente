import { useMemo, useState, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { TagPreset } from "@/lib/tag-presets";
import { cn } from "@/lib/utils";

interface KitPickerProps {
    presets: TagPreset[];
    selectedPresetId: string | undefined;
    /** Kits excluded from rival penalties; listed last but still pickable. */
    excludedIds: ReadonlySet<string>;
    /** Shown files assigned to each kit as closest fit. */
    presenceCountById: ReadonlyMap<string, number>;
    onPick: (preset: TagPreset) => void;
    onToggleExcluded: (presetId: string) => void;
    onBack: () => void;
}

/** Kit name with its shown-file count when known. */
export const kitLabel = (
    preset: TagPreset,
    presenceCountById: ReadonlyMap<string, number>,
): string => {
    const count = presenceCountById.get(preset.id);
    return count === undefined ? preset.name : `${preset.name} (${count})`;
};

/** Search box and list for choosing the kit to sort nearness by. */
export function KitPicker({
    presets,
    selectedPresetId,
    excludedIds,
    presenceCountById,
    onPick,
    onToggleExcluded,
    onBack,
}: KitPickerProps): JSX.Element {
    const [query, setQuery] = useState<string>("");

    const filteredKits = useMemo((): TagPreset[] => {
        const needle = query.trim().toLowerCase();
        const matched = !needle ?
            [...presets] :
            presets.filter(
                (preset) =>
                    preset.name.toLowerCase().includes(needle) ||
                    preset.tags.some((tag) =>
                        tag.toLowerCase().includes(needle)),
            );
        // Included kits first (most fits → more specific → name); excluded last.
        matched.sort((a, b) => {
            const excludedA = excludedIds.has(a.id);
            const excludedB = excludedIds.has(b.id);
            if (excludedA !== excludedB) {
                return excludedA ? 1 : -1;
            }
            const countA = presenceCountById.get(a.id) ?? -1;
            const countB = presenceCountById.get(b.id) ?? -1;
            if (countB !== countA) {
                return countB - countA;
            }
            if (b.tags.length !== a.tags.length) {
                return b.tags.length - a.tags.length;
            }
            return a.name.localeCompare(b.name);
        });
        return matched;
    }, [excludedIds, presenceCountById, presets, query]);

    return (
        <>
            <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search kits…"
                className="h-8"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            />
            <div className="max-h-40 overflow-y-auto overscroll-contain">
                <KitPickerList
                    hasPresets={presets.length > 0}
                    kits={filteredKits}
                    selectedPresetId={selectedPresetId}
                    excludedIds={excludedIds}
                    presenceCountById={presenceCountById}
                    onPick={onPick}
                    onToggleExcluded={onToggleExcluded}
                />
            </div>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={onBack}
            >
                Back
            </Button>
        </>
    );
}

function KitPickerList({
    hasPresets,
    kits,
    selectedPresetId,
    excludedIds,
    presenceCountById,
    onPick,
    onToggleExcluded,
}: Pick<
    KitPickerProps,
    | "selectedPresetId" |
    "excludedIds" |
    "presenceCountById" |
    "onPick" |
    "onToggleExcluded"
> & {
    hasPresets: boolean;
    /** Presets after search and ordering. */
    kits: TagPreset[];
}): JSX.Element {
    if (!hasPresets) {
        return (
            <p className="px-1 py-2 text-xs text-muted-foreground">
                Create kits in Manage → Tags
            </p>
        );
    }
    if (kits.length === 0) {
        return (
            <p className="px-1 py-2 text-xs text-muted-foreground">
                No kits match
            </p>
        );
    }
    return (
        <>
            {kits.map((preset) => {
                const excluded = excludedIds.has(preset.id);
                return (
                    <div
                        key={preset.id}
                        className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                            kitRowTone(preset.id === selectedPresetId, excluded),
                        )}
                    >
                        <Checkbox
                            checked={!excluded}
                            aria-label={
                                excluded ?
                                    `Include ${preset.name}` :
                                    `Exclude ${preset.name}`
                            }
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={() => onToggleExcluded(preset.id)}
                        />
                        <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left"
                            onClick={() => onPick(preset)}
                        >
                            {kitLabel(preset, presenceCountById)}
                        </button>
                    </div>
                );
            })}
        </>
    );
}

const kitRowTone = (selected: boolean, excluded: boolean): string => {
    if (selected) {
        return "bg-accent text-accent-foreground";
    }
    return excluded ?
        "text-muted-foreground hover:bg-accent/40" :
        "hover:bg-accent/60";
};
