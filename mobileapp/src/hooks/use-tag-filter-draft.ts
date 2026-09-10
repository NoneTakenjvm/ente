import { useCallback, useMemo, useState } from "react";
import {
    removeTagFilterNode,
    setClauseInGroupOnFilter,
    setClauseModeOnFilter,
    setKitInGroupOnFilter,
    setKitModeOnFilter,
    setTagFilterFavoritesScope,
    setTagFilterMediaScope,
    setTagFilterCroppedScope,
    setTagFilterGroupOp,
    setTagFilterModeOnFilter,
    setTagFilterScope,
    ungroupTagFilterNode,
    wrapTagFilterNodesInGroup,
    type KitFilterInput,
} from "@/lib/tag-filter-mutations";
import {
    emptyTagFilter,
    type CroppedScope,
    type FavoritesScope,
    type MediaScope,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterSelection,
    type TagScope,
} from "@/lib/tags";
import type { TagQueryEditorActions } from "@/components/TagQueryEditor";

export type TagFilterDraftActions = TagQueryEditorActions & {
    setTagFilterMode: (tag: string, mode: TagFilterMode | null) => void;
    setKitMode: (kit: KitFilterInput, mode: TagFilterMode | null) => void;
};

export interface TagFilterDraft {
    filter: TagFilterSelection;
    setFilter: (filter: TagFilterSelection) => void;
    actions: TagFilterDraftActions;
}

/**
 * Local editable tag filter state for album create/edit forms.
 */
export const useTagFilterDraft: (
    initial?: TagFilterSelection,
) => TagFilterDraft = (
    initial: TagFilterSelection = emptyTagFilter(),
): TagFilterDraft => {
    const [filter, setFilter]: [
        TagFilterSelection,
        (value: TagFilterSelection | ((current: TagFilterSelection) => TagFilterSelection)) => void,
    ] = useState<TagFilterSelection>(initial);

    const setTagScope: (scope: TagScope) => void = useCallback(
        (scope: TagScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterScope(current, scope));
        },
        [],
    );

    const setFavoritesScope: (favoritesScope: FavoritesScope) => void = useCallback(
        (favoritesScope: FavoritesScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterFavoritesScope(current, favoritesScope));
        },
        [],
    );

    const setMediaScope: (mediaScope: MediaScope) => void = useCallback(
        (mediaScope: MediaScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterMediaScope(current, mediaScope));
        },
        [],
    );

    const setCroppedScope: (croppedScope: CroppedScope) => void = useCallback(
        (croppedScope: CroppedScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterCroppedScope(current, croppedScope));
        },
        [],
    );

    const setTagFilterMode: (
        tag: string,
        mode: TagFilterMode | null,
    ) => void = useCallback(
        (tag: string, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterModeOnFilter(current, tag, mode));
        },
        [],
    );

    const setKitMode: (
        kit: KitFilterInput,
        mode: TagFilterMode | null,
    ) => void = useCallback(
        (kit: KitFilterInput, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setKitModeOnFilter(current, kit, mode));
        },
        [],
    );

    const setGroupOp: (groupId: string, op: TagFilterJoin) => void = useCallback(
        (groupId: string, op: TagFilterJoin): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterGroupOp(current, groupId, op));
        },
        [],
    );

    const wrapInGroup: (nodeIds: string[], op: TagFilterJoin) => void =
        useCallback((nodeIds: string[], op: TagFilterJoin): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                wrapTagFilterNodesInGroup(current, nodeIds, op));
        }, []);

    const ungroup: (groupId: string) => void = useCallback(
        (groupId: string): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                ungroupTagFilterNode(current, groupId));
        },
        [],
    );

    const removeNode: (nodeId: string) => void = useCallback(
        (nodeId: string): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                removeTagFilterNode(current, nodeId));
        },
        [],
    );

    const setClauseMode: (
        clauseId: string,
        mode: TagFilterMode,
    ) => void = useCallback(
        (clauseId: string, mode: TagFilterMode): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setClauseModeOnFilter(current, clauseId, mode));
        },
        [],
    );

    const setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void = useCallback(
        (groupId: string, tag: string, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setClauseInGroupOnFilter(current, groupId, tag, mode));
        },
        [],
    );

    const setKitInGroup: (
        groupId: string,
        kit: KitFilterInput,
        mode: TagFilterMode | null,
    ) => void = useCallback(
        (
            groupId: string,
            kit: KitFilterInput,
            mode: TagFilterMode | null,
        ): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setKitInGroupOnFilter(current, groupId, kit, mode));
        },
        [],
    );

    const actions: TagFilterDraftActions = useMemo(
        (): TagFilterDraftActions => ({
            setTagScope,
            setFavoritesScope,
            setMediaScope,
            setCroppedScope,
            setGroupOp,
            wrapInGroup,
            ungroup,
            removeNode,
            setTagFilterMode,
            setKitMode,
            setClauseMode,
            setClauseInGroup,
            setKitInGroup,
        }),
        [
            setTagScope,
            setFavoritesScope,
            setMediaScope,
            setCroppedScope,
            setGroupOp,
            wrapInGroup,
            ungroup,
            removeNode,
            setTagFilterMode,
            setKitMode,
            setClauseMode,
            setClauseInGroup,
            setKitInGroup,
        ],
    );
    return { filter, setFilter, actions };
};
