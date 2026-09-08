import { useMemo, useState, type JSX } from "react";
import dynamic from "next/dynamic";
import { Filter, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { RelativeSort } from "@/lib/relative-sort";
import type { TagFilterFitSort } from "@/lib/tag-filter-fit-sort";
import type { TagPreset } from "@/lib/tag-presets";
import { formatKitFitPercent } from "@/lib/kit-nearness-sort";
import { cn } from "@/lib/utils";
import { useTagStore } from "@/stores/tag-store";

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
    /** Gallery-only: reorder by pixel area (not a hide-filter). */
    imageSizeSort?: ImageSizeSort;
    onImageSizeSortChange?: (mode: ImageSizeSort) => void;
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
     * Gallery-only: kit likeness picker (claim % on visible set). Selecting a
     * kit sets the nearness filter to that kit; shares the nearness sort path.
     */
    kitLikenessPresets?: TagPreset[];
    kitLikenessPresetId?: string;
    onKitLikenessPresetIdChange?: (presetId: string | undefined) => void;
    /**
     * Best-fit share of CLIP-embedded visible files per kit id (0..1).
     */
    kitLikenessFitShareById?: ReadonlyMap<string, number>;
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

const isImageSizeSort = (value: unknown): value is ImageSizeSort =>
    value === "none" || value === "largest" || value === "smallest";

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
    imageSizeSort,
    onImageSizeSortChange,
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
    kitLikenessFitShareById,
    kitLikenessRivalPenalty,
    onKitLikenessRivalPenaltyChange,
}: TagScopeFilterDropdownProps): JSX.Element {
    const storeFilter = useTagStore((s) => s.tagFilter);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const setMediaScope = useTagStore((s) => s.setMediaScope);
    const setCroppedScope = useTagStore((s) => s.setCroppedScope);
    const tagScope = controlledScope ?? storeFilter.tagScope;
    const favoritesScope = controlledFavoritesScope ?? storeFilter.favoritesScope;
    const mediaScope = controlledMediaScope ?? storeFilter.mediaScope;
    const croppedScope = controlledCroppedScope ?? storeFilter.croppedScope;
    const showViewportFit = onViewportFitSortChange !== undefined;
    const fitSort = viewportFitSort ?? "none";
    const showImageSize = onImageSizeSortChange !== undefined;
    const sizeSort = imageSizeSort ?? "none";
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
        showImageSize ||
        showTagFilterFit ||
        showRelative ||
        showNearness ||
        showKitLikeness;

    const [optionsTab, setOptionsTab] = useState<"sort" | "filter">("filter");
    const [nearnessEditorOpen, setNearnessEditorOpen] = useState<boolean>(false);
    const [kitPickerOpen, setKitPickerOpen] = useState<boolean>(false);
    const [kitQuery, setKitQuery] = useState<string>("");
    const nearnessDraft = useTagFilterDraft(emptyTagFilter());

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
        matched.sort((a, b) => {
            const shareA = kitLikenessFitShareById?.get(a.id) ?? 0;
            const shareB = kitLikenessFitShareById?.get(b.id) ?? 0;
            if (shareB !== shareA) {
                return shareB - shareA;
            }
            return a.name.localeCompare(b.name);
        });
        return matched;
    }, [kitLikenessFitShareById, kitPresets, kitQuery]);

    const kitLabel = (preset: TagPreset): string => {
        const share = kitLikenessFitShareById?.get(preset.id);
        if (share === undefined) {
            return preset.name;
        }
        return `${preset.name} (${formatKitFitPercent(share)})`;
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
        sizeSort !== "none" ||
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
            <DropdownMenuRadioGroup
                value={tagScope}
                onValueChange={(value) => {
                    if (isTagScope(value)) {
                        handleScopeChange(value);
                    }
                }}
            >
                <DropdownMenuLabel>Tag presence</DropdownMenuLabel>
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
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
                value={favoritesScope}
                onValueChange={(value) => {
                    if (isFavoritesScope(value)) {
                        handleFavoritesScopeChange(value);
                    }
                }}
            >
                <DropdownMenuLabel>Favourites</DropdownMenuLabel>
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
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
                value={croppedScope}
                onValueChange={(value) => {
                    if (isCroppedScope(value)) {
                        handleCroppedScopeChange(value);
                    }
                }}
            >
                <DropdownMenuLabel>Manual crop</DropdownMenuLabel>
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
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
                value={mediaScope}
                onValueChange={(value) => {
                    if (isMediaScope(value)) {
                        handleMediaScopeChange(value);
                    }
                }}
            >
                <DropdownMenuLabel>Media type</DropdownMenuLabel>
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
        </>
    );

    const nearnessPanel = showNearness ? (
        <DropdownMenuGroup>
            <DropdownMenuLabel>Filter nearness</DropdownMenuLabel>
            {nearnessEditorOpen ? (
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
            ) : (
                <div className="flex flex-col gap-1.5 px-1 pb-2">
                    {filterNearnessActive && nearnessFilter ? (
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
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="ml-1 self-start"
                            onClick={openNearnessEditor}
                        >
                            Choose filter…
                        </Button>
                    )}
                </div>
            )}
        </DropdownMenuGroup>
    ) : null;

    const kitLikenessPanel = showKitLikeness ? (
        <DropdownMenuGroup>
            <DropdownMenuLabel>Kit likeness</DropdownMenuLabel>
            {kitPickerOpen ? (
                <div className="flex flex-col gap-2 px-1 pb-2">
                    <Input
                        value={kitQuery}
                        onChange={(event) => setKitQuery(event.target.value)}
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
                                return (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        className={
                                            selected ?
                                                "flex w-full items-center rounded-md bg-accent px-2 py-1.5 text-left text-sm text-accent-foreground" :
                                                "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
                                        }
                                        onClick={() => {
                                            onKitLikenessPresetIdChange?.(
                                                preset.id,
                                            );
                                            closeKitPicker();
                                        }}
                                    >
                                        <span className="truncate">
                                            {kitLabel(preset)}
                                        </span>
                                    </button>
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
                </div>
            ) : (
                <div className="flex flex-col gap-1.5 px-1 pb-2">
                    {selectedKit ? (
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
                                        checked={
                                            kitLikenessRivalPenalty ?? true
                                        }
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
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="ml-1 self-start"
                            onClick={() => {
                                setNearnessEditorOpen(false);
                                setKitPickerOpen(true);
                            }}
                        >
                            Choose kit…
                        </Button>
                    )}
                </div>
            )}
        </DropdownMenuGroup>
    ) : null;

    const sortPanel = (
        <>
            {showViewportFit ? (
                <DropdownMenuRadioGroup
                    value={fitSort}
                    onValueChange={(value) => {
                        if (isViewportFitSort(value)) {
                            onViewportFitSortChange(value);
                        }
                    }}
                >
                    <DropdownMenuLabel>Viewport fit</DropdownMenuLabel>
                    <DropdownMenuRadioItem value="none" closeOnClick>
                        None
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="best" closeOnClick>
                        Best Fit
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="worst" closeOnClick>
                        Worst Fit
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            ) : null}
            {showViewportFit && showImageSize ? <DropdownMenuSeparator /> : null}
            {showImageSize ? (
                <DropdownMenuRadioGroup
                    value={sizeSort}
                    onValueChange={(value) => {
                        if (isImageSizeSort(value)) {
                            onImageSizeSortChange(value);
                        }
                    }}
                >
                    <DropdownMenuLabel>Image size</DropdownMenuLabel>
                    <DropdownMenuRadioItem value="none" closeOnClick>
                        None
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="largest" closeOnClick>
                        Largest
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="smallest" closeOnClick>
                        Smallest
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            ) : null}
            {(showViewportFit || showImageSize) && showTagFilterFit ?
                <DropdownMenuSeparator /> :
                null}
            {showTagFilterFit ? (
                <DropdownMenuRadioGroup
                    value={tagFitSort}
                    onValueChange={(value) => {
                        if (isTagFilterFitSort(value)) {
                            onTagFilterFitSortChange?.(value);
                        }
                    }}
                >
                    <DropdownMenuLabel>Tag filter fit</DropdownMenuLabel>
                    <DropdownMenuRadioItem value="none" closeOnClick>
                        None
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="best" closeOnClick>
                        Best fit
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="worst" closeOnClick>
                        Worst fit
                    </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
            ) : null}
            {(showViewportFit || showImageSize || showTagFilterFit) &&
            showRelative ?
                <DropdownMenuSeparator /> :
                null}
            {showRelative ? (
                <>
                    <DropdownMenuRadioGroup
                        value={relSort}
                        onValueChange={(value) => {
                            if (isRelativeSort(value)) {
                                onRelativeSortChange?.(value);
                            }
                        }}
                    >
                        <DropdownMenuLabel>Relative</DropdownMenuLabel>
                        <DropdownMenuRadioItem value="none" closeOnClick>
                            None
                        </DropdownMenuRadioItem>
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
                </>
            ) : null}
            {(showViewportFit ||
                showImageSize ||
                showTagFilterFit ||
                showRelative) &&
            (showNearness || showKitLikeness) ?
                <DropdownMenuSeparator /> :
                null}
            {nearnessPanel}
            {showNearness && showKitLikeness ? <DropdownMenuSeparator /> : null}
            {kitLikenessPanel}
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
