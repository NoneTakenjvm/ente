import { useMemo } from "react";
import type { KitFilterInput } from "@/lib/tag-filter-mutations";
import type {
    CroppedScope,
    FavoritesScope,
    MediaScope,
    RotatedScope,
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
    setRotatedScope: (rotatedScope: RotatedScope) => void;
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

    const actions = useMemo((): Omit<TagFilterBinding, "filter"> => {
        const store = useTagStore.getState;
        return {
            setTagScope: (scope) => store().setTagScope(scope, target),
            setFavoritesScope: (favoritesScope) =>
                store().setFavoritesScope(favoritesScope, target),
            setMediaScope: (mediaScope) =>
                store().setMediaScope(mediaScope, target),
            setCroppedScope: (croppedScope) =>
                store().setCroppedScope(croppedScope, target),
            setRotatedScope: (rotatedScope) =>
                store().setRotatedScope(rotatedScope, target),
            setTagFilterMode: (tag, mode) =>
                store().setTagFilterMode(tag, mode, target),
            setClauseMode: (clauseId, mode) =>
                store().setClauseMode(clauseId, mode, target),
            setClauseInGroup: (groupId, tag, mode) =>
                store().setClauseInGroup(groupId, tag, mode, target),
            setKitMode: (kit, mode) => store().setKitMode(kit, mode, target),
            setKitInGroup: (groupId, kit, mode) =>
                store().setKitInGroup(groupId, kit, mode, target),
            setGroupOp: (groupId, op) => store().setGroupOp(groupId, op, target),
            wrapInGroup: (nodeIds, op) =>
                store().wrapInGroup(nodeIds, op, target),
            ungroup: (groupId) => store().ungroup(groupId, target),
            removeNode: (nodeId) => store().removeNode(nodeId, target),
            clearFilters: () => store().clearFilters(target),
        };
    }, [target]);

    return useMemo(
        (): TagFilterBinding => ({ filter, ...actions }),
        [filter, actions],
    );
}
