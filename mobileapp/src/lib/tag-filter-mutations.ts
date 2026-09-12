import { isTagIncludedInEffectsPresence } from "@/lib/tag-types";
import {
    isTagFilterClause,
    isTagFilterGroup,
    isTagFilterKit,
    newTagFilterNodeId,
    type CroppedScope,
    type FavoritesScope,
    type TagFilterClauseNode,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterKitNode,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
    type TagScope,
    type MediaScope,
} from "@/lib/tags";

/** Identity of a kit when adding it as one filter unit. */
export interface KitFilterInput {
    presetId: string;
    name: string;
    tags: string[];
}

type EffectsPresenceMap = ReadonlyMap<string, boolean> | undefined;

/**
 * Whether the tag counts toward tagged/untagged. Absent map → all tags do.
 */
const tagAffectsPresence = (
    tag: string,
    includeInEffectsPresenceByName: EffectsPresenceMap,
): boolean =>
    !includeInEffectsPresenceByName ||
    isTagIncludedInEffectsPresence(tag, includeInEffectsPresenceByName);

/** True when any kit tag counts toward presence. */
const kitAffectsPresence = (
    tags: readonly string[],
    includeInEffectsPresenceByName: EffectsPresenceMap,
): boolean =>
    tags.some((tag) => tagAffectsPresence(tag, includeInEffectsPresenceByName));

/**
 * Presence-counting clauses clear conflicting scopes; presence-off tags keep
 * tagged/untagged so they can coexist with the presence filter.
 */
const tagScopeAfterClauseChange = (
    tagScope: TagScope,
    mode: TagFilterMode | null,
    affectsPresence: boolean,
): TagScope => {
    if (!affectsPresence) {
        return tagScope;
    }
    if (tagScope === "untagged") {
        return "all";
    }
    if (tagScope === "tagged" && mode === "include") {
        return "all";
    }
    return tagScope;
};

/**
 * Drop presence-counting clauses/kits (and empty groups) so untagged can keep
 * only effects-presence-off tags.
 */
const prunePresenceAffectingNodes = (
    root: TagFilterGroup,
    includeInEffectsPresenceByName: EffectsPresenceMap,
): TagFilterGroup => {
    const nextChildren: TagFilterNode[] = [];
    for (const child of root.children) {
        if (isTagFilterClause(child)) {
            if (!tagAffectsPresence(child.tag, includeInEffectsPresenceByName)) {
                nextChildren.push(child);
            }
            continue;
        }
        if (isTagFilterKit(child)) {
            if (!kitAffectsPresence(child.tags, includeInEffectsPresenceByName)) {
                nextChildren.push(child);
            }
            continue;
        }
        const pruned = prunePresenceAffectingNodes(
            child,
            includeInEffectsPresenceByName,
        );
        if (pruned.children.length > 0) {
            nextChildren.push(pruned);
        }
    }
    return { ...root, children: nextChildren };
};

/** Whether the clause/kit with {@link nodeId} counts toward presence. */
const nodeAffectsPresence = (
    root: TagFilterGroup,
    nodeId: string,
    includeInEffectsPresenceByName: EffectsPresenceMap,
): boolean => {
    for (const child of root.children) {
        if (isTagFilterClause(child) && child.id === nodeId) {
            return tagAffectsPresence(child.tag, includeInEffectsPresenceByName);
        }
        if (isTagFilterKit(child) && child.id === nodeId) {
            return kitAffectsPresence(child.tags, includeInEffectsPresenceByName);
        }
        if (isTagFilterGroup(child)) {
            if (
                nodeAffectsPresence(
                    child,
                    nodeId,
                    includeInEffectsPresenceByName,
                )
            ) {
                return true;
            }
        }
    }
    return false;
};

const removeClauseByTagFromRoot = (
    root: TagFilterGroup,
    tag: string,
): TagFilterGroup => ({
    ...root,
    children: root.children.filter(
        (child) => !(isTagFilterClause(child) && child.tag === tag),
    ),
});

const removeNodeFromTree = (
    root: TagFilterGroup,
    nodeId: string,
): TagFilterGroup => ({
    ...root,
    children: root.children
        .filter((child) => child.id !== nodeId)
        .map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return removeNodeFromTree(child, nodeId);
        }),
});

const updateGroupOp = (
    root: TagFilterGroup,
    groupId: string,
    op: TagFilterJoin,
): TagFilterGroup => {
    if (root.id === groupId) {
        return { ...root, op };
    }
    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return updateGroupOp(child, groupId, op);
        }),
    };
};

const findParentGroup = (
    root: TagFilterGroup,
    nodeId: string,
): TagFilterGroup | undefined => {
    for (const child of root.children) {
        if (child.id === nodeId) {
            return root;
        }
        if (isTagFilterGroup(child)) {
            const found = findParentGroup(child, nodeId);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
};

const ungroupNode = (
    root: TagFilterGroup,
    groupId: string,
): TagFilterGroup => {
    if (root.id === groupId) {
        return root;
    }

    const childIndex = root.children.findIndex(
        (child) => isTagFilterGroup(child) && child.id === groupId,
    );
    if (childIndex >= 0) {
        const group = root.children[childIndex] as TagFilterGroup;
        const nextChildren = [
            ...root.children.slice(0, childIndex),
            ...group.children,
            ...root.children.slice(childIndex + 1),
        ];
        return { ...root, children: nextChildren };
    }

    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return ungroupNode(child, groupId);
        }),
    };
};

