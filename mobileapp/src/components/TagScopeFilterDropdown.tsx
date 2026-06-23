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
import type { FavoritesScope, TagScope } from "@/lib/tags";
import { useTagStore } from "@/stores/tag-store";

interface TagScopeFilterDropdownProps {
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    tagScope?: TagScope;
    onTagScopeChange?: (scope: TagScope) => void;
    favoritesScope?: FavoritesScope;
    onFavoritesScopeChange?: (scope: FavoritesScope) => void;
}

const isTagScope = (value: unknown): value is TagScope =>
    value === "all" || value === "tagged" || value === "untagged";

const isFavoritesScope = (value: unknown): value is FavoritesScope =>
    value === "all" || value === "favorites" || value === "not-favorites";

export function TagScopeFilterDropdown({
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    tagScope: controlledScope,
    onTagScopeChange,
    favoritesScope: controlledFavoritesScope,
    onFavoritesScopeChange,
}: TagScopeFilterDropdownProps): JSX.Element {
    const storeFilter = useTagStore((s) => s.tagFilter);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const tagScope = controlledScope ?? storeFilter.tagScope;
    const favoritesScope = controlledFavoritesScope ?? storeFilter.favoritesScope;

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

    const filterActive = tagScope !== "all" || favoritesScope !== "all";

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={filterActive ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label="Filter by tag presence and favourites"
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
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
