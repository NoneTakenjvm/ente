/**
 * Main-thread side of the learned kit nearness margins: draw the training
 * sample and candidate matrices from the library, hand them to
 * {@link ../workers/kit-nearness-margins.worker.ts}, and return the gallery id
 * order — ranked embedded stills, then unembedded stills by id, then videos.
 *
 * The same worker (and cached tag models) also counts kit presence for the
 * kit likeness list: {@link countKitPresenceInWorker}.
 */
import { KIT_EMBEDDING_DIMS, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import {
    countKitPresence,
    type KitMarginsWorkerRequest,
    type KitMarginsWorkerResponse,
    type KitPresenceEstimate,
    type KitPresenceWorkerRequest,
    type KitPresenceWorkerResponse,
    type KitWorkerRequest,
} from "@/lib/kit-nearness-margins";
import { isEnteVideoFile } from "@/lib/media-kind";
import { packRelativeEmbeddings } from "@/lib/relative-sort";
import { shuffleIds } from "@/lib/shuffle-files";
import { isTagIncludedInKitNearness } from "@/lib/tag-types";
import type { EnteFile } from "ente-media/file";

export type KitMarginsRankingInput = {
    /** Tags of the matched kit; needs at least two. */
    kitTags: readonly string[];
    /** Non-archived library files the training population is drawn from. */
    libraryFiles: readonly EnteFile[];
    /** Files currently shown, in gallery order. */
    candidateFiles: readonly EnteFile[];
    embeddings: ReadonlyEmbeddingMap;
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>;
    includeInKitNearnessByName: ReadonlyMap<string, boolean>;
    /** Production competitive score (higher = nearer); non-finite when unscorable. */
    productionScore: (fileId: number) => number;
};

export type KitMarginsRanking = {
    request: Omit<KitMarginsWorkerRequest, "requestId">;
    /** Unembedded stills (by id) then videos (gallery order), appended after the ranked ids. */
    trailingIds: number[];
};

/** What the training population is drawn from; shared by both requests. */
type TrainingPopulationInput = Pick<
    KitMarginsRankingInput,
    "libraryFiles" | "embeddings" | "fileIdsByTag" | "includeInKitNearnessByName"
>;

export type KitPresenceInput = TrainingPopulationInput & {
    kits: readonly { id: string; tags: readonly string[] }[];
    /** Files currently shown. */
    viewFiles: readonly EnteFile[];
    /** Kits the user unchecked; omitted from best-fit assignment. */
    excludedKitIds?: ReadonlySet<string>;
};

/** Training rows are capped for phone CPUs and sampled deterministically. */
export const KIT_MARGIN_TRAINING_ROW_CAP = 3000;

/** Minimum complete members, partial members, tag positives and tag negatives. */
export const KIT_MARGIN_MIN_EXAMPLES = 8;

const TRAINING_SAMPLE_SEED = 0x5a2f;

let worker: Worker | undefined;
let requestCounter = 0;

/**
 * Build the worker payload, or `undefined` when the learned margins do not
 * apply (single-tag kit, or too few complete / partial members or tag
 * examples in the training sample) and the production order should stand.
 */
export const buildKitMarginsRanking = (
    input: KitMarginsRankingInput,
): KitMarginsRanking | undefined => {
    const { kitTags, embeddings, productionScore } = input;
    if (kitTags.length < 2) {
        return undefined;
    }

    const training = scoreIds(sampleTrainingIds(input), productionScore);
    const tagIdSets = kitTags.map(
        (tag) => input.fileIdsByTag.get(tag) ?? new Set<number>(),
    );
    const tags = kitTags.map((name, index) => ({
        name,
        labels: Uint8Array.from(training.ids, (id) =>
            tagIdSets[index]!.has(id) ? 1 : 0),
    }));
    if (!hasEnoughExamples(tags, training.ids.length)) {
        return undefined;
    }

    const embeddedStillIds: number[] = [];
    const unembeddedStillIds: number[] = [];
    const videoIds: number[] = [];
    for (const file of input.candidateFiles) {
        if (isEnteVideoFile(file)) {
            videoIds.push(file.id);
        } else if (hasEmbedding(file.id, embeddings)) {
            embeddedStillIds.push(file.id);
        } else {
            unembeddedStillIds.push(file.id);
        }
    }
    const candidates = scoreIds(embeddedStillIds, productionScore);
    if (candidates.ids.length === 0) {
        return undefined;
    }
    unembeddedStillIds.sort((a, b) => a - b);

    return {
        request: {
            kind: "rank",
            dim: KIT_EMBEDDING_DIMS,
            trainingIds: Int32Array.from(training.ids),
            trainingVectors: packRelativeEmbeddings(training.ids, embeddings),
            trainingProductionScores: training.scores,
            tags,
            candidateIds: Int32Array.from(candidates.ids),
            candidateVectors: packRelativeEmbeddings(
                candidates.ids,
                embeddings,
            ),
            candidateProductionScores: candidates.scores,
        },
        trailingIds: [...unembeddedStillIds, ...videoIds],
    };
};

/**
 * Rank in the worker and return the full gallery id order.
 *
 * Transfers the request buffers; the ranking must not be posted twice.
 */
export const rankByKitMarginsInWorker = async (
    ranking: KitMarginsRanking,
): Promise<number[]> => {
    const request: KitMarginsWorkerRequest = {
        ...ranking.request,
        requestId: ++requestCounter,
    };
    const response = await postToWorker<KitMarginsWorkerResponse>(request, [
        request.trainingIds.buffer,
        request.trainingVectors.buffer,
        request.trainingProductionScores.buffer,
        request.candidateIds.buffer,
        request.candidateVectors.buffer,
        request.candidateProductionScores.buffer,
        ...request.tags.map((tag) => tag.labels.buffer),
    ]);
    if (response.error || !response.orderIds) {
        throw new Error(response.error ?? "Kit nearness margins failed");
    }
    return [...response.orderIds, ...ranking.trailingIds];
};

/**
 * Per-tag estimates for the shown embedded files. Missing tags use the
 * worker's models; kits with a tag that has too few training examples are
 * absent from {@link KitPresenceEstimate.tagNames}.
 */
export const estimateKitPresenceInWorker = async (
    input: TrainingPopulationInput & {
        kits: readonly { id: string; tags: readonly string[] }[];
        viewFiles: readonly EnteFile[];
    },
): Promise<KitPresenceEstimate> => {
    const trainingIds = sampleTrainingIds(input);
    const tags = [...new Set(input.kits.flatMap((kit) => kit.tags))]
        .sort()
        .map((name) => {
            const ids = input.fileIdsByTag.get(name);
            return {
                name,
                labels: Uint8Array.from(trainingIds, (id) =>
                    ids?.has(id) ? 1 : 0),
            };
        })
        .filter((tag) => hasEnoughTagExamples(tag.labels));
    const viewFileIds = input.viewFiles.map((file) => file.id);
    const candidateIds = viewFileIds.filter((id) =>
        hasEmbedding(id, input.embeddings));
    const tagNames = tags.map((tag) => tag.name);
    if (!tags.length || !candidateIds.length) {
        return {
            tagNames,
            candidateIds,
            tagProbabilities: new Float32Array(0),
        };
    }

    const request: KitPresenceWorkerRequest = {
        kind: "presence",
        requestId: ++requestCounter,
        dim: KIT_EMBEDDING_DIMS,
        trainingIds: Int32Array.from(trainingIds),
        trainingVectors: packRelativeEmbeddings(trainingIds, input.embeddings),
        tags,
        candidateIds: Int32Array.from(candidateIds),
        candidateVectors: packRelativeEmbeddings(candidateIds, input.embeddings),
    };
    const response = await postToWorker<KitPresenceWorkerResponse>(request, [
        request.trainingIds.buffer,
        request.trainingVectors.buffer,
        request.candidateIds.buffer,
        request.candidateVectors.buffer,
        ...request.tags.map((tag) => tag.labels.buffer),
    ]);
    if (response.error || !response.tagProbabilities) {
        throw new Error(response.error ?? "Kit presence failed");
    }
    return {
        tagNames,
        candidateIds,
        tagProbabilities: response.tagProbabilities,
    };
};

/**
 * Count, per kit, the shown files assigned as best fit (see
 * {@link countKitPresence}), estimating missing tags with the worker.
 */
export const countKitPresenceInWorker = async (
    input: KitPresenceInput,
): Promise<Map<string, number>> => {
    const estimate = await estimateKitPresenceInWorker(input);
    return countKitPresence(
        input.kits,
        input.viewFiles.map((file) => file.id),
        input.fileIdsByTag,
        estimate,
        input.excludedKitIds,
    );
};

/** Post one request to the shared worker and resolve with its reply. */
const postToWorker = <Response extends { requestId: number }>(
    request: KitWorkerRequest,
    transfer: Transferable[],
): Promise<Response> =>
    new Promise((resolve, reject) => {
        if (typeof Worker === "undefined") {
            reject(new Error("Workers are not available"));
            return;
        }
        if (!worker) {
            worker = new Worker(
                new URL(
                    "../workers/kit-nearness-margins.worker.ts",
                    import.meta.url,
                ),
            );
        }
        const detach = (): void => {
            worker?.removeEventListener("message", handleMessage);
            worker?.removeEventListener("error", handleError);
        };
        const handleMessage = (event: MessageEvent<Response>): void => {
            if (event.data.requestId !== request.requestId) {
                return;
            }
            detach();
            resolve(event.data);
        };
        const handleError = (): void => {
            detach();
            reject(new Error("Kit nearness worker failed"));
        };
        worker.addEventListener("message", handleMessage);
        worker.addEventListener("error", handleError);
        worker.postMessage(request, transfer);
    });

/** Drop the worker and its cached whitening / tag models (logout). */
export const terminateKitMarginsWorker = (): void => {
    worker?.terminate();
    worker = undefined;
};

/**
 * Embedded stills carrying at least one kit-nearness tag — the same population
 * as the research corpus — capped by a fixed-seed sample so the worker can
 * reuse its whitening across kits.
 */
const sampleTrainingIds = (input: TrainingPopulationInput): number[] => {
    const taggedIds = new Set<number>();
    for (const [tag, ids] of input.fileIdsByTag) {
        if (!isTagIncludedInKitNearness(tag, input.includeInKitNearnessByName)) {
            continue;
        }
        for (const id of ids) {
            taggedIds.add(id);
        }
    }
    const population: number[] = [];
    for (const file of input.libraryFiles) {
        if (
            !isEnteVideoFile(file) &&
            taggedIds.has(file.id) &&
            hasEmbedding(file.id, input.embeddings)
        ) {
            population.push(file.id);
        }
    }
    population.sort((a, b) => a - b);
    if (population.length <= KIT_MARGIN_TRAINING_ROW_CAP) {
        return population;
    }
    return shuffleIds(population, TRAINING_SAMPLE_SEED)
        .slice(0, KIT_MARGIN_TRAINING_ROW_CAP)
        .sort((a, b) => a - b);
};

const hasEmbedding = (
    fileId: number,
    embeddings: ReadonlyEmbeddingMap,
): boolean => embeddings.get(fileId)?.length === KIT_EMBEDDING_DIMS;

/** Score each id once, dropping any the production path cannot score. */
const scoreIds = (
    ids: readonly number[],
    productionScore: (fileId: number) => number,
): { ids: number[]; scores: Float32Array } => {
    const kept: number[] = [];
    const scores: number[] = [];
    for (const id of ids) {
        const score = productionScore(id);
        if (Number.isFinite(score)) {
            kept.push(id);
            scores.push(score);
        }
    }
    return { ids: kept, scores: Float32Array.from(scores) };
};

const hasEnoughExamples = (
    tags: readonly { labels: Uint8Array }[],
    rows: number,
): boolean => {
    let complete = 0;
    let partial = 0;
    for (let row = 0; row < rows; row += 1) {
        let carried = 0;
        for (const tag of tags) {
            carried += tag.labels[row]!;
        }
        if (carried === tags.length) {
            complete += 1;
        } else if (carried > 0) {
            partial += 1;
        }
    }
    if (
        complete < KIT_MARGIN_MIN_EXAMPLES ||
        partial < KIT_MARGIN_MIN_EXAMPLES
    ) {
        return false;
    }
    return tags.every((tag) => hasEnoughTagExamples(tag.labels));
};

const hasEnoughTagExamples = (labels: Uint8Array): boolean => {
    let positives = 0;
    for (const label of labels) {
        positives += label;
    }
    return (
        positives >= KIT_MARGIN_MIN_EXAMPLES &&
        labels.length - positives >= KIT_MARGIN_MIN_EXAMPLES
    );
};