const wrapSiblingsInGroup = (
    root: TagFilterGroup,
    nodeIds: string[],
    op: TagFilterJoin,
    parentId: string,
): TagFilterGroup => {
    if (root.id === parentId) {
        const idSet = new Set(nodeIds);
        const selected: TagFilterNode[] = [];
        for (const child of root.children) {
            if (idSet.has(child.id)) {
                selected.push(child);
            }
        }
        if (selected.length < 2) {
            return root;
        }
        const newGroup: TagFilterGroup = {
            kind: "group",
            id: newTagFilterNodeId(),
            op,
            children: selected,
        };
        const nextChildren: TagFilterNode[] = [];
        let grouped = false;
        for (const child of root.children) {
            if (!grouped && idSet.has(child.id)) {
                nextChildren.push(newGroup);
                grouped = true;
                continue;
            }
            if (!idSet.has(child.id)) {
                nextChildren.push(child);
            }
        }
        return { ...root, children: nextChildren };
    }

    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return wrapSiblingsInGroup(child, nodeIds, op, parentId);
        }),
    };
};

export const setTagFilterScope = (
    filter: TagFilterSelection,
    scope: TagScope,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => ({
    ...filter,
    tagScope: scope,
    root:
        scope === "untagged" ?
            prunePresenceAffectingNodes(
                filter.root,
                includeInEffectsPresenceByName,
            ) :
            filter.root,
});

export const setTagFilterFavoritesScope = (
    filter: TagFilterSelection,
    favoritesScope: FavoritesScope,
): TagFilterSelection => ({
    ...filter,
    favoritesScope,
});

export const setTagFilterMediaScope = (
    filter: TagFilterSelection,
    mediaScope: MediaScope,
): TagFilterSelection => ({
    ...filter,
    mediaScope,
});

export const setTagFilterCroppedScope = (
    filter: TagFilterSelection,
    croppedScope: CroppedScope,
): TagFilterSelection => ({
    ...filter,
    croppedScope,
});

export const setTagFilterModeOnFilter = (
    filter: TagFilterSelection,
    tag: string,
    mode: TagFilterMode | null,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => {
    const withoutTag = removeClauseByTagFromRoot(filter.root, tag);
    const nextScope = tagScopeAfterClauseChange(
        filter.tagScope,
        mode,
        tagAffectsPresence(tag, includeInEffectsPresenceByName),
    );
    if (mode === null) {
        return {
            ...filter,
            tagScope: nextScope,
            root: withoutTag,
        };
    }
    const clause = {
        kind: "clause" as const,
        id: newTagFilterNodeId(),
        tag,
        mode,
    };
    return {
        ...filter,
        tagScope: nextScope,
        root: {
            ...withoutTag,
            children: [...withoutTag.children, clause],
        },
    };
};

export const setTagFilterGroupOp = (
    filter: TagFilterSelection,
    groupId: string,
    op: TagFilterJoin,
): TagFilterSelection => ({
    ...filter,
    root: updateGroupOp(filter.root, groupId, op),
});

export const wrapTagFilterNodesInGroup = (
    filter: TagFilterSelection,
    nodeIds: string[],
    op: TagFilterJoin,
): TagFilterSelection => {
    if (nodeIds.length < 2) {
        return filter;
    }
    const parent = findParentGroup(filter.root, nodeIds[0]);
    if (!parent) {
        return filter;
    }
    const allSameParent = nodeIds.every((id) => {
        const nodeParent = findParentGroup(filter.root, id);
        return nodeParent?.id === parent.id;
    });
    if (!allSameParent) {
        return filter;
    }
    return {
        ...filter,
        root: wrapSiblingsInGroup(filter.root, nodeIds, op, parent.id),
    };
};

export const ungroupTagFilterNode = (
    filter: TagFilterSelection,
    groupId: string,
): TagFilterSelection => {
    if (filter.root.id === groupId) {
        return filter;
    }
    return {
        ...filter,
        root: ungroupNode(filter.root, groupId),
    };
};

export const removeTagFilterNode = (
    filter: TagFilterSelection,
    nodeId: string,
): TagFilterSelection => {
    if (filter.root.id === nodeId) {
        return filter;
    }
    return {
        ...filter,
        root: removeNodeFromTree(filter.root, nodeId),
    };
};

const updateClauseModeInTree = (
    root: TagFilterGroup,
    clauseId: string,
    mode: TagFilterMode,
): TagFilterGroup => ({
    ...root,
    children: root.children.map((child) => {
        if (isTagFilterClause(child) || isTagFilterKit(child)) {
            return child.id === clauseId ? { ...child, mode } : child;
        }
        return updateClauseModeInTree(child, clauseId, mode);
    }),
});

const updateGroupInTree = (
    root: TagFilterGroup,
    groupId: string,
    updater: (group: TagFilterGroup) => TagFilterGroup,
): TagFilterGroup => {
    if (root.id === groupId) {
        return updater(root);
    }
    return {
        ...root,
        children: root.children.map((child) => {
            if (!isTagFilterGroup(child)) {
                return child;
            }
            return updateGroupInTree(child, groupId, updater);
        }),
    };
};

/** Set include/exclude mode on one clause or kit by node id. */
export const setClauseModeOnFilter = (
    filter: TagFilterSelection,
    clauseId: string,
    mode: TagFilterMode,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => ({
    ...filter,
    tagScope: tagScopeAfterClauseChange(
        filter.tagScope,
        mode,
        nodeAffectsPresence(
            filter.root,
            clauseId,
            includeInEffectsPresenceByName,
        ),
    ),
    root: updateClauseModeInTree(filter.root, clauseId, mode),
});

/** Add, update, or remove a tag clause within one group (one tag per group). */
export const setClauseInGroupOnFilter = (
    filter: TagFilterSelection,
    groupId: string,
    tag: string,
    mode: TagFilterMode | null,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => {
    const updatedRoot = updateGroupInTree(filter.root, groupId, (group) => {
        if (mode === null) {
            return {
                ...group,
                children: group.children.filter(
                    (child) => !(isTagFilterClause(child) && child.tag === tag),
                ),
            };
        }
        const existingIndex = group.children.findIndex(
            (child) => isTagFilterClause(child) && child.tag === tag,
        );
        if (existingIndex >= 0) {
            const existing = group.children[existingIndex] as TagFilterClauseNode;
            const nextChildren = [...group.children];
            nextChildren[existingIndex] = { ...existing, mode };
            return { ...group, children: nextChildren };
        }
        const clause: TagFilterClauseNode = {
            kind: "clause",
            id: newTagFilterNodeId(),
            tag,
            mode,
        };
        return { ...group, children: [...group.children, clause] };
    });
    return {
        ...filter,
        tagScope: tagScopeAfterClauseChange(
            filter.tagScope,
            mode,
            tagAffectsPresence(tag, includeInEffectsPresenceByName),
        ),
        root: updatedRoot,
    };
};

const applyKitToGroup = (
    group: TagFilterGroup,
    kit: KitFilterInput,
    mode: TagFilterMode | null,
): TagFilterGroup => {
    if (mode === null) {
        return {
            ...group,
            children: group.children.filter(
                (child) =>
                    !(isTagFilterKit(child) && child.presetId === kit.presetId),
            ),
        };
    }
    const existingIndex = group.children.findIndex(
        (child) => isTagFilterKit(child) && child.presetId === kit.presetId,
    );
    const nextKit: TagFilterKitNode = {
        kind: "kit",
        id:
            existingIndex >= 0 ?
                group.children[existingIndex].id :
                newTagFilterNodeId(),
        presetId: kit.presetId,
        name: kit.name,
        tags: [...kit.tags],
        mode,
    };
    if (existingIndex >= 0) {
        const nextChildren = [...group.children];
        nextChildren[existingIndex] = nextKit;
        return { ...group, children: nextChildren };
    }
    return { ...group, children: [...group.children, nextKit] };
};

/**
 * Add, update, or clear a kit unit at the root.
 */
export const setKitModeOnFilter = (
    filter: TagFilterSelection,
    kit: KitFilterInput,
    mode: TagFilterMode | null,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => ({
    ...filter,
    tagScope: tagScopeAfterClauseChange(
        filter.tagScope,
        mode,
        kitAffectsPresence(kit.tags, includeInEffectsPresenceByName),
    ),
    root: applyKitToGroup(filter.root, kit, mode),
});

/**
 * Add, update, or clear a kit unit inside one group.
 */
export const setKitInGroupOnFilter = (
    filter: TagFilterSelection,
    groupId: string,
    kit: KitFilterInput,
    mode: TagFilterMode | null,
    includeInEffectsPresenceByName?: EffectsPresenceMap,
): TagFilterSelection => {
    const updatedRoot = updateGroupInTree(filter.root, groupId, (group) =>
        applyKitToGroup(group, kit, mode));
    return {
        ...filter,
        tagScope: tagScopeAfterClauseChange(
            filter.tagScope,
            mode,
            kitAffectsPresence(kit.tags, includeInEffectsPresenceByName),
        ),
        root: updatedRoot,
    };
};

/**
 * Mode of a kit unit in the group, if present.
 */
export const findKitModeInGroup = (
    group: TagFilterGroup,
    presetId: string,
): TagFilterMode | null => {
    for (const child of group.children) {
        if (isTagFilterKit(child) && child.presetId === presetId) {
            return child.mode;
        }
    }
    return null;
};

/**
 * Whether the kit is currently an include unit in the given group/root.
 */
export const kitIsIncluded = (
    group: TagFilterGroup,
    presetId: string,
): boolean => findKitModeInGroup(group, presetId) === "include";
