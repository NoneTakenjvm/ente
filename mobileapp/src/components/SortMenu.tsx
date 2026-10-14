import {
    useEffect,
    useMemo,
    useState,
    type JSX,
    type ReactNode,
} from "react";
import { SlidersHorizontal } from "lucide-react";
import {
    OptionsSection,
    RadioOptionsSection,
    ScopeFilterPanel,
    useSectionState,
} from "@/components/ScopeFilterMenu";
import { TagFilterEditor } from "@/components/TagFilterEditor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    countKitPresence,
    type KitPresenceEstimate,
} from "@/lib/kit-nearness-margins";
import { estimateKitPresenceInWorker } from "@/lib/kit-nearness-margins-job";
import {
    describeTagFilter,
    emptyTagFilter,
    hasActiveScope,
    isTagFilterActive,
    type ScopeKey,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import {
    matchNearnessFilterToKitPreset,
    nearnessFilterFromKitTags,
    type TagPreset,
} from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore, type GalleryOrdering } from "@/stores/ui-store";
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

/** Orderings that are a single direction choice. */
type DirectionSortKind = Exclude<
    GalleryOrdering["kind"],
    "nearness" | "shuffled"
>;

interface DirectionSortSection {
    kind: DirectionSortKind;
    title: string;
    options: readonly { value: string; label: string }[];
}

const DIRECTION_SORT_SECTIONS: readonly DirectionSortSection[] = [
    {
        kind: "uploadedAt",
        title: "Uploaded At",
        options: [
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
        ],
    },
    {
        kind: "viewportFit",
        title: "Viewport fit",
        options: [
            { value: "best", label: "Best Fit" },
            { value: "worst", label: "Worst Fit" },
        ],
    },
    {
        kind: "imageSize",
        title: "Image size",
        options: [
            { value: "largest", label: "Largest" },
            { value: "smallest", label: "Smallest" },
        ],
    },
    {
        kind: "imageQuality",
        title: "Image quality",
        options: [
            { value: "worst", label: "Worst" },
            { value: "best", label: "Best" },
        ],
    },
    {
        kind: "tagFilterFit",
        title: "Tag filter fit",
        options: [
            { value: "best", label: "Best fit" },
            { value: "worst", label: "Worst fit" },
        ],
    },
    {
        kind: "relative",
        title: "Relative",
        options: [
            { value: "closest", label: "Closest" },
            { value: "furthest", label: "Furthest" },
        ],
    },
];

