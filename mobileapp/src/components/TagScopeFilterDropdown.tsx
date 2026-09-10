import { useMemo, useState, type JSX, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, Filter, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import type {
    CroppedScope,
    FavoritesScope,
    MediaScope,
    TagFilterSelection,
    TagScope,
} from "@/lib/tags";
import {
    describeTagFilter,
    emptyTagFilter,
    isTagFilterActive,
} from "@/lib/tags";
import type { ViewportFitSort } from "@/lib/viewport-fit";
import type { ImageQualitySort } from "@/lib/image-quality";
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { RelativeSort } from "@/lib/relative-sort";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { UpdatedAtSort } from "@/lib/updated-at-sort";
import type { TagPreset } from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";

type OptionsSectionId =
    "tagPresence" |
    "favourites" |
    "manualCrop" |
    "mediaType" |
    "updatedAt" |
    "viewportFit" |
    "imageSize" |
    "imageQuality" |
    "tagFilterFit" |
    "relative" |
    "nearness";

/**
 * Collapsible Options block (Sort or Filter). Stays open while its choice is
 * active; otherwise the title toggles the body.
 */
function OptionsSection({
    title,
    open,
    onToggle,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}): JSX.Element {
    return (
        <DropdownMenuGroup>
            <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                aria-expanded={open}
                onClick={(event) => {
                    event.preventDefault();
                    onToggle();
                }}
            >
                <span>{title}</span>
                <ChevronDown
                    className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        open && "rotate-180",
                    )}
                    aria-hidden
                />
            </button>
            {open ? children : null}
        </DropdownMenuGroup>
    );
}

/** Lazy to avoid a cycle: TagQueryEditor → TagScopeFilterDropdown → editor. */
const NearnessFilterEditor = dynamic(
    () =>
        import("@/components/NearnessFilterEditor").then((mod) => ({
            default: mod.NearnessFilterEditor,
        })),
    { ssr: false },
);

interface TagScopeFilterDropdownProps {
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    photoCount: number;
    videoCount: number;
    croppedCount: number;
    notCroppedCount: number;
    tagScope?: TagScope;
    onTagScopeChange?: (scope: TagScope) => void;
    favoritesScope?: FavoritesScope;
    onFavoritesScopeChange?: (scope: FavoritesScope) => void;
    mediaScope?: MediaScope;
    onMediaScopeChange?: (scope: MediaScope) => void;
    croppedScope?: CroppedScope;
    onCroppedScopeChange?: (scope: CroppedScope) => void;
    /** Gallery-only: reorder by viewer viewport fit (not a hide-filter). */
    viewportFitSort?: ViewportFitSort;
    onViewportFitSortChange?: (mode: ViewportFitSort) => void;
    /** Gallery-only: reorder by last update time (not a hide-filter). */
    updatedAtSort?: UpdatedAtSort;
    onUpdatedAtSortChange?: (mode: UpdatedAtSort) => void;
    /** Gallery-only: reorder by pixel area (not a hide-filter). */
    imageSizeSort?: ImageSizeSort;
    onImageSizeSortChange?: (mode: ImageSizeSort) => void;
    /** Gallery-only: reorder by persisted image quality score. */
    imageQualitySort?: ImageQualitySort;
    onImageQualitySortChange?: (mode: ImageQualitySort) => void;
    /**
     * Gallery-only: CLIP fit to the active tag/kit filter. Pass a change
     * handler only when tag clauses are active (caller gates visibility).
     */
    tagFilterFitSort?: TagFilterFitSort;
    onTagFilterFitSortChange?: (mode: TagFilterFitSort) => void;
    /**
     * Gallery-only: greedy CLIP nearest/farthest-neighbor chain through the
     * visible set (random start; each file once).
     */
    relativeSort?: RelativeSort;
    onRelativeSortChange?: (mode: RelativeSort) => void;
    /** Pick a new random start for the relative chain. */
    onRelativeReapply?: () => void;
    /**
     * Gallery-only: reorder by CLIP nearness to seeds matching this filter
     * (independent of the main gallery filter).
     */
    nearnessFilter?: TagFilterSelection;
    onNearnessFilterChange?: (filter: TagFilterSelection | undefined) => void;
    /** Rebuild frozen nearness order from the current library. */
    onNearnessReapply?: () => void;
    /**
     * Which nearness entry is active — only that Sort panel shows as selected.
     */
    nearnessSource?: "kit" | "filter";
    /**
     * Gallery-only: kit likeness picker. Selecting a kit sets the nearness
     * filter to that kit; shares the nearness sort path.
     */
    kitLikenessPresets?: TagPreset[];
    kitLikenessPresetId?: string;
    onKitLikenessPresetIdChange?: (presetId: string | undefined) => void;
    /**
     * Shown files assigned to each kit as closest fit. Every file counts for
     * exactly one remaining kit; excluded kits stay at 0.
     */
    kitPresenceCountById?: ReadonlyMap<string, number>;
    /**
     * Kit ids excluded from rival penalties; listed at the bottom of Choose kit.
     * Still selectable as the active likeness kit.
     */
    excludedKitLikenessIds?: ReadonlySet<string>;
    onToggleKitLikenessExcluded?: (presetId: string) => void;
    /** Soft rival-kit steal penalty while Kit likeness is on (default on). */
    kitLikenessRivalPenalty?: boolean;
    onKitLikenessRivalPenaltyChange?: (enabled: boolean) => void;
}

