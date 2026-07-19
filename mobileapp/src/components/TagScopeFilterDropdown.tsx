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
import type { FavoritesScope, MediaScope, TagScope } from "@/lib/tags";
import { useTagStore } from "@/stores/tag-store";

interface TagScopeFilterDropdownProps {
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    photoCount: number;
    videoCount: number;
    tagScope?: TagScope;
    onTagScopeChange?: (scope: TagScope) => void;
    favoritesScope?: FavoritesScope;
    onFavoritesScopeChange?: (scope: FavoritesScope) => void;
    mediaScope?: MediaScope;
    onMediaScopeChange?: (scope: MediaScope) => void;
}

const isTagScope = (value: unknown): value is TagScope =>
    value === "all" || value === "tagged" || value === "untagged";

const isFavoritesScope = (value: unknown): value is FavoritesScope =>
    value === "all" || value === "favorites" || value === "not-favorites";

const isMediaScope = (value: unknown): value is MediaScope =>
    value === "all" || value === "photo" || value === "video";

export function TagScopeFilterDropdown({
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    tagScope: controlledScope,
    onTagScopeChange,
    favoritesScope: controlledFavoritesScope,
    onFavoritesScopeChange,
    mediaScope: controlledMediaScope,
    onMediaScopeChange,
}: TagScopeFilterDropdownProps): JSX.Element {
    const storeFilter = useTagStore((s) => s.tagFilter);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const setMediaScope = useTagStore((s) => s.setMediaScope);
    const tagScope = controlledScope ?? storeFilter.tagScope;
    const favoritesScope = controlledFavoritesScope ?? storeFilter.favoritesScope;
    const mediaScope = controlledMediaScope ?? storeFilter.mediaScope;

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

    const filterActive =
        tagScope !== "all" ||
        favoritesScope !== "all" ||
        mediaScope !== "all";

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={filterActive ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label="Filter by tag presence, favourites, and media type"
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
