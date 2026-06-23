import type { EnteFile } from "ente-media/file";
import { applyPendingShuffleSubstitutions } from "@/lib/shuffle-file-substitutions";

/** Seeded PRNG (mulberry32). */
const createRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const shuffleInPlace = <T>(items: T[], rng: () => number): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
};

/**
 * Return a new array of ids in a deterministic shuffled order.
 */
export const shuffleIds = (ids: number[], seed: number): number[] =>
    shuffleInPlace([...ids], createRng(seed));

/**
 * Reconcile a shuffled id order when the visible file set changes.
 * Preserves relative order for ids that remain; newly visible ids are
 * shuffled and appended.
 */
export const reconcileShuffledIds = (
    fileIds: readonly number[],
    seed: number,
    previousOrder?: readonly number[],
): number[] => {
    const resolvedPrevious = previousOrder?.length ?
        applyPendingShuffleSubstitutions(previousOrder) :
        undefined;
    if (!resolvedPrevious?.length) {
        return shuffleIds([...fileIds], seed);
    }
    const idSet = new Set(fileIds);
    const ordered: number[] = [];
    for (const id of resolvedPrevious) {
        if (idSet.has(id)) {
            ordered.push(id);
        }
    }
    const inOrder = new Set(ordered);
    const newIds = fileIds.filter((id) => !inOrder.has(id));
    if (newIds.length > 0) {
        ordered.push(...shuffleIds(newIds, seed));
    }
    return ordered;
};

/**
 * Return a new array with the same files in a deterministic shuffled order.
 */
export const shuffleFiles = (files: EnteFile[], seed: number): EnteFile[] => {
    const byId = new Map(files.map((file) => [file.id, file]));
    return reconcileShuffledIds(
        files.map((file) => file.id),
        seed,
    ).flatMap((id) => {
        const file = byId.get(id);
        return file ? [file] : [];
    });
};

/**
 * Apply a shuffled view order, preserving the relative order of files that
 * remain in the set. New files are shuffled and appended.
 */
export const applyShuffledOrder = (
    files: EnteFile[],
    seed: number,
    previousOrder?: readonly number[],
): EnteFile[] => {
    const byId = new Map(files.map((file) => [file.id, file]));
    return reconcileShuffledIds(
        files.map((file) => file.id),
        seed,
        previousOrder,
    ).flatMap((id) => {
        const file = byId.get(id);
        return file ? [file] : [];
    });
};