const isTagScope = (value: unknown): value is TagScope =>
    value === "all" || value === "tagged" || value === "untagged";

const isFavoritesScope = (value: unknown): value is FavoritesScope =>
    value === "all" || value === "favorites" || value === "not-favorites";

const isMediaScope = (value: unknown): value is MediaScope =>
    value === "all" || value === "photo" || value === "video";

const isCroppedScope = (value: unknown): value is CroppedScope =>
    value === "all" || value === "cropped" || value === "not-cropped";

const isViewportFitSort = (value: unknown): value is ViewportFitSort =>
    value === "none" || value === "best" || value === "worst";

const isUpdatedAtSort = (value: unknown): value is UpdatedAtSort =>
    value === "none" || value === "newest" || value === "oldest";

const isImageSizeSort = (value: unknown): value is ImageSizeSort =>
    value === "none" || value === "largest" || value === "smallest";

const isImageQualitySort = (value: unknown): value is ImageQualitySort =>
    value === "none" || value === "worst" || value === "best";

const isTagFilterFitSort = (value: unknown): value is TagFilterFitSort =>
    value === "none" || value === "best" || value === "worst";

const isRelativeSort = (value: unknown): value is RelativeSort =>
    value === "none" || value === "closest" || value === "furthest";

export function TagScopeFilterDropdown({
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    croppedCount,
    notCroppedCount,
    tagScope: controlledScope,
    onTagScopeChange,
    favoritesScope: controlledFavoritesScope,
    onFavoritesScopeChange,
    mediaScope: controlledMediaScope,
    onMediaScopeChange,
    croppedScope: controlledCroppedScope,
    onCroppedScopeChange,
    viewportFitSort,
    onViewportFitSortChange,
    updatedAtSort,
    onUpdatedAtSortChange,
    imageSizeSort,
    onImageSizeSortChange,
    imageQualitySort,
    onImageQualitySortChange,
    tagFilterFitSort,
    onTagFilterFitSortChange,
    relativeSort,
    onRelativeSortChange,
    onRelativeReapply,
    nearnessFilter,
    onNearnessFilterChange,
    onNearnessReapply,
    nearnessSource,
    kitLikenessPresets,
    kitLikenessPresetId,
    onKitLikenessPresetIdChange,
    kitPresenceCountById,
    excludedKitLikenessIds,
    onToggleKitLikenessExcluded,
    kitLikenessRivalPenalty,
    onKitLikenessRivalPenaltyChange,
}: TagScopeFilterDropdownProps): JSX.Element {
    const storeFilter = useTagStore((s) => s.tagFilter);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const setMediaScope = useTagStore((s) => s.setMediaScope);
    const setCroppedScope = useTagStore((s) => s.setCroppedScope);
    const viewportTargetWidth = useUIStore((s) => s.viewportTargetWidth);
    const viewportTargetHeight = useUIStore((s) => s.viewportTargetHeight);
    const setViewportTargetSize = useUIStore((s) => s.setViewportTargetSize);
    const resetViewportTargetToDevice = useUIStore(
        (s) => s.resetViewportTargetToDevice,
    );
    const [viewportWidthDraft, setViewportWidthDraft] = useState(
        () => String(useUIStore.getState().viewportTargetWidth),
    );
    const [viewportHeightDraft, setViewportHeightDraft] = useState(
        () => String(useUIStore.getState().viewportTargetHeight),
    );

    const commitViewportWidth = (): void => {
        const parsed = Number.parseInt(viewportWidthDraft, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setViewportWidthDraft(String(viewportTargetWidth));
            return;
        }
        const next = Math.max(1, Math.round(parsed));
        setViewportTargetSize(next, viewportTargetHeight);
        setViewportWidthDraft(String(next));
    };

    const commitViewportHeight = (): void => {
        const parsed = Number.parseInt(viewportHeightDraft, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setViewportHeightDraft(String(viewportTargetHeight));
            return;
        }
        const next = Math.max(1, Math.round(parsed));
        setViewportTargetSize(viewportTargetWidth, next);
        setViewportHeightDraft(String(next));
    };

    const handleUseDeviceViewport = (): void => {
        resetViewportTargetToDevice();
        const size = useUIStore.getState();
        setViewportWidthDraft(String(size.viewportTargetWidth));
        setViewportHeightDraft(String(size.viewportTargetHeight));
    };
    const tagScope = controlledScope ?? storeFilter.tagScope;
    const favoritesScope = controlledFavoritesScope ?? storeFilter.favoritesScope;
    const mediaScope = controlledMediaScope ?? storeFilter.mediaScope;
    const croppedScope = controlledCroppedScope ?? storeFilter.croppedScope;
    const showViewportFit = onViewportFitSortChange !== undefined;
    const fitSort = viewportFitSort ?? "none";
    const showUpdatedAt = onUpdatedAtSortChange !== undefined;
    const updateSort = updatedAtSort ?? "none";
    const showImageSize = onImageSizeSortChange !== undefined;
    const sizeSort = imageSizeSort ?? "none";
    const showImageQuality = onImageQualitySortChange !== undefined;
    const qualitySort = imageQualitySort ?? "none";
    const showTagFilterFit = onTagFilterFitSortChange !== undefined;
    const tagFitSort = tagFilterFitSort ?? "none";
    const showRelative = onRelativeSortChange !== undefined;
    const relSort = relativeSort ?? "none";
    const showNearness = onNearnessFilterChange !== undefined;
    const nearnessActive =
        nearnessFilter !== undefined && isTagFilterActive(nearnessFilter);
    /** Custom filter nearness — not the kit picker entry. */
    const filterNearnessActive =
        nearnessActive && nearnessSource === "filter";
    const showKitLikeness = onKitLikenessPresetIdChange !== undefined;
    const kitPresets = useMemo(
        (): TagPreset[] => kitLikenessPresets ?? [],
        [kitLikenessPresets],
    );
    /** Kit likeness entry — only when entered via Choose kit. */
    const kitLikenessActive =
        nearnessSource === "kit" && kitLikenessPresetId !== undefined;
    const showSort =
        showViewportFit ||
        showUpdatedAt ||
        showImageSize ||
        showImageQuality ||
        showTagFilterFit ||
        showRelative ||
        showNearness ||
        showKitLikeness;

    const [optionsTab, setOptionsTab] = useState<"sort" | "filter">("filter");
    const [nearnessEditorOpen, setNearnessEditorOpen] = useState<boolean>(false);
    const [kitPickerOpen, setKitPickerOpen] = useState<boolean>(false);
    const [kitQuery, setKitQuery] = useState<string>("");
    const [manualOpenSections, setManualOpenSections] = useState<
        ReadonlySet<OptionsSectionId>
    >(() => new Set());
    const nearnessDraft = useTagFilterDraft(emptyTagFilter());

    const isOptionsSectionOpen = (
        id: OptionsSectionId,
        forceOpen: boolean,
    ): boolean => forceOpen || manualOpenSections.has(id);

    const toggleOptionsSection = (
        id: OptionsSectionId,
        forceOpen: boolean,
    ): void => {
        if (forceOpen) {
            return;
        }
        setManualOpenSections((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectedKit = useMemo((): TagPreset | undefined => {
        if (!kitLikenessActive || !kitLikenessPresetId) {
            return undefined;
        }
        return kitPresets.find((preset) => preset.id === kitLikenessPresetId);
    }, [kitLikenessActive, kitLikenessPresetId, kitPresets]);

    const filteredKits = useMemo((): TagPreset[] => {
        const query = kitQuery.trim().toLowerCase();
        const matched = !query ?
            [...kitPresets] :
            kitPresets.filter(
                (preset) =>
                    preset.name.toLowerCase().includes(query) ||
                    preset.tags.some((tag) =>
                        tag.toLowerCase().includes(query)),
            );
        // Included kits first (most fits → more specific → name); excluded last.
        matched.sort((a, b) => {
            const excludedA = excludedKitLikenessIds?.has(a.id) === true;
            const excludedB = excludedKitLikenessIds?.has(b.id) === true;
            if (excludedA !== excludedB) {
                return excludedA ? 1 : -1;
            }
            const countA = kitPresenceCountById?.get(a.id) ?? -1;
            const countB = kitPresenceCountById?.get(b.id) ?? -1;
            if (countB !== countA) {
                return countB - countA;
            }
            if (b.tags.length !== a.tags.length) {
                return b.tags.length - a.tags.length;
            }
            return a.name.localeCompare(b.name);
        });
        return matched;
    }, [
        excludedKitLikenessIds,
        kitPresenceCountById,
        kitPresets,
        kitQuery,
    ]);

    const kitLabel = (preset: TagPreset): string => {
        const count = kitPresenceCountById?.get(preset.id);
        return count === undefined ? preset.name : `${preset.name} (${count})`;
    };

    const openNearnessEditor = (): void => {
        // Fresh draft when switching from kit likeness; keep current when
        // editing an active filter-nearness selection.
        nearnessDraft.setFilter(
            filterNearnessActive && nearnessFilter ?
                nearnessFilter :
                emptyTagFilter(),
        );
        setNearnessEditorOpen(true);
        setKitPickerOpen(false);
        setKitQuery("");
    };

    const closeNearnessEditor = (): void => {
        setNearnessEditorOpen(false);
    };

    const commitNearnessDraft = (): void => {
        if (!onNearnessFilterChange) {
            return;
        }
        if (isTagFilterActive(nearnessDraft.filter)) {
            onNearnessFilterChange(nearnessDraft.filter);
        } else {
            onNearnessFilterChange(undefined);
        }
        setNearnessEditorOpen(false);
    };

    const closeKitPicker = (): void => {
        setKitPickerOpen(false);
        setKitQuery("");
    };

    const filterActive =
        tagScope !== "all" ||
        favoritesScope !== "all" ||
        mediaScope !== "all" ||
        croppedScope !== "all";

    const sortActive =
        fitSort !== "none" ||
        updateSort !== "none" ||
        sizeSort !== "none" ||
        qualitySort !== "none" ||
        tagFitSort !== "none" ||
        relSort !== "none" ||
        filterNearnessActive ||
        kitLikenessActive;

    const optionsActive = filterActive || sortActive;

    const handleScopeChange = (value: TagScope): void => {
        if (onTagScopeChange) {
            onTagScopeChange(value);
        } else {
            setTagScope(value);
        }
    };

    const handleFavoritesScopeChange = (value: FavoritesScope): void => {
        if (onFavoritesScopeChange) {
            onFavoritesScopeChange(value);
        } else {
            setFavoritesScope(value);
        }
    };

    const handleMediaScopeChange = (value: MediaScope): void => {
        if (onMediaScopeChange) {
            onMediaScopeChange(value);
        } else {
            setMediaScope(value);
        }
    };

    const handleCroppedScopeChange = (value: CroppedScope): void => {
        if (onCroppedScopeChange) {
            onCroppedScopeChange(value);
        } else {
            setCroppedScope(value);
        }
    };

    const filterPanel = (
        <>
            <div className="px-1 pb-1">
                <Button
                    type="button"
                    variant={filterActive ? "outline" : "secondary"}
                    size="sm"
                    className="w-full"
                    aria-pressed={!filterActive}
                    disabled={!filterActive}
                    onClick={() => {
                        handleScopeChange("all");
                        handleFavoritesScopeChange("all");
                        handleCroppedScopeChange("all");
                        handleMediaScopeChange("all");
                    }}
                >
                    Clear
                </Button>
            </div>
            <DropdownMenuSeparator />
            <OptionsSection
                title="Tag presence"
                open={isOptionsSectionOpen(
                    "tagPresence",
                    tagScope !== "all",
                )}
                onToggle={() =>
                    toggleOptionsSection("tagPresence", tagScope !== "all")
                }
            >
                <DropdownMenuRadioGroup
                    value={tagScope}
                    onValueChange={(value) => {
                        if (isTagScope(value)) {
                            handleScopeChange(value);
                        }
                    }}
                >
                    <DropdownMenuRadioItem value="all" closeOnClick>
                        All
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="tagged" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Any tag
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {taggedCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="untagged" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            No tag
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {untaggedCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </OptionsSection>
            <DropdownMenuSeparator />
            <OptionsSection
                title="Favourites"
                open={isOptionsSectionOpen(
                    "favourites",
                    favoritesScope !== "all",
                )}
                onToggle={() =>
                    toggleOptionsSection(
                        "favourites",
                        favoritesScope !== "all",
                    )
                }
            >
                <DropdownMenuRadioGroup
                    value={favoritesScope}
                    onValueChange={(value) => {
                        if (isFavoritesScope(value)) {
                            handleFavoritesScopeChange(value);
                        }
                    }}
                >
                    <DropdownMenuRadioItem value="all" closeOnClick>
                        All
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="favorites" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Favourite
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {favoritesCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="not-favorites" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Not favourite
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {notFavoritesCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </OptionsSection>
            <DropdownMenuSeparator />
            <OptionsSection
                title="Manual crop"
                open={isOptionsSectionOpen(
                    "manualCrop",
                    croppedScope !== "all",
                )}
                onToggle={() =>
                    toggleOptionsSection("manualCrop", croppedScope !== "all")
                }
            >
                <DropdownMenuRadioGroup
                    value={croppedScope}
                    onValueChange={(value) => {
                        if (isCroppedScope(value)) {
                            handleCroppedScopeChange(value);
                        }
                    }}
                >
                    <DropdownMenuRadioItem value="all" closeOnClick>
                        All
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="cropped" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Cropped
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {croppedCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="not-cropped" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Not cropped
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {notCroppedCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </OptionsSection>
            <DropdownMenuSeparator />
            <OptionsSection
                title="Media type"
                open={isOptionsSectionOpen("mediaType", mediaScope !== "all")}
                onToggle={() =>
                    toggleOptionsSection("mediaType", mediaScope !== "all")
                }
            >
                <DropdownMenuRadioGroup
                    value={mediaScope}
                    onValueChange={(value) => {
                        if (isMediaScope(value)) {
                            handleMediaScopeChange(value);
                        }
                    }}
                >
                    <DropdownMenuRadioItem value="all" closeOnClick>
                        All
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="photo" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Photo
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {photoCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="video" closeOnClick>
                        <span className="flex w-full items-center justify-between gap-2">
                            Video
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {videoCount}
                            </span>
                        </span>
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            </OptionsSection>
        </>
    );

    const nearnessBusy = nearnessEditorOpen || kitPickerOpen;
    const nearnessSectionActive =
        filterNearnessActive || kitLikenessActive || nearnessBusy;

    const nearnessPanel =
        showNearness || showKitLikeness ? (
            <div className="flex flex-col gap-1.5 px-1 pb-2">
                {nearnessEditorOpen && showNearness ? (
                    <NearnessFilterEditor
                        draft={nearnessDraft}
                        taggedCount={taggedCount}
                        untaggedCount={untaggedCount}
                        favoritesCount={favoritesCount}
                        notFavoritesCount={notFavoritesCount}
                        photoCount={photoCount}
                        videoCount={videoCount}
                        croppedCount={croppedCount}
                        notCroppedCount={notCroppedCount}
                        onDone={commitNearnessDraft}
                        onBack={closeNearnessEditor}
                    />
                ) : kitPickerOpen && showKitLikeness ? (
                    <>
                        <Input
                            value={kitQuery}
                            onChange={(event) =>
                                setKitQuery(event.target.value)
                            }
                            placeholder="Search kits…"
                            className="h-8"
                            onKeyDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                        />
                        <div className="max-h-40 overflow-y-auto overscroll-contain">
                            {kitPresets.length === 0 ? (
                                <p className="px-1 py-2 text-xs text-muted-foreground">
                                    Create kits in Manage → Tags
                                </p>
                            ) : filteredKits.length === 0 ? (
                                <p className="px-1 py-2 text-xs text-muted-foreground">
                                    No kits match
                                </p>
                            ) : (
                                filteredKits.map((preset) => {
                                    const selected =
                                        preset.id === kitLikenessPresetId;
                                    const excluded =
                                        excludedKitLikenessIds?.has(preset.id) ===
                                        true;
                                    return (
                                        <div
                                            key={preset.id}
                                            className={
                                                selected ?
                                                    "flex w-full items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-sm text-accent-foreground" :
                                                    excluded ?
                                                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/40" :
                                                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                                            }
                                        >
                                            {onToggleKitLikenessExcluded ? (
                                                <Checkbox
                                                    checked={!excluded}
                                                    aria-label={
                                                        excluded ?
                                                            `Include ${preset.name}` :
                                                            `Exclude ${preset.name}`
                                                    }
                                                    onClick={(event) =>
                                                        event.stopPropagation()
                                                    }
                                                    onCheckedChange={() => {
                                                        onToggleKitLikenessExcluded(
                                                            preset.id,
                                                        );
                                                    }}
                                                />
                                            ) : null}
                                            <button
                                                type="button"
                                                className="min-w-0 flex-1 truncate text-left"
                                                onClick={() => {
                                                    onKitLikenessPresetIdChange?.(
                                                        preset.id,
                                                    );
                                                    closeKitPicker();
                                                }}
                                            >
                                                {kitLabel(preset)}
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="self-start"
                            onClick={closeKitPicker}
                        >
                            Back
                        </Button>
                    </>
                ) : selectedKit ? (
                    <>
                        <p className="truncate px-1.5 text-sm font-medium">
                            {kitLabel(selectedKit)}
                        </p>
                        <div className="flex flex-wrap gap-1.5 px-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => onNearnessReapply?.()}
                                disabled={onNearnessReapply === undefined}
                            >
                                Reapply
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setNearnessEditorOpen(false);
                                    setKitPickerOpen(true);
                                }}
                            >
                                Change
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    onKitLikenessPresetIdChange?.(undefined)
                                }
                            >
                                Off
                            </Button>
                        </div>
                        {onKitLikenessRivalPenaltyChange ? (
                            <label className="flex items-center gap-2 px-1.5 pt-0.5 text-xs text-muted-foreground">
                                <Switch
                                    checked={kitLikenessRivalPenalty ?? true}
                                    onCheckedChange={(checked) => {
                                        onKitLikenessRivalPenaltyChange(
                                            checked,
                                        );
                                    }}
                                    aria-label="Rival kit penalties"
                                />
                                Rival kit penalties
                            </label>
                        ) : null}
                    </>
                ) : filterNearnessActive && nearnessFilter ? (
                    <>
                        <p className="max-h-16 overflow-auto px-1.5 text-sm font-medium break-words">
                            {describeTagFilter(nearnessFilter)}
                        </p>
                        <div className="flex flex-wrap gap-1.5 px-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => onNearnessReapply?.()}
                                disabled={onNearnessReapply === undefined}
                            >
                                Reapply
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={openNearnessEditor}
                            >
                                Change
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    onNearnessFilterChange?.(undefined)
                                }
                            >
                                Off
                            </Button>
                        </div>
                    </>
                ) : (
                    <div className="flex flex-wrap gap-1.5 px-1">
                        {showKitLikeness ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setNearnessEditorOpen(false);
                                    setKitPickerOpen(true);
                                }}
                            >
                                Choose kit
                            </Button>
                        ) : null}
                        {showNearness ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={openNearnessEditor}
                            >
                                Choose tags
                            </Button>
                        ) : null}
                    </div>
                )}
            </div>
        ) : null;

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
                        onUpdatedAtSortChange?.("none");
                        onViewportFitSortChange?.("none");
                        onImageSizeSortChange?.("none");
                        onImageQualitySortChange?.("none");
                        onTagFilterFitSortChange?.("none");
                        onRelativeSortChange?.("none");
                        onNearnessFilterChange?.(undefined);
                        onKitLikenessPresetIdChange?.(undefined);
                        setNearnessEditorOpen(false);
                        closeKitPicker();
                    }}
                >
                    None
                </Button>
            </div>
            <DropdownMenuSeparator />
            {showUpdatedAt ? (
                <OptionsSection
                    title="Updated At"
                    open={isOptionsSectionOpen(
                        "updatedAt",
                        updateSort !== "none",
                    )}
                    onToggle={() =>
                        toggleOptionsSection("updatedAt", updateSort !== "none")
                    }
                >
                    <DropdownMenuRadioGroup
                        value={updateSort === "none" ? "" : updateSort}
                        onValueChange={(value) => {
                            if (isUpdatedAtSort(value)) {
                                onUpdatedAtSortChange(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="newest" closeOnClick>
                            Newest
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="oldest" closeOnClick>
                            Oldest
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </OptionsSection>
            ) : null}
            {showUpdatedAt && showViewportFit ? <DropdownMenuSeparator /> : null}
            {showViewportFit ? (
                <OptionsSection
                    title="Viewport fit"
                    open={isOptionsSectionOpen("viewportFit", fitSort !== "none")}
                    onToggle={() =>
                        toggleOptionsSection("viewportFit", fitSort !== "none")
                    }
                >
                    <DropdownMenuRadioGroup
                        value={fitSort === "none" ? "" : fitSort}
                        onValueChange={(value) => {
                            if (isViewportFitSort(value)) {
                                onViewportFitSortChange(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="best" closeOnClick>
                            Best Fit
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="worst" closeOnClick>
                            Worst Fit
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <div className="mt-2 flex flex-col gap-1.5 px-2 pb-1">
                        <div className="flex items-center gap-1.5">
                            <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
                                <span className="shrink-0">W</span>
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    step={1}
                                    value={viewportWidthDraft}
                                    onChange={(event) =>
                                        setViewportWidthDraft(event.target.value)
                                    }
                                    onBlur={commitViewportWidth}
                                    onKeyDown={(event) => {
                                        event.stopPropagation();
                                        if (event.key === "Enter") {
                                            event.currentTarget.blur();
                                        }
                                    }}
                                    onClick={(event) => event.stopPropagation()}
                                    className="h-7 px-1.5 text-xs tabular-nums"
                                    aria-label="Target viewport width"
                                />
                            </label>
                            <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
                                <span className="shrink-0">H</span>
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    step={1}
                                    value={viewportHeightDraft}
                                    onChange={(event) =>
                                        setViewportHeightDraft(event.target.value)
                                    }
                                    onBlur={commitViewportHeight}
                                    onKeyDown={(event) => {
                                        event.stopPropagation();
                                        if (event.key === "Enter") {
                                            event.currentTarget.blur();
                                        }
                                    }}
                                    onClick={(event) => event.stopPropagation()}
                                    className="h-7 px-1.5 text-xs tabular-nums"
                                    aria-label="Target viewport height"
                                />
                            </label>
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 justify-start px-1 text-xs text-muted-foreground"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                handleUseDeviceViewport();
                            }}
                        >
                            Use device
                        </Button>
                    </div>
                </OptionsSection>
            ) : null}
            {(showUpdatedAt || showViewportFit) && showImageSize ?
                <DropdownMenuSeparator /> :
                null}
            {showImageSize ? (
                <OptionsSection
                    title="Image size"
                    open={isOptionsSectionOpen("imageSize", sizeSort !== "none")}
                    onToggle={() =>
                        toggleOptionsSection("imageSize", sizeSort !== "none")
                    }
                >
                    <DropdownMenuRadioGroup
                        value={sizeSort === "none" ? "" : sizeSort}
                        onValueChange={(value) => {
                            if (isImageSizeSort(value)) {
                                onImageSizeSortChange(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="largest" closeOnClick>
                            Largest
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="smallest" closeOnClick>
                            Smallest
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </OptionsSection>
            ) : null}
            {(showUpdatedAt || showViewportFit || showImageSize) &&
            showImageQuality ?
                <DropdownMenuSeparator /> :
                null}
            {showImageQuality ? (
                <OptionsSection
                    title="Image quality"
                    open={isOptionsSectionOpen(
                        "imageQuality",
                        qualitySort !== "none",
                    )}
                    onToggle={() =>
                        toggleOptionsSection(
                            "imageQuality",
                            qualitySort !== "none",
                        )
                    }
                >
                    <DropdownMenuRadioGroup
                        value={qualitySort === "none" ? "" : qualitySort}
                        onValueChange={(value) => {
                            if (isImageQualitySort(value)) {
                                onImageQualitySortChange?.(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="worst" closeOnClick>
                            Worst
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="best" closeOnClick>
                            Best
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </OptionsSection>
            ) : null}
            {(showUpdatedAt ||
                showViewportFit ||
                showImageSize ||
                showImageQuality) &&
            showTagFilterFit ?
                <DropdownMenuSeparator /> :
                null}
            {showTagFilterFit ? (
                <OptionsSection
                    title="Tag filter fit"
                    open={isOptionsSectionOpen(
                        "tagFilterFit",
                        tagFitSort !== "none",
                    )}
                    onToggle={() =>
                        toggleOptionsSection(
                            "tagFilterFit",
                            tagFitSort !== "none",
                        )
                    }
                >
                    <DropdownMenuRadioGroup
                        value={tagFitSort === "none" ? "" : tagFitSort}
                        onValueChange={(value) => {
                            if (isTagFilterFitSort(value)) {
                                onTagFilterFitSortChange?.(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="best" closeOnClick>
                            Best fit
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="worst" closeOnClick>
                            Worst fit
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </OptionsSection>
            ) : null}
            {(showUpdatedAt ||
                showViewportFit ||
                showImageSize ||
                showImageQuality ||
                showTagFilterFit) &&
            showRelative ?
                <DropdownMenuSeparator /> :
                null}
            {showRelative ? (
                <OptionsSection
                    title="Relative"
                    open={isOptionsSectionOpen("relative", relSort !== "none")}
                    onToggle={() =>
                        toggleOptionsSection("relative", relSort !== "none")
                    }
                >
                    <DropdownMenuRadioGroup
                        value={relSort === "none" ? "" : relSort}
                        onValueChange={(value) => {
                            if (isRelativeSort(value)) {
                                onRelativeSortChange?.(value);
                            }
                        }}
                    >
                        <DropdownMenuRadioItem value="closest" closeOnClick>
                            Closest
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="furthest" closeOnClick>
                            Furthest
                        </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    {relSort !== "none" && onRelativeReapply ? (
                        <div className="px-2 pb-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-full"
                                onClick={onRelativeReapply}
                            >
                                New start
                            </Button>
                        </div>
                    ) : null}
                </OptionsSection>
            ) : null}
            {(showUpdatedAt ||
                showViewportFit ||
                showImageSize ||
                showImageQuality ||
                showTagFilterFit ||
                showRelative) &&
            (showNearness || showKitLikeness) ?
                <DropdownMenuSeparator /> :
                null}
            {showNearness || showKitLikeness ? (
                <OptionsSection
                    title="Nearness"
                    open={isOptionsSectionOpen("nearness", nearnessSectionActive)}
                    onToggle={() =>
                        toggleOptionsSection("nearness", nearnessSectionActive)
                    }
                >
                    {nearnessPanel}
                </OptionsSection>
            ) : null}
        </>
    );

    const triggerLabel = showSort ? "Options" : "Filter";
    const TriggerIcon = showSort ? SlidersHorizontal : Filter;

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                if (open) {
                    setOptionsTab(sortActive ? "sort" : "filter");
                    return;
                }
                setNearnessEditorOpen(false);
                closeKitPicker();
            }}
        >
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={optionsActive ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label={
                            showSort ?
                                "Gallery options: sort and filter" :
                                "Filter by tag presence, favourites, media type, and crop"
                        }
                    >
                        <TriggerIcon className="size-3.5 shrink-0" />
                        {triggerLabel}
                    </Button>
                }
            />
            <DropdownMenuContent
                align="start"
                className={cn(
                    "p-1.5",
                    nearnessEditorOpen || kitPickerOpen ?
                        "w-[min(100vw-1.5rem,24rem)] max-w-[min(100vw-1.5rem,24rem)]" :
                        "w-56",
                )}
            >
                {showSort ? (
                    <div className="flex flex-col gap-2">
                        <div
                            className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px]"
                            role="tablist"
                            aria-label="Options section"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={optionsTab === "sort"}
                                className={cn(
                                    "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors",
                                    optionsTab === "sort" ?
                                        "bg-background text-foreground shadow-sm" :
                                        "text-foreground/60 hover:text-foreground",
                                )}
                                onClick={() => setOptionsTab("sort")}
                            >
                                Sort
                                {sortActive ? (
                                    <span className="size-1.5 rounded-full bg-foreground" />
                                ) : null}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={optionsTab === "filter"}
                                className={cn(
                                    "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors",
                                    optionsTab === "filter" ?
                                        "bg-background text-foreground shadow-sm" :
                                        "text-foreground/60 hover:text-foreground",
                                )}
                                onClick={() => {
                                    setOptionsTab("filter");
                                    setNearnessEditorOpen(false);
                                    closeKitPicker();
                                }}
                            >
                                Filter
                                {filterActive ? (
                                    <span className="size-1.5 rounded-full bg-foreground" />
                                ) : null}
                            </button>
                        </div>
                        {optionsTab === "sort" ? sortPanel : filterPanel}
                    </div>
                ) : (
                    filterPanel
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
