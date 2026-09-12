import { useCallback, useMemo } from "react";
import type { KitFilterInput } from "@/lib/tag-filter-mutations";
import type {
    CroppedScope,
    FavoritesScope,
    MediaScope,
    TagFilterJoin,
    TagFilterMode,
    TagFilterSelection,
    TagScope,
} from "@/lib/tags";
import {
    type TagFilterTarget,
    useTagStore,
} from "@/stores/tag-store";

export interface TagFilterBinding {
    filter: TagFilterSelection;
    setTagScope: (scope: TagScope) => void;
    setFavoritesScope: (favoritesScope: FavoritesScope) => void;
    setMediaScope: (mediaScope: MediaScope) => void;
    setCroppedScope: (croppedScope: CroppedScope) => void;
    setTagFilterMode: (tag: string, mode: TagFilterMode | null) => void;
    setClauseMode: (clauseId: string, mode: TagFilterMode) => void;
    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    setKitMode: (kit: KitFilterInput, mode: TagFilterMode | null) => void;
    setKitInGroup: (
        groupId: string,
        kit: KitFilterInput,
        mode: TagFilterMode | null,
    ) => void;
    setGroupOp: (groupId: string, op: TagFilterJoin) => void;
    wrapInGroup: (nodeIds: string[], op: TagFilterJoin) => void;
    ungroup: (groupId: string) => void;
    removeNode: (nodeId: string) => void;
    clearFilters: () => void;
}

/**
 * Route tag-filter reads and writes to the gallery or album-view slice.
 */
export function useTagFilterBinding(
    target: TagFilterTarget = "gallery",
): TagFilterBinding {
    const filter = useTagStore((s) =>
        target === "gallery" ? s.tagFilter : s.albumViewFilter);
    const setTagScopeStore = useTagStore((s) => s.setTagScope);
    const setFavoritesScopeStore = useTagStore((s) => s.setFavoritesScope);
    const setMediaScopeStore = useTagStore((s) => s.setMediaScope);
    const setCroppedScopeStore = useTagStore((s) => s.setCroppedScope);
    const setTagFilterModeStore = useTagStore((s) => s.setTagFilterMode);
    const setClauseModeStore = useTagStore((s) => s.setClauseMode);
    const setClauseInGroupStore = useTagStore((s) => s.setClauseInGroup);
    const setKitModeStore = useTagStore((s) => s.setKitMode);
    const setKitInGroupStore = useTagStore((s) => s.setKitInGroup);
    const setGroupOpStore = useTagStore((s) => s.setGroupOp);
    const wrapInGroupStore = useTagStore((s) => s.wrapInGroup);
    const ungroupStore = useTagStore((s) => s.ungroup);
    const removeNodeStore = useTagStore((s) => s.removeNode);
    const clearFiltersStore = useTagStore((s) => s.clearFilters);

    const setTagScope = useCallback(
        (scope: TagScope): void => {
            setTagScopeStore(scope, target);
        },
        [setTagScopeStore, target],
    );
    const setFavoritesScope = useCallback(
        (favoritesScope: FavoritesScope): void => {
            setFavoritesScopeStore(favoritesScope, target);
        },
        [setFavoritesScopeStore, target],
    );
    const setMediaScope = useCallback(
        (mediaScope: MediaScope): void => {
            setMediaScopeStore(mediaScope, target);
        },
        [setMediaScopeStore, target],
    );
    const setCroppedScope = useCallback(
        (croppedScope: CroppedScope): void => {
            setCroppedScopeStore(croppedScope, target);
        },
        [setCroppedScopeStore, target],
    );
    const setTagFilterMode = useCallback(
        (tag: string, mode: TagFilterMode | null): void => {
            setTagFilterModeStore(tag, mode, target);
        },
        [setTagFilterModeStore, target],
    );
    const setClauseMode = useCallback(
        (clauseId: string, mode: TagFilterMode): void => {
            setClauseModeStore(clauseId, mode, target);
        },
        [setClauseModeStore, target],
    );
    const setClauseInGroup = useCallback(
        (
            groupId: string,
            tag: string,
            mode: TagFilterMode | null,
        ): void => {
            setClauseInGroupStore(groupId, tag, mode, target);
        },
        [setClauseInGroupStore, target],
    );
    const setKitMode = useCallback(
        (kit: KitFilterInput, mode: TagFilterMode | null): void => {
            setKitModeStore(kit, mode, target);
        },
        [setKitModeStore, target],
    );
    const setKitInGroup = useCallback(
        (
            groupId: string,
            kit: KitFilterInput,
            mode: TagFilterMode | null,
        ): void => {
            setKitInGroupStore(groupId, kit, mode, target);
        },
        [setKitInGroupStore, target],
    );
    const setGroupOp = useCallback(
        (groupId: string, op: TagFilterJoin): void => {
            setGroupOpStore(groupId, op, target);
        },
        [setGroupOpStore, target],
    );
    const wrapInGroup = useCallback(
        (nodeIds: string[], op: TagFilterJoin): void => {
            wrapInGroupStore(nodeIds, op, target);
        },
        [target, wrapInGroupStore],
    );
    const ungroup = useCallback(
        (groupId: string): void => {
            ungroupStore(groupId, target);
        },
        [target, ungroupStore],
    );
    const removeNode = useCallback(
        (nodeId: string): void => {
            removeNodeStore(nodeId, target);
        },
        [removeNodeStore, target],
    );
    const clearFilters = useCallback((): void => {
        clearFiltersStore(target);
    }, [clearFiltersStore, target]);

    return useMemo(
        (): TagFilterBinding => ({
            filter,
            setTagScope,
            setFavoritesScope,
            setMediaScope,
            setCroppedScope,
            setTagFilterMode,
            setClauseMode,
            setClauseInGroup,
            setKitMode,
            setKitInGroup,
            setGroupOp,
            wrapInGroup,
            ungroup,
            removeNode,
            clearFilters,
        }),
        [
            clearFilters,
            filter,
            removeNode,
            setClauseInGroup,
            setClauseMode,
            setCroppedScope,
            setFavoritesScope,
            setGroupOp,
            setKitInGroup,
            setKitMode,
            setMediaScope,
            setTagFilterMode,
            setTagScope,
            ungroup,
            wrapInGroup,
        ],
    );
}