/** What the Nearness section currently shows. */
type NearnessView = "summary" | "filterEditor" | "kitPicker";

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
    const reapplyRelativeSort = useUIStore((s) => s.reapplyRelativeSort);
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
    const presets = useTagSpeedStore((s) => s.presets);

    const [menuOpen, setMenuOpen] = useState<boolean>(false);
    const [optionsTab, setOptionsTab] = useState<"sort" | "filter">("filter");
    const [nearnessView, setNearnessView] = useState<NearnessView>("summary");
    const nearnessDraft = useTagFilterDraft(emptyTagFilter());
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

    const sortActive = ordering !== undefined && ordering.kind !== "shuffled";
    const filterActive = hasActiveScope(filter);

    const selectDirection = (
        kind: DirectionSortKind,
        direction: string,
    ): void => {
        if (kind === "relative") {
            // New random tip only when turning relative on.
            const current = ordering?.kind === "relative" ? ordering : undefined;
            setOrdering({
                kind,
                direction: direction as "closest" | "furthest",
                seed: current?.seed ?? newSeed(),
                startFileId: current?.startFileId,
            });
            return;
        }
        setOrdering({ kind, direction } as GalleryOrdering);
    };

    const clearNearness = (): void => {
        if (ordering?.kind === "nearness") {
            setOrdering(undefined);
        }
    };

    const chooseKit = (preset: TagPreset): void => {
        setNearnessView("summary");
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
        nearnessDraft.setFilter(filterNearness ?? emptyTagFilter());
        setNearnessView("filterEditor");
    };

    const commitNearnessDraft = (): void => {
        if (isTagFilterActive(nearnessDraft.filter)) {
            setOrdering({
                kind: "nearness",
                filter: nearnessDraft.filter,
                source: "filter",
            });
        } else {
            clearNearness();
        }
        setNearnessView("summary");
    };

    const renderDirectionSection = (
        section: DirectionSortSection,
    ): JSX.Element | null => {
        if (section.kind === "tagFilterFit" && !tagFilterFitAvailable) {
            return null;
        }
        const direction =
            ordering?.kind === section.kind ? ordering.direction : "";
        return (
            <RadioOptionsSection
                title={section.title}
                {...sectionState(section.kind, direction !== "")}
                value={direction}
                onChange={(next) => selectDirection(section.kind, next)}
                options={section.options}
            >
                {section.kind === "viewportFit" ? (
                    <ViewportTargetInputs />
                ) : null}
                {section.kind === "relative" && direction !== "" ? (
                    <div className="px-2 pb-1">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={reapplyRelativeSort}
                        >
                            New start
                        </Button>
                    </div>
                ) : null}
            </RadioOptionsSection>
        );
    };

    const renderNearnessBody = (): ReactNode => {
        if (nearnessView === "filterEditor") {
            return (
                <div className="flex max-h-[min(70dvh,28rem)] flex-col gap-2 overflow-hidden px-1 pb-2">
                    <TagFilterEditor
                        filter={nearnessDraft.filter}
                        actions={nearnessDraft.actions}
                        counts={counts}
                        emptyDescription="No nearness filter yet"
                        className="min-h-0 flex-1"
                    />
                    <div className="flex flex-wrap gap-1.5 px-1">
                        <Button
                            type="button"
                            size="sm"
                            onClick={commitNearnessDraft}
                        >
                            Done
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setNearnessView("summary")}
                        >
                            Back
                        </Button>
                    </div>
                </div>
            );
        }
        if (nearnessView === "kitPicker") {
            return (
                <KitPicker
                    presets={presets}
                    selectedPresetId={selectedKit?.id}
                    excludedIds={excludedKitLikenessIds}
                    presenceCountById={kitPresenceCountById}
                    onPick={chooseKit}
                    onToggleExcluded={toggleKitLikenessExcluded}
                    onBack={() => setNearnessView("summary")}
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
                        onChange={() => setNearnessView("kitPicker")}
                        onOff={() => setOrdering(undefined)}
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
                        onOff={() => setOrdering(undefined)}
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
                    onClick={() => setNearnessView("kitPicker")}
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

    const sortSections = [
        ...DIRECTION_SORT_SECTIONS.map(renderDirectionSection),
        <OptionsSection
            title="Nearness"
            {...sectionState(
                "nearness",
                filterNearness !== undefined ||
                    selectedKit !== undefined ||
                    nearnessView !== "summary",
            )}
        >
            <div className="flex flex-col gap-1.5 px-1 pb-2">
                {renderNearnessBody()}
            </div>
        </OptionsSection>,
    ].filter((section) => section !== null);

    const sortPanel = (
        <>
            <div className="px-1 pb-1">
                <Button
                    type="button"
                    variant={sortActive ? "outline" : "secondary"}
                    size="sm"
                    className="w-full"
                    aria-pressed={!sortActive}
                    disabled={!sortActive}
                    onClick={() => {
                        // Never clears a shuffle: "None" is for sorts only.
                        if (sortActive) {
                            setOrdering(undefined);
                        }
                        setNearnessView("summary");
                    }}
                >
                    None
                </Button>
            </div>
            <DropdownMenuSeparator />
            {sortSections.map((section, index) => (
                <div key={index}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    {section}
                </div>
            ))}
        </>
    );

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
                        sortPanel
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

/** Load the embedding / quality indexes the active ordering depends on. */
const useHydrateIndexesForOrdering = (
    ordering: GalleryOrdering | undefined,
    hasKits: boolean,
): void => {
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.ensureHydrated);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.ensureHydrated);

    const kind = ordering?.kind;
    const needsEmbeddings =
        kind === "tagFilterFit" ||
        kind === "relative" ||
        kind === "nearness" ||
        hasKits;

    useEffect(() => {
        if (kind !== "imageQuality" || qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [hydrateQuality, kind, qualityHydrated]);

    useEffect(() => {
        if (!needsEmbeddings || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, needsEmbeddings]);
};

/**
 * Shown files that fit each kit. Tag probabilities come from the worker;
 * counts are derived here so toggling a kit recounts immediately. Only
 * computed while the menu (where counts show) is open.
 */
const useKitPresenceCounts = (
    presets: TagPreset[],
    matchingFiles: EnteFile[],
    menuOpen: boolean,
): ReadonlyMap<string, number> => {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.typeConfig.includeInKitNearnessByName,
    );
    const embeddingCount = useEmbeddingIndexStore((s) => s.entries.size);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const excludedKitLikenessIds = useUIStore(
        (s) => s.excludedKitLikenessIds,
    );
    const [presenceEstimate, setPresenceEstimate] =
        useState<KitPresenceEstimate | null>(null);

    useEffect(() => {
        if (!presets.length || !embeddingHydrated || !menuOpen) {
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            estimateKitPresenceInWorker({
                kits: presets,
                libraryFiles: allFiles,
                viewFiles: matchingFiles,
                embeddings: useEmbeddingIndexStore.getState().entries,
                fileIdsByTag,
                includeInKitNearnessByName,
            })
                .then((estimate) => {
                    if (!cancelled && estimate) {
                        setPresenceEstimate(estimate);
                    }
                })
                .catch((error: unknown) => {
                    console.warn("Kit presence unavailable", error);
                });
        }, 160);
        return (): void => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        allFiles,
        embeddingCount,
        embeddingHydrated,
        fileIdsByTag,
        includeInKitNearnessByName,
        matchingFiles,
        menuOpen,
        presets,
    ]);

    return useMemo((): ReadonlyMap<string, number> => {
        if (!presets.length || !menuOpen) {
            return new Map();
        }
        return countKitPresence(
            presets,
            matchingFiles.map((file) => file.id),
            fileIdsByTag,
            (embeddingHydrated ? presenceEstimate : null) ?? {
                tagNames: [],
                candidateIds: [],
                tagProbabilities: new Float32Array(0),
            },
            excludedKitLikenessIds,
        );
    }, [
        excludedKitLikenessIds,
        embeddingHydrated,
        fileIdsByTag,
        matchingFiles,
        menuOpen,
        presenceEstimate,
        presets,
    ]);
};

/** Fresh random seed for a new relative-sort tip. */
const newSeed = (): number => Date.now();

const kitLabel = (
    preset: TagPreset,
    presenceCountById: ReadonlyMap<string, number>,
): string => {
    const count = presenceCountById.get(preset.id);
    return count === undefined ? preset.name : `${preset.name} (${count})`;
};

/** Search box and list for choosing the kit to sort nearness by. */
function KitPicker({
    presets,
    selectedPresetId,
    excludedIds,
    presenceCountById,
    onPick,
    onToggleExcluded,
    onBack,
}: {
    presets: TagPreset[];
    selectedPresetId: string | undefined;
    /** Kits excluded from rival penalties; listed last but still pickable. */
    excludedIds: ReadonlySet<string>;
    /** Shown files assigned to each kit as closest fit. */
    presenceCountById: ReadonlyMap<string, number>;
    onPick: (preset: TagPreset) => void;
    onToggleExcluded: (presetId: string) => void;
    onBack: () => void;
}): JSX.Element {
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

    const renderList = (): ReactNode => {
        if (presets.length === 0) {
            return (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                    Create kits in Manage → Tags
                </p>
            );
        }
        if (filteredKits.length === 0) {
            return (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                    No kits match
                </p>
            );
        }
        return filteredKits.map((preset) => {
            const excluded = excludedIds.has(preset.id);
            return (
                <div
                    key={preset.id}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                        preset.id === selectedPresetId ?
                            "bg-accent text-accent-foreground" :
                            excluded ?
                                "text-muted-foreground hover:bg-accent/40" :
                                "hover:bg-accent/60",
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
        });
    };

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
                {renderList()}
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

/** Width / height fields for the viewport the "Viewport fit" sort targets. */
function ViewportTargetInputs(): JSX.Element {
    const width = useUIStore((s) => s.viewportTargetWidth);
    const height = useUIStore((s) => s.viewportTargetHeight);
    const setViewportTargetSize = useUIStore((s) => s.setViewportTargetSize);
    const resetViewportTargetToDevice = useUIStore(
        (s) => s.resetViewportTargetToDevice,
    );
    const [drafts, setDrafts] = useState({
        width: String(width),
        height: String(height),
    });

    const commit = (axis: "width" | "height"): void => {
        const parsed = Number.parseInt(drafts[axis], 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setDrafts({ ...drafts, [axis]: String({ width, height }[axis]) });
            return;
        }
        const next = Math.max(1, Math.round(parsed));
        setViewportTargetSize(
            axis === "width" ? next : width,
            axis === "height" ? next : height,
        );
        setDrafts({ ...drafts, [axis]: String(next) });
    };

    return (
        <div className="mt-2 flex flex-col gap-1.5 px-2 pb-1">
            <div className="flex items-center gap-1.5">
                <ViewportSizeInput
                    axis="W"
                    value={drafts.width}
                    onChange={(value) => setDrafts({ ...drafts, width: value })}
                    onCommit={() => commit("width")}
                    ariaLabel="Target viewport width"
                />
                <ViewportSizeInput
                    axis="H"
                    value={drafts.height}
                    onChange={(value) =>
                        setDrafts({ ...drafts, height: value })}
                    onCommit={() => commit("height")}
                    ariaLabel="Target viewport height"
                />
            </div>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 justify-start px-1 text-xs text-muted-foreground"
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    resetViewportTargetToDevice();
                    const size = useUIStore.getState();
                    setDrafts({
                        width: String(size.viewportTargetWidth),
                        height: String(size.viewportTargetHeight),
                    });
                }}
            >
                Use device
            </Button>
        </div>
    );
}

function ViewportSizeInput({
    axis,
    value,
    onChange,
    onCommit,
    ariaLabel,
}: {
    axis: string;
    value: string;
    onChange: (value: string) => void;
    onCommit: () => void;
    ariaLabel: string;
}): JSX.Element {
    return (
        <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
            <span className="shrink-0">{axis}</span>
            <Input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onCommit}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                        event.currentTarget.blur();
                    }
                }}
                onClick={(event) => event.stopPropagation()}
                className="h-7 px-1.5 text-xs tabular-nums"
                aria-label={ariaLabel}
            />
        </label>
    );
}
