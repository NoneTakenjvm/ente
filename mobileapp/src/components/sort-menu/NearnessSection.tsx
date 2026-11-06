import type { JSX, ReactNode } from "react";
import { OptionsSection, type SectionState } from "@/components/ScopeFilterMenu";
import { TagFilterEditor } from "@/components/TagFilterEditor";
import { KitPicker, kitLabel } from "@/components/sort-menu/KitPicker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    describeTagFilter,
    emptyTagFilter,
    isTagFilterActive,
} from "@/lib/tag-filter";
import {
    matchNearnessFilterToKitPreset,
    nearnessFilterFromKitTags,
    type TagPreset,
} from "@/lib/tag-presets";
import { useSelectionStore } from "@/stores/selection-store";
import { useUIStore } from "@/stores/ui-store";

/** What the Nearness section currently shows. */
export type NearnessView = "summary" | "filterEditor" | "kitPicker";

interface NearnessSectionProps {
    sectionState: SectionState;
    view: NearnessView;
    setView: (view: NearnessView) => void;
    counts: ScopeCounts;
    presets: TagPreset[];
    /** Shown files assigned to each kit as closest fit. */
    kitPresenceCountById: ReadonlyMap<string, number>;
}

/** Sort-by-nearness section: pick a kit or a tag filter and reorder by it. */
export function NearnessSection({
    sectionState,
    view,
    setView,
    counts,
    presets,
    kitPresenceCountById,
}: NearnessSectionProps): JSX.Element {
    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);
    const reapplyNearness = useUIStore((s) => s.reapplyNearness);
    const kitLikenessRivalPenalty = useUIStore(
        (s) => s.kitLikenessRivalPenalty,
    );
    const setKitLikenessRivalPenalty = useUIStore(
        (s) => s.setKitLikenessRivalPenalty,
    );
    const excludedKitLikenessIds = useUIStore(
        (s) => s.excludedKitLikenessIds,
    );
    const toggleKitLikenessExcluded = useUIStore(
        (s) => s.toggleKitLikenessExcluded,
    );
    const draft = useTagFilterDraft(emptyTagFilter());

    const activeNearness =
        ordering?.kind === "nearness" && isTagFilterActive(ordering.filter) ?
            ordering :
            undefined;
    /** Custom filter nearness — not the kit picker entry. */
    const filterNearness =
        activeNearness?.source === "filter" ? activeNearness.filter : undefined;
    const selectedKit =
        activeNearness?.source === "kit" ?
            matchNearnessFilterToKitPreset(activeNearness.filter, presets) :
            undefined;

    const turnOff = (): void => setOrdering(undefined);

    const chooseKit = (preset: TagPreset): void => {
        setView("summary");
        if (!preset.tags.length) {
            return;
        }
        setOrdering({
            kind: "nearness",
            filter: nearnessFilterFromKitTags(preset.tags),
            source: "kit",
        });
        const selection = useSelectionStore.getState();
        selection.setStampPickMode("kit");
        selection.setStampTags(preset.tags);
        selection.setMode("stamp");
        selection.setStampSheetOpen(false);
    };

    const openFilterEditor = (): void => {
        // Fresh draft when switching from kit likeness; keep current when
        // editing an active filter-nearness selection.
        draft.setFilter(filterNearness ?? emptyTagFilter());
        setView("filterEditor");
    };

    const commitDraft = (): void => {
        if (isTagFilterActive(draft.filter)) {
            setOrdering({
                kind: "nearness",
                filter: draft.filter,
                source: "filter",
            });
        } else if (ordering?.kind === "nearness") {
            turnOff();
        }
        setView("summary");
    };

    const renderBody = (): ReactNode => {
        if (view === "filterEditor") {
            return (
                <div className="flex max-h-[min(70dvh,28rem)] flex-col gap-2 overflow-hidden px-1 pb-2">
                    <TagFilterEditor
                        filter={draft.filter}
                        actions={draft.actions}
                        counts={counts}
                        emptyDescription="No nearness filter yet"
                        className="min-h-0 flex-1"
                    />
                    <div className="flex flex-wrap gap-1.5 px-1">
                        <Button type="button" size="sm" onClick={commitDraft}>
                            Done
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setView("summary")}
                        >
                            Back
                        </Button>
                    </div>
                </div>
            );
        }
        if (view === "kitPicker") {
            return (
                <KitPicker
                    presets={presets}
                    selectedPresetId={selectedKit?.id}
                    excludedIds={excludedKitLikenessIds}
                    presenceCountById={kitPresenceCountById}
                    onPick={chooseKit}
                    onToggleExcluded={toggleKitLikenessExcluded}
                    onBack={() => setView("summary")}
                />
            );
        }
        if (selectedKit) {
            return (
                <>
                    <p className="truncate px-1.5 text-sm font-medium">
                        {kitLabel(selectedKit, kitPresenceCountById)}
                    </p>
                    <NearnessActions
                        onReapply={reapplyNearness}
                        onChange={() => setView("kitPicker")}
                        onOff={turnOff}
                    />
                    <label className="flex items-center gap-2 px-1.5 pt-0.5 text-xs text-muted-foreground">
                        <Switch
                            checked={kitLikenessRivalPenalty}
                            onCheckedChange={setKitLikenessRivalPenalty}
                            aria-label="Rival kit penalties"
                        />
                        Rival kit penalties
                    </label>
                </>
            );
        }
        if (filterNearness) {
            return (
                <>
                    <p className="max-h-16 overflow-auto px-1.5 text-sm font-medium break-words">
                        {describeTagFilter(filterNearness)}
                    </p>
                    <NearnessActions
                        onReapply={reapplyNearness}
                        onChange={openFilterEditor}
                        onOff={turnOff}
                    />
                </>
            );
        }
        return (
            <div className="flex flex-wrap gap-1.5 px-1">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setView("kitPicker")}
                >
                    Choose kit
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={openFilterEditor}
                >
                    Choose tags
                </Button>
            </div>
        );
    };

    return (
        <OptionsSection
            title="Nearness"
            {...sectionState(
                "nearness",
                filterNearness !== undefined ||
                    selectedKit !== undefined ||
                    view !== "summary",
            )}
        >
            <div className="flex flex-col gap-1.5 px-1 pb-2">{renderBody()}</div>
        </OptionsSection>
    );
}

/** Reapply / Change / Off row shown while a nearness entry is active. */
function NearnessActions({
    onReapply,
    onChange,
    onOff,
}: {
    onReapply: () => void;
    onChange: () => void;
    onOff: () => void;
}): JSX.Element {
    return (
        <div className="flex flex-wrap gap-1.5 px-1">
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onReapply}
            >
                Reapply
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onChange}>
                Change
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onOff}>
                Off
            </Button>
        </div>
    );
}
