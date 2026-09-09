import {
    createEmptyTagFilterRoot,
    isTagFilterClause,
    isTagFilterGroup,
    newTagFilterNodeId,
    type CroppedScope,
    type FavoritesScope,
    type TagFilterClauseNode,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
    type TagScope,
    type MediaScope,
} from "@/lib/tags";

/** Untagged scope cannot hold tag clauses; include clauses replace the tagged scope. */
const tagScopeAfterClauseChange = (
    tagScope: TagScope,
    mode: TagFilterMode | null,
): TagScope => {
    if (tagScope === "untagged") {
        return "all";
    }
    if (tagScope === "tagged" && mode === "include") {
        return "all";
    }
    return tagScope;
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
): TagFilterSelection => ({
    ...filter,
    tagScope: scope,
    root: scope === "untagged" ? createEmptyTagFilterRoot() : filter.root,
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
): TagFilterSelection => {
    const withoutTag = removeClauseByTagFromRoot(filter.root, tag);
    if (mode === null) {
        return {
            ...filter,
            tagScope: tagScopeAfterClauseChange(filter.tagScope, mode),
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
        tagScope: tagScopeAfterClauseChange(filter.tagScope, mode),
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
        if (isTagFilterClause(child)) {
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

/** Set include/exclude mode on one clause by node id. */
export const setClauseModeOnFilter = (
    filter: TagFilterSelection,
    clauseId: string,
    mode: TagFilterMode,
): TagFilterSelection => ({
    ...filter,
    tagScope: tagScopeAfterClauseChange(filter.tagScope, mode),
    root: updateClauseModeInTree(filter.root, clauseId, mode),
});

/** Add, update, or remove a tag clause within one group (one tag per group). */
export const setClauseInGroupOnFilter = (
    filter: TagFilterSelection,
    groupId: string,
    tag: string,
    mode: TagFilterMode | null,
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
        tagScope: tagScopeAfterClauseChange(filter.tagScope, mode),
        root: updatedRoot,
    };
};

/**
 * Include or clear every tag in a kit at the root (Has kit = all includes).
 */
export const setKitTagsModeOnFilter = (
    filter: TagFilterSelection,
    tags: string[],
    mode: TagFilterMode | null,
): TagFilterSelection => {
    let next = filter;
    for (const tag of tags) {
        next = setTagFilterModeOnFilter(next, tag, mode);
    }
    return next;
};

/**
 * Include or clear every tag in a kit inside one group.
 */
export const setKitTagsInGroupOnFilter = (
    filter: TagFilterSelection,
    groupId: string,
    tags: string[],
    mode: TagFilterMode | null,
): TagFilterSelection => {
    let next = filter;
    for (const tag of tags) {
        next = setClauseInGroupOnFilter(next, groupId, tag, mode);
    }
    return next;
};

/**
 * Whether every kit tag is currently an include clause in the given group/root.
 */
export const kitTagsAreIncluded = (
    group: TagFilterGroup,
    tags: string[],
): boolean => {
    if (tags.length === 0) {
        return false;
    }
    return tags.every((tag) => {
        for (const child of group.children) {
            if (
                isTagFilterClause(child) &&
                child.tag === tag &&
                child.mode === "include"
            ) {
                return true;
            }
        }
        return false;
    });
};
