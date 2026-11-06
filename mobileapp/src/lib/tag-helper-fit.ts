import {
    KIT_TEXT_PRIOR_WEIGHT,
    kitTextPriorFits,
    loadKitTextVector,
} from "@/lib/clip-text";
import { KIT_EMBEDDING_DIMS, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import { buildKitEmbeddingPrototypes } from "@/lib/kit-nearness-embedding-eval";
import { DEFAULT_KIT_EMBEDDING_GENOME } from "@/lib/kit-nearness-embedding-genome";
import {
    kitEmbeddingMinDistance,
    listKitSeedIds,
} from "@/lib/kit-nearness-sort";
import { eligibleImageFiles } from "@/lib/job-utils";
import { isEnteVideoFile } from "@/lib/media-kind";
import { sortFilesByUpload } from "@/lib/sort-files";
import type { TagPreset } from "@/lib/tag-presets";
import { isTagIncludedInEffectsPresence } from "@/lib/tag-types";
import { extractUserTags } from "@/lib/tags";
import { embeddingCosineDistance } from "@/lib/similarity-clip";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";

export interface KitFitModel {
    preset: TagPreset;
    /** Library photos carrying every kit tag (embedded or not); fallback order. */
    memberCount: number;
    /** CLIP prototypes (centroid or medoids); empty when the kit cannot be scored. */
    prototypes: Float32Array[];
    /**
     * Members' min cosine distance to `prototypes`, ascending. Members that are
     * themselves a prototype (distance <= 1e-6) are left out.
     */
    memberDistances: Float64Array;
}

export interface KitFit {
    preset: TagPreset;
    /** Min cosine distance to the kit's prototypes; Infinity when unscored. */
    distance: number;
    /**
     * Fraction (0..1) of the kit's members this photo fits at least as well as.
     * Undefined below TAG_HELPER_MIN_MEMBERS members or when unscored.
     */
    match: number | undefined;
}

// [Note: Tag Helper kit fit]
// Kits are compared by match, not raw distance. Raw cosine distances are not
// comparable across tight and broad kits, but the percentile among the kit's
// own members is: "this photo fits closer than most of the kit's members".
// Members helped build the centroid, so their distances read slightly low and
// matches come out a little conservative. No rival penalty is applied, because
// choosing the closest kit for one photo already makes the kits compete.

/** Kits need this many embedded members before a match % is shown. */
export const TAG_HELPER_MIN_MEMBERS = 5;

const PROTOTYPE_DISTANCE_EPSILON = 1e-6;

/** Caps member distances per kit so model building stays short on phones. */
const MAX_MEMBER_DISTANCE_SAMPLES = 1000;

/**
 * Whether the file has no user tag that counts toward presence.
 */
export const isFileUntagged = (
    file: EnteFile,
    includeInEffectsPresenceByName: ReadonlyMap<string, boolean>,
): boolean => {
    const isPresent = (tag: string): boolean =>
        isTagIncludedInEffectsPresence(tag, includeInEffectsPresenceByName);
    return !extractUserTags(file).some(isPresent);
};

/**
 * Ids of the user's untagged, owned, non-archived images, newest upload first.
 */
export const listUntaggedImageIds = (
    files: readonly EnteFile[],
    userId: number,
    includeInEffectsPresenceByName: ReadonlyMap<string, boolean>,
): number[] => {
    const isUntagged = (file: EnteFile): boolean =>
        isFileUntagged(file, includeInEffectsPresenceByName);
    const untagged = eligibleImageFiles(files, userId).filter(isUntagged);
    return sortFilesByUpload(untagged).map((file) => file.id);
};

/**
 * Build one fit model per preset that has tags, in preset order.
 *
 * Yields to the event loop before each kit. Aborts by throwing an
 * `AbortError` DOMException, checked after each yield.
 */
export const buildKitFitModels = async (
    presets: readonly TagPreset[],
    libraryFiles: readonly EnteFile[],
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>,
    embeddings: ReadonlyEmbeddingMap,
    options?: {
        signal?: AbortSignal;
        onProgress?: (done: number, total: number) => void;
    },
): Promise<KitFitModel[]> => {
    const isSeedFile = (file: EnteFile): boolean =>
        !isEnteVideoFile(file) && !isFileArchivedLocally(file);
    const seedFiles = libraryFiles.filter(isSeedFile);
    const seedFileById: ReadonlyMap<number, EnteFile> = new Map(seedFiles.map((file) => [file.id, file]));
    const kits = presets.filter((preset) => preset.tags.length > 0);
    const models: KitFitModel[] = [];
    for (const preset of kits) {
        options?.onProgress?.(models.length, kits.length);
        await yieldToEventLoop();
        if (options?.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }
        models.push(
            await buildKitFitModel(
                preset,
                seedFileById,
                fileIdsByTag,
                embeddings,
            ),
        );
    }
    options?.onProgress?.(kits.length, kits.length);
    return models;
};

/**
 * Score a photo against each kit and order the kits best fit first.
 *
 * Pass `undefined` when the photo has no embedding; every kit then falls back
 * to member-count order.
 */
export const rankKitsForImage = (
    vector: Float32Array | undefined,
    models: readonly KitFitModel[],
): KitFit[] =>
    models
        .map((model) => ({ model, fit: fitKitToImage(vector, model) }))
        .sort(compareScoredKits)
        .map((scored) => scored.fit);

const yieldToEventLoop = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

const buildKitFitModel = async (
    preset: TagPreset,
    seedFileById: ReadonlyMap<number, EnteFile>,
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>,
    embeddings: ReadonlyEmbeddingMap,
): Promise<KitFitModel> => {
    const seedIds = listKitSeedIds(preset.tags, fileIdsByTag, seedFileById);
    // [Note: Kit text prior] Mirrors use-media-display-pipeline.ts.
    const text = await loadKitTextVector(preset.tags);
    const prior =
        text && kitTextPriorFits(text, seedIds, embeddings) ?
            { vector: text, weight: KIT_TEXT_PRIOR_WEIGHT } :
            undefined;
    const prototypes = buildKitEmbeddingPrototypes(
        seedIds,
        embeddings,
        preset.nearnessTune?.genome ?? DEFAULT_KIT_EMBEDDING_GENOME,
        prior,
    );
    return {
        preset,
        memberCount: seedIds.length,
        prototypes,
        memberDistances: memberDistancesToPrototypes(
            seedIds,
            prototypes,
            embeddings,
        ),
    };
};

/**
 * Sorted distances from the kit's embedded members to their nearest
 * prototype, leaving out members that are a prototype themselves.
 */
const memberDistancesToPrototypes = (
    seedIds: readonly number[],
    prototypes: readonly Float32Array[],
    embeddings: ReadonlyEmbeddingMap,
): Float64Array => {
    if (!prototypes.length) {
        return new Float64Array();
    }
    const distances = seedIds
        .filter((id) => embeddings.get(id)?.length === KIT_EMBEDDING_DIMS)
        .slice(0, MAX_MEMBER_DISTANCE_SAMPLES)
        .map((id) => kitEmbeddingMinDistance(id, prototypes, embeddings))
        .filter((distance) => distance > PROTOTYPE_DISTANCE_EPSILON)
        .sort((a, b) => a - b);
    return Float64Array.from(distances);
};

const fitKitToImage = (
    vector: Float32Array | undefined,
    model: KitFitModel,
): KitFit => {
    const distance = nearestPrototypeDistance(vector, model.prototypes);
    return {
        preset: model.preset,
        distance,
        match: matchFraction(distance, model.memberDistances),
    };
};

const nearestPrototypeDistance = (
    vector: Float32Array | undefined,
    prototypes: readonly Float32Array[],
): number => {
    if (!vector) {
        return Number.POSITIVE_INFINITY;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const prototype of prototypes) {
        best = Math.min(best, embeddingCosineDistance(vector, prototype));
    }
    return best;
};

/**
 * Fraction of the kit's members at distance >= `distance`, i.e. members the
 * photo fits at least as well as. Undefined below the minimum member count.
 */
const matchFraction = (
    distance: number,
    memberDistances: Float64Array,
): number | undefined => {
    if (
        memberDistances.length < TAG_HELPER_MIN_MEMBERS ||
        !Number.isFinite(distance)
    ) {
        return undefined;
    }
    // Ascending search for the count of members strictly closer than the photo.
    let low = 0;
    let high = memberDistances.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (memberDistances[middle]! < distance) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return (memberDistances.length - low) / memberDistances.length;
};

/** Calibrated matches first, then uncalibrated distances, then unscored kits. */
const fitGroup = (fit: KitFit): number => {
    if (fit.match !== undefined) {
        return 0;
    }
    return Number.isFinite(fit.distance) ? 1 : 2;
};

const compareScoredKits = (a: ScoredKitFit, b: ScoredKitFit): number => {
    const groupDifference = fitGroup(a.fit) - fitGroup(b.fit);
    if (groupDifference !== 0) {
        return groupDifference;
    }
    if (a.fit.match !== undefined && b.fit.match !== undefined) {
        if (a.fit.match !== b.fit.match) {
            return b.fit.match - a.fit.match;
        }
        return a.fit.distance - b.fit.distance;
    }
    if (Number.isFinite(a.fit.distance)) {
        return a.fit.distance - b.fit.distance;
    }
    if (a.model.memberCount !== b.model.memberCount) {
        return b.model.memberCount - a.model.memberCount;
    }
    return a.fit.preset.name.localeCompare(b.fit.preset.name);
};

interface ScoredKitFit {
    model: KitFitModel;
    fit: KitFit;
}
