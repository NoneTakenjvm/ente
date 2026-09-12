import type { JSX } from "react";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { useTagFilterBinding } from "@/hooks/use-tag-filter-binding";
import type { TagFilterTarget } from "@/stores/tag-store";

export interface TagQueryBuilderContentProps {
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    photoCount: number;
    videoCount: number;
    croppedCount: number;
    notCroppedCount: number;
    filterTarget?: TagFilterTarget;
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
    filterTarget = "gallery",
}: TagQueryBuilderContentProps): JSX.Element {
    const {
        filter,
        setTagScope,
        setFavoritesScope,
        setMediaScope,
        setCroppedScope,
        setGroupOp,
        wrapInGroup,
        ungroup,
        removeNode,
        setClauseMode,
        setClauseInGroup,
        setKitInGroup,
    } = useTagFilterBinding(filterTarget);

    return (
        <TagQueryEditor
            filter={filter}
            actions={{
                setTagScope,
                setFavoritesScope,
                setMediaScope,
                setCroppedScope,
                setGroupOp,
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
