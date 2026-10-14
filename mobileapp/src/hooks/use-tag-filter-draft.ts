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
    setTagFilterRotatedScope,
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
    type RotatedScope,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterSelection,
    type TagScope,
} from "@/lib/tags";
import type { TagQueryEditorActions } from "@/components/TagQueryEditor";
import { useTagStore } from "@/stores/tag-store";

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
export const useTagFilterDraft = (
    initial: TagFilterSelection = emptyTagFilter(),
): TagFilterDraft => {
    const [filter, setFilter] = useState<TagFilterSelection>(initial);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );

    const setTagScope = useCallback(
        (scope: TagScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterScope(
                    current,
                    scope,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const setFavoritesScope = useCallback(
        (favoritesScope: FavoritesScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterFavoritesScope(current, favoritesScope));
        },
        [],
    );

    const setMediaScope = useCallback(
        (mediaScope: MediaScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterMediaScope(current, mediaScope));
        },
        [],
    );

    const setCroppedScope = useCallback(
        (croppedScope: CroppedScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterCroppedScope(current, croppedScope));
        },
        [],
    );

    const setRotatedScope = useCallback(
        (rotatedScope: RotatedScope): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterRotatedScope(current, rotatedScope));
        },
        [],
    );

    const setTagFilterMode = useCallback(
        (tag: string, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterModeOnFilter(
                    current,
                    tag,
                    mode,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const setKitMode = useCallback(
        (kit: KitFilterInput, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setKitModeOnFilter(
                    current,
                    kit,
                    mode,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const setGroupOp = useCallback(
        (groupId: string, op: TagFilterJoin): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setTagFilterGroupOp(current, groupId, op));
        },
        [],
    );

    const wrapInGroup =
        useCallback((nodeIds: string[], op: TagFilterJoin): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                wrapTagFilterNodesInGroup(current, nodeIds, op));
        }, []);

    const ungroup = useCallback(
        (groupId: string): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                ungroupTagFilterNode(current, groupId));
        },
        [],
    );

    const removeNode = useCallback(
        (nodeId: string): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                removeTagFilterNode(current, nodeId));
        },
        [],
    );

    const setClauseMode = useCallback(
        (clauseId: string, mode: TagFilterMode): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setClauseModeOnFilter(
                    current,
                    clauseId,
                    mode,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const setClauseInGroup = useCallback(
        (groupId: string, tag: string, mode: TagFilterMode | null): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setClauseInGroupOnFilter(
                    current,
                    groupId,
                    tag,
                    mode,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const setKitInGroup = useCallback(
        (
            groupId: string,
            kit: KitFilterInput,
            mode: TagFilterMode | null,
        ): void => {
            setFilter((current: TagFilterSelection): TagFilterSelection =>
                setKitInGroupOnFilter(
                    current,
                    groupId,
                    kit,
                    mode,
                    includeInEffectsPresenceByName,
                ));
        },
        [includeInEffectsPresenceByName],
    );

    const actions: TagFilterDraftActions = useMemo(
        (): TagFilterDraftActions => ({
            setTagScope,
            setFavoritesScope,
            setMediaScope,
            setCroppedScope,
            setRotatedScope,
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
            setRotatedScope,
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
