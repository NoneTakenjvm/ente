import { useMemo, useState, type JSX } from "react";
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
import type {
    CroppedScope,
    FavoritesScope,
    MediaScope,
    TagScope,
} from "@/lib/tags";
import type { ViewportFitSort } from "@/lib/viewport-fit";
import type { ImageSizeSort } from "@/lib/image-size-sort";
import type { TagPreset } from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useTagStore } from "@/stores/tag-store";

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
    /** Gallery-only: reorder by visual nearness to a kit (not a hide-filter). */
    kitNearnessPresets?: TagPreset[];
    kitNearnessPresetId?: string;
    onKitNearnessPresetIdChange?: (presetId: string | undefined) => void;
    /** Rebuild frozen kit nearness order from the current library. */
    onKitNearnessReapply?: () => void;
    /**
     * Best-fit share of CLIP-embedded library files per kit id (0..1). Used to
     * order the kit picker and append `(x%)` to kit names.
     */
    kitNearnessFitShareById?: ReadonlyMap<string, number>;
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
    kitNearnessPresets,
    kitNearnessPresetId,
    onKitNearnessPresetIdChange,
    onKitNearnessReapply,
    kitNearnessFitShareById,
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
    const showKitNearness = onKitNearnessPresetIdChange !== undefined;
    const kitPresets = useMemo(
        (): TagPreset[] => kitNearnessPresets ?? [],
        [kitNearnessPresets],
    );
    const showSort = showViewportFit || showImageSize || showKitNearness;

    const [optionsTab, setOptionsTab] = useState<"sort" | "filter">("filter");
    const [kitPickerOpen, setKitPickerOpen] = useState<boolean>(false);
    const [kitQuery, setKitQuery] = useState<string>("");

    const selectedKit = useMemo(
        (): TagPreset | undefined =>
            kitNearnessPresetId ?
                kitPresets.find((preset) => preset.id === kitNearnessPresetId) :
                undefined,
        [kitNearnessPresetId, kitPresets],
    );

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
            const shareA = kitNearnessFitShareById?.get(a.id) ?? 0;
            const shareB = kitNearnessFitShareById?.get(b.id) ?? 0;
            if (shareB !== shareA) {
                return shareB - shareA;
            }
            return a.name.localeCompare(b.name);
        });
        return matched;
    }, [kitNearnessFitShareById, kitPresets, kitQuery]);

    const kitLabel = (preset: TagPreset): string => {
        const share = kitNearnessFitShareById?.get(preset.id);
        if (share === undefined) {
            return preset.name;
        }
        return `${preset.name} (${Math.round(Math.max(0, Math.min(1, share)) * 100)}%)`;
    };

    const filterActive =
        tagScope !== "all" ||
        favoritesScope !== "all" ||
        mediaScope !== "all" ||
        croppedScope !== "all";

    const sortActive =
        fitSort !== "none" ||
        sizeSort !== "none" ||
        kitNearnessPresetId !== undefined;

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

    const kitNearnessPanel = showKitNearness ? (
        <DropdownMenuGroup>
            <DropdownMenuLabel>Kit nearness</DropdownMenuLabel>
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
                                const selected = preset.id === kitNearnessPresetId;
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
                                            onKitNearnessPresetIdChange(preset.id);
                                            setKitPickerOpen(false);
                                            setKitQuery("");
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
                        onClick={() => {
                            setKitPickerOpen(false);
                            setKitQuery("");
                        }}
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
                                    onClick={() => onKitNearnessReapply?.()}
                                    disabled={onKitNearnessReapply === undefined}
                                >
                                    Reapply
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setKitPickerOpen(true)}
                                >
                                    Change
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        onKitNearnessPresetIdChange(undefined)
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
                            onClick={() => setKitPickerOpen(true)}
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
            {(showViewportFit || showImageSize) && showKitNearness ?
                <DropdownMenuSeparator /> :
                null}
            {kitNearnessPanel}
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
                setKitPickerOpen(false);
                setKitQuery("");
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
            <DropdownMenuContent align="start" className="w-56 p-1.5">
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
                                    setKitPickerOpen(false);
                                    setKitQuery("");
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
