import type { JSX } from "react";
import { ListFilter } from "lucide-react";
import {
    TagQueryBuilderContent,
    type TagQueryBuilderContentProps,
} from "@/components/TagQueryBuilderContent";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TagQueryBuilderPanelProps extends TagQueryBuilderContentProps {
    hasQueryContent: boolean;
    clauseCount?: number;
}

/**
 * Standalone Query builder dropdown (wide layouts / desktop).
 */
export function TagQueryBuilderPanel({
    hasQueryContent,
    clauseCount = 0,
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    croppedCount,
    notCroppedCount,
}: TagQueryBuilderPanelProps): JSX.Element {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={hasQueryContent ? "secondary" : "outline"}
                        size="icon-sm"
                        aria-label={
                            clauseCount > 0 ?
                                `Edit tag query (${clauseCount} steps)` :
                                "Edit tag query"
                        }
                    >
                        <ListFilter />
                    </Button>
                }
            />
            <DropdownMenuContent
                align="start"
                className="flex max-h-[min(80dvh,28rem)] w-[min(100vw-2rem,24rem)] flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-2"
            >
                <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-3">
                    <DropdownMenuLabel className="shrink-0 px-0">
                        Query builder
                    </DropdownMenuLabel>
                    <TagQueryBuilderContent
                        taggedCount={taggedCount}
                        untaggedCount={untaggedCount}
                        favoritesCount={favoritesCount}
                        notFavoritesCount={notFavoritesCount}
                        photoCount={photoCount}
                        videoCount={videoCount}
                        croppedCount={croppedCount}
                        notCroppedCount={notCroppedCount}
                    />
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
