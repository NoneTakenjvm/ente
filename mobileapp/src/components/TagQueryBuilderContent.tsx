import type { JSX } from "react";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { useTagStore } from "@/stores/tag-store";

export interface TagQueryBuilderContentProps {
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    photoCount: number;
    videoCount: number;
    croppedCount: number;
    notCroppedCount: number;
}

/**
 * Query-builder editor body (shared by Tools submenu and legacy panel).
 */
export function TagQueryBuilderContent({
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    croppedCount,
    notCroppedCount,
}: TagQueryBuilderContentProps): JSX.Element {
    const tagFilter = useTagStore((s) => s.tagFilter);
    const setFavoritesScope = useTagStore((s) => s.setFavoritesScope);
    const setMediaScope = useTagStore((s) => s.setMediaScope);
    const setCroppedScope = useTagStore((s) => s.setCroppedScope);
    const setTagScope = useTagStore((s) => s.setTagScope);
    const setGroupOpOnTree = useTagStore((s) => s.setGroupOp);
    const wrapInGroup = useTagStore((s) => s.wrapInGroup);
    const ungroup = useTagStore((s) => s.ungroup);
    const removeNode = useTagStore((s) => s.removeNode);
    const setClauseMode = useTagStore((s) => s.setClauseMode);
    const setClauseInGroup = useTagStore((s) => s.setClauseInGroup);
    const setKitInGroup = useTagStore((s) => s.setKitInGroup);

    return (
        <TagQueryEditor
            filter={tagFilter}
            actions={{
                setTagScope,
                setFavoritesScope,
                setMediaScope,
                setCroppedScope,
                setGroupOp: setGroupOpOnTree,
                wrapInGroup,
                ungroup,
                removeNode,
                setClauseMode,
                setClauseInGroup,
                setKitInGroup,
            }}
            taggedCount={taggedCount}
            untaggedCount={untaggedCount}
            favoritesCount={favoritesCount}
            notFavoritesCount={notFavoritesCount}
            photoCount={photoCount}
            videoCount={videoCount}
            croppedCount={croppedCount}
            notCroppedCount={notCroppedCount}
        />
    );
}
