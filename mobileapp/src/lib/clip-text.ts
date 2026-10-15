/**
 * CLIP text helpers: prompt building, the kit text-vector cache, the kit text
 * prior gate, and ranking photos by a text vector.
 */
import {
    KIT_EMBEDDING_DIMS,
    embedTextInWorker,
    type ReadonlyEmbeddingMap,
} from "@/lib/kit-embedding";
import { MAX_KIT_SEEDS } from "@/lib/kit-nearness-sort";
import { isEnteVideoFile } from "@/lib/media-kind";
import { registerReset } from "@/lib/session-lifecycle";
import type { EnteFile } from "ente-media/file";

/** The text vector counts as this many example photos in the kit centroid. */
export const KIT_TEXT_PRIOR_WEIGHT = 8;

/** Untuned guard: random tags score about 0.5 on the seed percentile. */
export const KIT_TEXT_PRIOR_MIN_PERCENTILE = 0.7;

/** `null` marks a failed load; absent means not requested yet. */
const kitTextVectors = new Map<string, Float32Array | null>();
const kitTextLoads = new Map<string, Promise<Float32Array | null>>();

/** "a photo of dog, cat and bird" for terms [dog, cat, bird]. */
export const photoTextPrompt = (terms: readonly string[]): string => {
    const last = terms[terms.length - 1] ?? "";
    return `a photo of ${
        terms.length > 1 ? `${terms.slice(0, -1).join(", ")} and ` : ""
    }${last}`;
};

/** Cached kit text vector; `undefined` when it has not been loaded yet. */
export const peekKitTextVector = (
    tags: readonly string[],
): Float32Array | null | undefined => kitTextVectors.get(photoTextPrompt(tags));

/** Embed the kit's joint prompt once; resolves `null` if the encoder fails. */
export const loadKitTextVector = (
    tags: readonly string[],
): Promise<Float32Array | null> => {
    const prompt = photoTextPrompt(tags);
    const cached = kitTextVectors.get(prompt);
    if (cached !== undefined) {
        return Promise.resolve(cached);
    }
    const pending = kitTextLoads.get(prompt);
    if (pending) {
        return pending;
    }
    const load = embedTextInWorker(prompt)
        .catch((error: unknown): null => {
            console.warn("Kit text vector unavailable", error);
            return null;
        })
        .then((vector) => {
            kitTextVectors.set(prompt, vector);
            kitTextLoads.delete(prompt);
            return vector;
        });
    kitTextLoads.set(prompt, load);
    return load;
};

/**
 * Whether the kit's text vector describes its photos: the mean percentile of
 * the embedded seeds' cosine among all library cosines must reach
 * {@link KIT_TEXT_PRIOR_MIN_PERCENTILE}. Non-visual tags ("Mum") fail. With no
 * embedded seeds there is nothing to check, so the text is used alone.
 */
export const kitTextPriorFits = (
    textVector: Float32Array,
    seedIds: readonly number[],
    embeddings: ReadonlyEmbeddingMap,
): boolean => {
    const seedCosines: number[] = [];
    for (const id of seedIds) {
        if (seedCosines.length >= MAX_KIT_SEEDS) {
            break;
        }
        const vector = embeddings.get(id);
        if (vector?.length === KIT_EMBEDDING_DIMS) {
            seedCosines.push(dot(textVector, vector));
        }
    }
    if (seedCosines.length === 0) {
        return true;
    }
    const libraryCosines: number[] = [];
    for (const vector of embeddings.values()) {
        if (vector.length === KIT_EMBEDDING_DIMS) {
            libraryCosines.push(dot(textVector, vector));
        }
    }
    libraryCosines.sort((a, b) => a - b);
    let percentileSum = 0;
    for (const cosine of seedCosines) {
        percentileSum += countBelow(libraryCosines, cosine) / libraryCosines.length;
    }
    return percentileSum / seedCosines.length >= KIT_TEXT_PRIOR_MIN_PERCENTILE;
};

/**
 * File ids ordered by descending cosine to `textVector`: embedded stills
 * first, then videos and unembedded files in their given order.
 */
export const rankFileIdsByText = (
    files: readonly EnteFile[],
    textVector: Float32Array,
    embeddings: ReadonlyEmbeddingMap,
): number[] => {
    const scored: { id: number; cosine: number }[] = [];
    const rest: number[] = [];
    for (const file of files) {
        const vector = embeddings.get(file.id);
        if (!isEnteVideoFile(file) && vector?.length === KIT_EMBEDDING_DIMS) {
            scored.push({ id: file.id, cosine: dot(textVector, vector) });
        } else {
            rest.push(file.id);
        }
    }
    scored.sort((a, b) => b.cosine - a.cosine);
    return [...scored.map((entry) => entry.id), ...rest];
};

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let sum = 0;
    for (let i = 0; i < KIT_EMBEDDING_DIMS; i++) {
        sum += a[i]! * b[i]!;
    }
    return sum;
};

/** Number of entries strictly below `value` in an ascending array. */
const countBelow = (sorted: readonly number[], value: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle]! < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

registerReset(() => {
    kitTextVectors.clear();
    kitTextLoads.clear();
});
