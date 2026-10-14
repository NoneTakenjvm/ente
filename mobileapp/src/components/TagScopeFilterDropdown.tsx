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
    RotatedScope,
    TagFilterSelection,
    TagScope,
} from "@/lib/tag-filter";
import {
    describeTagFilter,
    emptyTagFilter,
    isTagFilterActive,
} from "@/lib/tag-filter";
import type { ViewportFitSort } from "@/lib/viewport-fit";
import type { ImageQualitySort } from "@/lib/image-quality";
import type { RelativeSort } from "@/lib/relative-sort";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { ImageSizeSort, UploadedAtSort } from "@/lib/sort-files";
import type { TagPreset } from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui-store";

type OptionsSectionId =
    "tagPresence" |
    "favourites" |
    "manualCrop" |
    "manualRotate" |
    "mediaType" |
    "uploadedAt" |
    "viewportFit" |
    "imageSize" |
    "imageQuality" |
    "tagFilterFit" |
    "relative" |
    "nearness";

interface RadioOption<T extends string> {
    value: T;
    label: string;
    /** Shown beside the label when set. */
    count?: number;
}

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

/** An {@link OptionsSection} holding one radio group; `children` follow it. */
function RadioOptionsSection<T extends string>({
    title,
    open,
    onToggle,
    value,
    options,
    onChange,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    value: T | "";
    options: readonly RadioOption<T>[];
    onChange: (value: T) => void;
    children?: ReactNode;
}): JSX.Element {
    return (
        <OptionsSection title={title} open={open} onToggle={onToggle}>
            <DropdownMenuRadioGroup
                value={value}
                onValueChange={(next) => {
                    const option = options.find(
                        (candidate) => candidate.value === next,
                    );
                    if (option) {
                        onChange(option.value);
                    }
                }}
            >
                {options.map((option) => (
                    <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        closeOnClick
                    >
                        {option.count === undefined ? (
                            option.label
                        ) : (
                            <span className="flex w-full items-center justify-between gap-2">
                                {option.label}
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {option.count}
                                </span>
                            </span>
                        )}
                    </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
            {children}
        </OptionsSection>
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
    onReapply?: () => void;
    onChange: () => void;
    onOff: () => void;
}): JSX.Element {
    return (
        <div className="flex flex-wrap gap-1.5 px-1">
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onReapply?.()}
                disabled={onReapply === undefined}
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
    tagScope: TagScope;
    onTagScopeChange: (scope: TagScope) => void;
    favoritesScope: FavoritesScope;
    onFavoritesScopeChange: (scope: FavoritesScope) => void;
    mediaScope: MediaScope;
    onMediaScopeChange: (scope: MediaScope) => void;
    croppedScope: CroppedScope;
    onCroppedScopeChange: (scope: CroppedScope) => void;
    rotatedScope: RotatedScope;
    onRotatedScopeChange: (scope: RotatedScope) => void;
    /** Gallery-only: reorder by viewer viewport fit (not a hide-filter). */
    viewportFitSort?: ViewportFitSort;
    onViewportFitSortChange?: (mode: ViewportFitSort) => void;
    /** Gallery-only: reorder by last update time (not a hide-filter). */
    uploadedAtSort?: UploadedAtSort;
    onUploadedAtSortChange?: (mode: UploadedAtSort) => void;
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
     * Shown files assigned to each kit as closest fit. A file with evidence
     * counts for exactly one remaining kit; excluded kits stay at 0.
     */
    kitPresenceCountById?: ReadonlyMap<string, number>;
    /** Menu opened or closed; lets the parent compute counts only while shown. */
    onMenuOpenChange?: (open: boolean) => void;
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

export function TagScopeFilterDropdown({
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    croppedCount,
    notCroppedCount,
    tagScope,
    onTagScopeChange,
    favoritesScope,
    onFavoritesScopeChange,
    mediaScope,
    onMediaScopeChange,
    croppedScope,
    onCroppedScopeChange,
    rotatedScope,
    onRotatedScopeChange,
    viewportFitSort,
    onViewportFitSortChange,
    uploadedAtSort,
    onUploadedAtSortChange,
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
    onMenuOpenChange,
    excludedKitLikenessIds,
    onToggleKitLikenessExcluded,
    kitLikenessRivalPenalty,
    onKitLikenessRivalPenaltyChange,
}: TagScopeFilterDropdownProps): JSX.Element {
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

    const showViewportFit = onViewportFitSortChange !== undefined;
    const fitSort = viewportFitSort ?? "none";
    const showUploadedAt = onUploadedAtSortChange !== undefined;
    const uploadedSort = uploadedAtSort ?? "none";
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
        showUploadedAt ||
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

    /** Open/toggle props for a section; `forceOpen` pins it open while active. */
    const sectionState = (
        id: OptionsSectionId,
        forceOpen: boolean,
    ): { open: boolean; onToggle: () => void } => ({
        open: forceOpen || manualOpenSections.has(id),
        onToggle: () => {
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
        },
    });

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

    const openKitPicker = (): void => {
        setNearnessEditorOpen(false);
        setKitPickerOpen(true);
    };

    const commitNearnessDraft = (): void => {
        if (!onNearnessFilterChange) {
            return;
        }
        onNearnessFilterChange(
            isTagFilterActive(nearnessDraft.filter) ?
                nearnessDraft.filter :
                undefined,
        );
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
        croppedScope !== "all" ||
        rotatedScope !== "all";

    const sortActive =
        fitSort !== "none" ||
        uploadedSort !== "none" ||
        sizeSort !== "none" ||
        qualitySort !== "none" ||
        tagFitSort !== "none" ||
        relSort !== "none" ||
        filterNearnessActive ||
        kitLikenessActive;

    const optionsActive = filterActive || sortActive;

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
                        onTagScopeChange("all");
                        onFavoritesScopeChange("all");
                        onCroppedScopeChange("all");
                        onRotatedScopeChange("all");
                        onMediaScopeChange("all");
                    }}
                >
                    Clear
                </Button>
            </div>
            <DropdownMenuSeparator />
            <RadioOptionsSection<TagScope>
                title="Tag presence"
                {...sectionState("tagPresence", tagScope !== "all")}
                value={tagScope}
                onChange={onTagScopeChange}
                options={[
                    { value: "all", label: "All" },
                    { value: "tagged", label: "Any tag", count: taggedCount },
                    {
                        value: "untagged",
                        label: "No tag",
                        count: untaggedCount,
                    },
                ]}
            />
            <DropdownMenuSeparator />
            <RadioOptionsSection<FavoritesScope>
                title="Favourites"
                {...sectionState("favourites", favoritesScope !== "all")}
                value={favoritesScope}
                onChange={onFavoritesScopeChange}
                options={[
                    { value: "all", label: "All" },
                    {
                        value: "favorites",
                        label: "Favourite",
                        count: favoritesCount,
                    },
                    {
                        value: "not-favorites",
                        label: "Not favourite",
                        count: notFavoritesCount,
                    },
                ]}
            />
            <DropdownMenuSeparator />
            <RadioOptionsSection<CroppedScope>
                title="Manual crop"
                {...sectionState("manualCrop", croppedScope !== "all")}
                value={croppedScope}
                onChange={onCroppedScopeChange}
                options={[
                    { value: "all", label: "All" },
                    {
                        value: "cropped",
                        label: "Cropped",
                        count: croppedCount,
                    },
                    {
                        value: "not-cropped",
                        label: "Not cropped",
                        count: notCroppedCount,
                    },
                ]}
            />
            <DropdownMenuSeparator />
            <RadioOptionsSection<RotatedScope>
                title="Manual rotate"
                {...sectionState("manualRotate", rotatedScope !== "all")}
                value={rotatedScope}
                onChange={onRotatedScopeChange}
                options={[
                    { value: "all", label: "All" },
                    { value: "rotated", label: "Rotated" },
                    { value: "not-rotated", label: "Not rotated" },
                ]}
            />
            <DropdownMenuSeparator />
            <RadioOptionsSection<MediaScope>
                title="Media type"
                {...sectionState("mediaType", mediaScope !== "all")}
                value={mediaScope}
                onChange={onMediaScopeChange}
                options={[
                    { value: "all", label: "All" },
                    { value: "photo", label: "Photo", count: photoCount },
                    { value: "video", label: "Video", count: videoCount },
                ]}
            />
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
                        onBack={() => setNearnessEditorOpen(false)}
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
                        <NearnessActions
                            onReapply={onNearnessReapply}
                            onChange={openKitPicker}
                            onOff={() =>
                                onKitLikenessPresetIdChange?.(undefined)
                            }
                        />
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
                        <NearnessActions
                            onReapply={onNearnessReapply}
                            onChange={openNearnessEditor}
                            onOff={() => onNearnessFilterChange?.(undefined)}
                        />
                    </>
                ) : (
                    <div className="flex flex-wrap gap-1.5 px-1">
                        {showKitLikeness ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={openKitPicker}
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

    const sortSections: JSX.Element[] = [];
    if (showUploadedAt) {
        sortSections.push(
            <RadioOptionsSection<UploadedAtSort>
                key="uploadedAt"
                title="Uploaded At"
                {...sectionState("uploadedAt", uploadedSort !== "none")}
                value={uploadedSort === "none" ? "" : uploadedSort}
                onChange={onUploadedAtSortChange}
                options={[
                    { value: "newest", label: "Newest" },
                    { value: "oldest", label: "Oldest" },
                ]}
            />,
        );
    }
    if (showViewportFit) {
        sortSections.push(
            <RadioOptionsSection<ViewportFitSort>
                key="viewportFit"
                title="Viewport fit"
                {...sectionState("viewportFit", fitSort !== "none")}
                value={fitSort === "none" ? "" : fitSort}
                onChange={onViewportFitSortChange}
                options={[
                    { value: "best", label: "Best Fit" },
                    { value: "worst", label: "Worst Fit" },
                ]}
            >
                <div className="mt-2 flex flex-col gap-1.5 px-2 pb-1">
                    <div className="flex items-center gap-1.5">
                        <ViewportSizeInput
                            axis="W"
                            value={viewportWidthDraft}
                            onChange={setViewportWidthDraft}
                            onCommit={commitViewportWidth}
                            ariaLabel="Target viewport width"
                        />
                        <ViewportSizeInput
                            axis="H"
                            value={viewportHeightDraft}
                            onChange={setViewportHeightDraft}
                            onCommit={commitViewportHeight}
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
                            handleUseDeviceViewport();
                        }}
                    >
                        Use device
                    </Button>
                </div>
            </RadioOptionsSection>,
        );
    }
    if (showImageSize) {
        sortSections.push(
            <RadioOptionsSection<ImageSizeSort>
                key="imageSize"
                title="Image size"
                {...sectionState("imageSize", sizeSort !== "none")}
                value={sizeSort === "none" ? "" : sizeSort}
                onChange={onImageSizeSortChange}
                options={[
                    { value: "largest", label: "Largest" },
                    { value: "smallest", label: "Smallest" },
                ]}
            />,
        );
    }
    if (showImageQuality) {
        sortSections.push(
            <RadioOptionsSection<ImageQualitySort>
                key="imageQuality"
                title="Image quality"
                {...sectionState("imageQuality", qualitySort !== "none")}
                value={qualitySort === "none" ? "" : qualitySort}
                onChange={onImageQualitySortChange}
                options={[
                    { value: "worst", label: "Worst" },
                    { value: "best", label: "Best" },
                ]}
            />,
        );
    }
    if (showTagFilterFit) {
        sortSections.push(
            <RadioOptionsSection<TagFilterFitSort>
                key="tagFilterFit"
                title="Tag filter fit"
                {...sectionState("tagFilterFit", tagFitSort !== "none")}
                value={tagFitSort === "none" ? "" : tagFitSort}
                onChange={onTagFilterFitSortChange}
                options={[
                    { value: "best", label: "Best fit" },
                    { value: "worst", label: "Worst fit" },
                ]}
            />,
        );
    }
    if (showRelative) {
        sortSections.push(
            <RadioOptionsSection<RelativeSort>
                key="relative"
                title="Relative"
                {...sectionState("relative", relSort !== "none")}
                value={relSort === "none" ? "" : relSort}
                onChange={onRelativeSortChange}
                options={[
                    { value: "closest", label: "Closest" },
                    { value: "furthest", label: "Furthest" },
                ]}
            >
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
            </RadioOptionsSection>,
        );
    }
    if (showNearness || showKitLikeness) {
        sortSections.push(
            <OptionsSection
                key="nearness"
                title="Nearness"
                {...sectionState("nearness", nearnessSectionActive)}
            >
                {nearnessPanel}
            </OptionsSection>,
        );
    }

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
                        onUploadedAtSortChange?.("none");
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
            {sortSections.flatMap((section, index) =>
                index === 0 ?
                    [section] :
                    [
                        <DropdownMenuSeparator key={`separator-${section.key}`} />,
                        section,
                    ])}
        </>
    );

    const triggerLabel = showSort ? "Options" : "Filter";
    const TriggerIcon = showSort ? SlidersHorizontal : Filter;

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                onMenuOpenChange?.(open);
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
                                "Filter by tag presence, favourites, media type, crop, and rotation"
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
                                    setNearnessEditorOpen(false);
                                    closeKitPicker();
                                }}
                            />
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
