import { registerReset } from "@/lib/session-lifecycle";
/**
 * Main-thread side of the learned kit nearness margins: draw the training
 * sample and candidate matrices from the library, hand them to
 * {@link ../workers/kit-nearness-margins.worker.ts}, and return the gallery id
 * order — ranked embedded stills, then unembedded stills by id, then videos.
 *
 * The same worker (and cached tag models) also estimates kit presence for the
 * kit likeness list: {@link estimateKitPresenceInWorker}.
 */
import { KIT_EMBEDDING_DIMS, type ReadonlyEmbeddingMap } from "@/lib/kit-embedding";
import type {
    KitMarginsWorkerRequest,
    KitMarginsWorkerResponse,
    KitPresenceEstimate,
    KitPresenceWorkerRequest,
    KitPresenceWorkerResponse,
    KitWorkerRequest,
} from "@/lib/kit-nearness-margins";
import { isEnteVideoFile } from "@/lib/media-kind";
import { packEmbeddings } from "@/lib/relative-sort";
import { isTagIncludedInKitNearness } from "@/lib/tag-types";
import { createWorkerClient } from "@/lib/worker-client";
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
    request: Omit<KitMarginsWorkerRequest, "id">;
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
const KIT_MARGIN_TRAINING_ROW_CAP = 3000;

/** Minimum complete members, partial members, tag positives and tag negatives. */
export const KIT_MARGIN_MIN_EXAMPLES = 8;

const TRAINING_SAMPLE_SEED = 0x5a2f;

/**
 * Release the worker and its cached whitening / tag models after this long
 * with no requests; longer than the sort worker so normal browsing keeps them.
 */
const KIT_WORKER_IDLE_TERMINATE_MS = 120_000;

const kitWorker = createWorkerClient<
    KitWorkerRequest,
    KitMarginsWorkerResponse | KitPresenceWorkerResponse
>({
    createWorker: () =>
        new Worker(
            new URL(
                "../workers/kit-nearness-margins.worker.ts",
                import.meta.url,
            ),
        ),
    idleMs: KIT_WORKER_IDLE_TERMINATE_MS,
});

/** Presence pass currently in the worker, and the newest caller's ticket. */
let presenceInFlight: Promise<unknown> | undefined;
let latestPresenceTicket = 0;

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
            trainingIds: Float64Array.from(training.ids),
            trainingVectors: packEmbeddings(training.ids, embeddings),
            trainingProductionScores: training.scores,
            tags,
            candidateIds: Float64Array.from(candidates.ids),
            candidateVectors: packEmbeddings(
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
    const request = ranking.request;
    const response = (await kitWorker.request(request, [
        request.trainingIds.buffer,
        request.trainingVectors.buffer,
        request.trainingProductionScores.buffer,
        request.candidateIds.buffer,
        request.candidateVectors.buffer,
        request.candidateProductionScores.buffer,
        ...request.tags.map((tag) => tag.labels.buffer),
    ])) as KitMarginsWorkerResponse;
    if (response.error || !response.orderIds) {
        throw new Error(response.error ?? "Kit nearness margins failed");
    }
    return [...response.orderIds, ...ranking.trailingIds];
};

/**
 * Per-tag estimates for the shown embedded files. Missing tags use the
 * worker's models; kits with a tag that has too few training examples are
 * absent from {@link KitPresenceEstimate.tagNames}. Resolves `undefined`
 * when a newer call superseded this one.
 *
 * [Note: Latest-wins kit presence]
 *
 * The worker answers in order, so a burst of filter edits would queue one
 * full presence pass each. Callers wait out the pass already in flight and
 * only the newest waiter builds and posts its request.
 */
export const estimateKitPresenceInWorker = async (
    input: KitPresenceInput,
): Promise<KitPresenceEstimate | undefined> => {
    const ticket = ++latestPresenceTicket;
    while (presenceInFlight) {
        await presenceInFlight.catch(() => undefined);
    }
    if (ticket !== latestPresenceTicket) {
        return undefined;
    }

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

    const request: Omit<KitPresenceWorkerRequest, "id"> = {
        kind: "presence",
        dim: KIT_EMBEDDING_DIMS,
        trainingIds: Float64Array.from(trainingIds),
        trainingVectors: packEmbeddings(trainingIds, input.embeddings),
        tags,
        candidateIds: Float64Array.from(candidateIds),
        candidateVectors: packEmbeddings(candidateIds, input.embeddings),
    };
    const pending = kitWorker.request(request, [
        request.trainingIds.buffer,
        request.trainingVectors.buffer,
        request.candidateIds.buffer,
        request.candidateVectors.buffer,
        ...request.tags.map((tag) => tag.labels.buffer),
    ]);
    presenceInFlight = pending;
    let response: KitPresenceWorkerResponse;
    try {
        response = (await pending) as KitPresenceWorkerResponse;
    } finally {
        presenceInFlight = undefined;
    }
    if (response.error || !response.tagProbabilities) {
        throw new Error(response.error ?? "Kit presence failed");
    }
    return {
        tagNames,
        candidateIds,
        tagProbabilities: response.tagProbabilities,
    };
};

/** Drop the worker and its cached whitening / tag models (logout or idle). */
const terminateKitMarginsWorker = (): void => {
    kitWorker.terminate();
};

/**
 * Embedded stills carrying at least one kit-nearness tag — the same population
 * as the research corpus — capped by a fixed-seed sample so the worker can
 * reuse its whitening across kits.
 *
 * The cap keeps the ids with the lowest {@link sampleRank} (bottom-k), so
 * adding or removing one file swaps at most one sampled row and the worker's
 * cached whitening survives most library edits.
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
    if (population.length > KIT_MARGIN_TRAINING_ROW_CAP) {
        const rankById = new Map(population.map((id) => [id, sampleRank(id)]));
        population.sort((a, b) => rankById.get(a)! - rankById.get(b)! || a - b);
        population.length = KIT_MARGIN_TRAINING_ROW_CAP;
    }
    return population.sort((a, b) => a - b);
};

/** Seeded 32-bit mix of both halves of a file id (Ente ids exceed 2^32). */
const sampleRank = (id: number): number => {
    let hash = Math.imul((id >>> 0) ^ TRAINING_SAMPLE_SEED, 0x85ebca6b);
    hash = Math.imul(
        hash ^ (hash >>> 13) ^ Math.floor(id / 0x1_0000_0000),
        0xc2b2ae35,
    );
    return (hash ^ (hash >>> 16)) >>> 0;
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

registerReset(terminateKitMarginsWorker);
