import type { EnteFile } from "ente-media/file";

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

/**
 * Return a new array with the same files in a deterministic shuffled order.
 */
export const shuffleFiles = (files: EnteFile[], seed: number): EnteFile[] => {
    const next = [...files];
    const rng = createRng(seed);
    for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
    }
    return next;
};
