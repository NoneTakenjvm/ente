import { useEffect, useState, type JSX } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
    ScopeFilterPanel,
    useSectionState,
} from "@/components/ScopeFilterMenu";
import type { NearnessView } from "@/components/sort-menu/NearnessSection";
import { SortPanel } from "@/components/sort-menu/SortPanel";
import {
    useHydrateIndexesForOrdering,
    useKitPresenceCounts,
} from "@/hooks/use-sort-menu-data";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import {
    hasActiveScope,
    type ScopeKey,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import { matchNearnessFilterToKitPreset } from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

interface SortMenuProps {
    filter: TagFilterSelection;
    setScope: (key: ScopeKey, value: string) => void;
    counts: ScopeCounts;
    /** Files currently shown; kit presence counts are taken over these. */
    matchingFiles: EnteFile[];
    /** Whether tag clauses exist, which enables the tag-filter-fit sort. */
    tagFilterFitAvailable: boolean;
}

/**
 * Gallery "Options" dropdown: the Sort tab (reorders the shown photos) next
 * to the Filter tab (scope filters). Reads and writes the ordering in
 * `useUIStore`.
 */
export function SortMenu({
    filter,
    setScope,
    counts,
    matchingFiles,
    tagFilterFitAvailable,
}: SortMenuProps): JSX.Element {
    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);
    const presets = useTagSpeedStore((s) => s.presets);

    const [menuOpen, setMenuOpen] = useState<boolean>(false);
    const [optionsTab, setOptionsTab] = useState<"sort" | "filter">("filter");
    const [nearnessView, setNearnessView] = useState<NearnessView>("summary");
    const sectionState = useSectionState();
    const kitPresenceCountById = useKitPresenceCounts(
        presets,
        matchingFiles,
        menuOpen,
    );
    useHydrateIndexesForOrdering(ordering, presets.length > 0);

    // Kit deleted or tags no longer match — drop orphaned kit nearness.
    useEffect(() => {
        if (
            ordering?.kind === "nearness" &&
            ordering.source === "kit" &&
            !matchNearnessFilterToKitPreset(ordering.filter, presets)
        ) {
            setOrdering(undefined);
        }
    }, [ordering, presets, setOrdering]);

    const sortActive = ordering !== undefined && ordering.kind !== "shuffled";
    const filterActive = hasActiveScope(filter);

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                setMenuOpen(open);
                if (open) {
                    setOptionsTab(sortActive ? "sort" : "filter");
                    return;
                }
                setNearnessView("summary");
            }}
        >
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={
                            filterActive || sortActive ? "secondary" : "outline"
                        }
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label="Gallery options: sort and filter"
                    >
                        <SlidersHorizontal className="size-3.5 shrink-0" />
                        Options
                    </Button>
                }
            />
            <DropdownMenuContent
                align="start"
                className={cn(
                    "p-1.5",
                    nearnessView === "summary" ?
                        "w-56" :
                        "w-[min(100vw-1.5rem,24rem)] max-w-[min(100vw-1.5rem,24rem)]",
                )}
            >
                <div className="flex flex-col gap-2">
                    <div
                        className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px]"
                        role="tablist"
                        aria-label="Options section"
                    >
                        <OptionsTab
                            label="Sort"
                            selected={optionsTab === "sort"}
                            active={sortActive}
                            onClick={() => setOptionsTab("sort")}
                        />
                        <OptionsTab
                            label="Filter"
                            selected={optionsTab === "filter"}
                            active={filterActive}
                            onClick={() => {
                                setOptionsTab("filter");
                                setNearnessView("summary");
                            }}
                        />
                    </div>
                    {optionsTab === "sort" ? (
                        <SortPanel
                            sectionState={sectionState}
                            sortActive={sortActive}
                            tagFilterFitAvailable={tagFilterFitAvailable}
                            nearnessView={nearnessView}
                            setNearnessView={setNearnessView}
                            counts={counts}
                            presets={presets}
                            kitPresenceCountById={kitPresenceCountById}
                        />
                    ) : (
                        <ScopeFilterPanel
                            filter={filter}
                            setScope={setScope}
                            counts={counts}
                            sectionState={sectionState}
                        />
                    )}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Sort / Filter tab button with an "has active choice" dot. */
function OptionsTab({
    label,
    selected,
    active,
    onClick,
}: {
    label: string;
    selected: boolean;
    active: boolean;
    onClick: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
                "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors",
                selected ?
                    "bg-background text-foreground shadow-sm" :
                    "text-foreground/60 hover:text-foreground",
            )}
            onClick={onClick}
        >
            {label}
            {active ? (
                <span className="size-1.5 rounded-full bg-foreground" />
            ) : null}
        </button>
    );
}
