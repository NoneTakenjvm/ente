const pendingSubstitutions = new Map<number, number>();

/**
 * Remember that a gallery item was replaced in place (crop, rotate, compress).
 */
export const registerShuffleFileSubstitution = (
    oldId: number,
    newId: number,
): void => {
    pendingSubstitutions.set(oldId, newId);
};

/**
 * Swap replaced file ids inside a shuffled order and consume handled entries.
 */
export const applyPendingShuffleSubstitutions = (
    order: readonly number[],
): number[] => {
    if (pendingSubstitutions.size === 0) {
        return [...order];
    }
    const next = [...order];
    for (let index = 0; index < next.length; index++) {
        const oldId = next[index]!;
        const newId = pendingSubstitutions.get(oldId);
        if (newId !== undefined) {
            next[index] = newId;
            pendingSubstitutions.delete(oldId);
        }
    }
    return next;
};
