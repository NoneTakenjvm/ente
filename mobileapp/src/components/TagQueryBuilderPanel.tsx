import type { JSX } from "react";
import { ListFilter } from "lucide-react";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTagStore } from "@/stores/tag-store";

interface TagQueryBuilderPanelProps {
    hasQueryContent: boolean;
    clauseCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    taggedCount: number;
    untaggedCount: number;
    photoCount: number;
    videoCount: number;
}

export function TagQueryBuilderPanel({
    hasQueryContent,
    clauseCount,
    favoritesCount,
    notFavoritesCount,
    taggedCount,
    untaggedCount,
    photoCount,
    videoCount,
}: TagQueryBuilderPanelProps): JSX.Element {
    const tagFilter = useTagStore((s) => s.tagFilter);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const setMediaScope = useTagStore((s) => s.setMediaScope);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setGroupOpOnTree = useTagStore((s) => s.setGroupOp);
    const wrapInGroup = useTagStore((s) => s.wrapInGroup);
    const ungroup = useTagStore((s) => s.ungroup);
    const removeNode = useTagStore((s) => s.removeNode);
    const setClauseMode = useTagStore((s) => s.setClauseMode);
    const setClauseInGroup = useTagStore((s) => s.setClauseInGroup);

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
                className="flex max-h-[min(80dvh,28rem)] w-[min(100vw-2rem,24rem)] flex-col overflow-hidden p-2"
            >
                <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-3">
                    <DropdownMenuLabel className="shrink-0 px-0">
                        Query builder
                    </DropdownMenuLabel>
                    <TagQueryEditor
                        filter={tagFilter}
                        actions={{
                            setTagScope,
                            setFavoritesScope,
                            setMediaScope,
                            setGroupOp: setGroupOpOnTree,
                            wrapInGroup,
                            ungroup,
                            removeNode,
                            setClauseMode,
                            setClauseInGroup,
                        }}
                        taggedCount={taggedCount}
                        untaggedCount={untaggedCount}
                        favoritesCount={favoritesCount}
                        notFavoritesCount={notFavoritesCount}
                        photoCount={photoCount}
                        videoCount={videoCount}
                    />
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
