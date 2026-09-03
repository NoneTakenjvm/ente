import type { JSX } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
    CroppedScope,
    FavoritesScope,
    MediaScope,
    TagScope,
} from "@/lib/tags";
import type { ViewportFitSort } from "@/lib/viewport-fit";
import type { ImageSizeSort } from "@/lib/image-size-sort";
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

    const filterActive =
        tagScope !== "all" ||
        favoritesScope !== "all" ||
        mediaScope !== "all" ||
        croppedScope !== "all" ||
        fitSort !== "none" ||
        sizeSort !== "none";

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={filterActive ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label="Filter by tag presence, favourites, media type, crop, viewport fit, and image size"
                    >
                        <Filter className="size-3.5 shrink-0" />
                        Filter
                    </Button>
                }
            />
            <DropdownMenuContent align="start" className="w-44">
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
                {showViewportFit ? (
                    <>
                        <DropdownMenuSeparator />
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
                    </>
                ) : null}
                {showImageSize ? (
                    <>
                        <DropdownMenuSeparator />
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
                    </>
                ) : null}
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
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
