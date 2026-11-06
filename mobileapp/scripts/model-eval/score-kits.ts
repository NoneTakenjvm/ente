/**
 * Kit nearness on public multi-label datasets: compares image-embedding models
 * on the app's "rank photos by fit to a tag kit" job, reusing the production
 * scoring. Research only; not app code.
 *
 * Usage (from `mobileapp/`):
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/score-kits.ts [models…]
 * Default models: `mobileclip-s2 mobileclip2-s2 siglip2-b16-256 dinov3-s`. Datasets: `mirflickr25k`, `coco-val2017`
 * (labels = tags); a dataset is skipped when its manifest or any model's
 * vectors are missing. Only ids every model has vectors for are used.
 *
 * Protocol (mirrors `docs/research/kit-nearness-s2-research.md`):
 * - Splits: seeds 42, 99, 123 give a 60/40 train/test photo split; seed 7 is a
 *   separate tuning split.
 * - Eval kits, built on the full dataset: arity 1 = top 24 single labels;
 *   arity 2 and 3 = top 24 label combinations by AND member count,
 *   de-duplicated at member-set Jaccard >= 0.85 (the larger kit wins).
 * - Per kit and seed: train positives (all labels, train split), test positives,
 *   hard negatives (some but not all labels, test), easy negatives (none, test).
 *   Minimums: 8 train positives, 5 test positives, 16 hard negatives (arity >= 2),
 *   24 easy negatives; otherwise that kit/seed is skipped.
 * - Rivals: every other eval kit with >= 2 train members, using train members.
 * - Scorers: `centroid`; `production` (lambda 16, tau 0.02 competitive
 *   distance); `tuned` (lambda x tau grid picked per model and dataset by mean
 *   hard AUC of arity 2-3 kits on seed 7); `margins` (shipped pass-5 learned
 *   margins on top of `tuned`, arity >= 2; falls back to `tuned` when the app
 *   would).
 * - Metrics: hard AUC, easy AUC, hard AP, hard@12, full@12 (arity 1: easy AUC
 *   and full@12 only). Seeds are averaged per kit, then kits are averaged;
 *   paired differences (later model - first model) carry a 95% bootstrap CI over
 *   kits (4,000 resamples, seeded).
 *
 * Output: markdown tables on stdout and in `<root>/results/kits-<stamp>.md`,
 * raw per-kit numbers in the matching `.json`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { l2NormalizeEmbedding } from "@/lib/embedding-vector";
import {
    buildKitWhitening,
    rankByKitMargins,
    trainTagLogOddsModel,
    type KitWhitening,
    type TagLogOddsModel,
} from "@/lib/kit-nearness-margins";
import { KIT_MARGIN_MIN_EXAMPLES } from "@/lib/kit-nearness-margins-job";
import {
    kitEmbeddingDistanceCompetitive,
    kitEmbeddingRivalWeights,
    KIT_EMBEDDING_RIVAL_LAMBDA,
    KIT_EMBEDDING_RIVAL_TAU,
    MAX_KIT_SEEDS,
} from "@/lib/kit-nearness-sort";
import { embeddingCosineDistance } from "@/lib/similarity-clip";
import { createRng, shuffleInPlace } from "@/lib/shuffle-files";
import { modelEvalDataRoot, readManifest } from "./manifest";
import { hasVectors, loadVectors } from "./vectors";

type Scorer = "centroid" | "production" | "tuned" | "margins";
export type Metric = "hardAuc" | "easyAuc" | "hardAp" | "hardAt12" | "fullAt12";
export type Metrics = Partial<Record<Metric, number>>;
export type Group = "arity1" | "arity2-3";

type KitResult = {
    dataset: string;
    model: string;
    scorer: Scorer;
    kit: string;
    arity: number;
    seed: number;
    /** Margins only: the app would have kept the tuned order. */
    fellBack?: boolean;
    metrics: Metrics;
};

export type EvalKit = {
    name: string;
    labelIds: number[];
    arity: number;
    members: number;
    /** Per image: how many of the kit's labels it carries. */
    carried: Uint8Array;
};

export type DatasetData = {
    name: string;
    size: number;
    labelNames: string[];
    /** One 0/1 mask over images per label id. */
    labelMasks: Uint8Array[];
    labelCounts: Uint16Array;
    kits: EvalKit[];
};

export type ModelData = {
    name: string;
    dims: number;
    /** Row-major, in dataset image order. */
    packed: Float32Array;
    /** Row views keyed by image index: the app's `ReadonlyEmbeddingMap` shape. */
    vectors: Map<number, Float32Array>;
};

type Split = {
    seed: number;
    isTrain: Uint8Array;
    testRows: Int32Array;
    testIndexByRow: Int32Array;
    /** Margins training sample drawn from the train split. */
    trainingRows: Int32Array;
};

export type SeedContext = {
    data: DatasetData;
    model: ModelData;
    split: Split;
    /** Centroid per kit from up to MAX_KIT_SEEDS train members. */
    centroids: (Float32Array | undefined)[];
    trainCounts: number[];
    /** Cosine distance of every image to every kit centroid, `size × kits`. */
    distances: Float32Array;
    trainingVectors: Float32Array;
    testVectors: Float32Array;
    whitening?: KitWhitening;
    tagModels: Map<number, TagLogOddsModel>;
};

/** Indices into `split.testRows`. */
export type Fold = { positives: number[]; hard: number[]; easy: number[] };

type Params = { lambda: number; tau: number };

const DEFAULT_MODELS = ["mobileclip-s2", "mobileclip2-s2", "siglip2-b16-256", "dinov3-s"];
const DATASETS = ["mirflickr25k", "coco-val2017"];
export const EVAL_SEEDS = [42, 99, 123];
export const TUNE_SEED = 7;
const TRAIN_FRACTION = 0.6;
const KITS_PER_ARITY = 24;
const JACCARD_LIMIT = 0.85;
/** A kit needs at least 8 train + 5 test positives, so rarer combinations never qualify. */
const MIN_CANDIDATE_MEMBERS = 13;
const LAMBDAS = [0, 4, 8, 16, 32];
const TAUS = [0.005, 0.01, 0.02, 0.04, 0.08];
const PRODUCTION_PARAMS: Params = {
    lambda: KIT_EMBEDDING_RIVAL_LAMBDA,
    tau: KIT_EMBEDDING_RIVAL_TAU,
};
const MIN_TRAIN_POSITIVES = 8;
const MIN_POSITIVES = 5;
const MIN_HARD = 16;
const MIN_EASY = 24;
/** `KIT_MARGIN_TRAINING_ROW_CAP` in `kit-nearness-margins-job.ts` (not exported). */
const MARGIN_TRAINING_ROW_CAP = 3000;
const BOOTSTRAP_RESAMPLES = 4000;
const SCORERS: Scorer[] = ["centroid", "production", "tuned", "margins"];
export const METRIC_LABELS: Record<Metric, string> = {
    hardAuc: "Hard AUC",
    easyAuc: "Easy AUC",
    hardAp: "Hard AP",
    hardAt12: "Hard@12",
    fullAt12: "Full@12",
};
const METRICS_BY_GROUP: Record<Group, Metric[]> = {
    arity1: ["easyAuc", "fullAt12"],
    "arity2-3": ["hardAuc", "easyAuc", "hardAp", "hardAt12", "fullAt12"],
};

const startedAt = Date.now();

export const log = (message: string): void => {
    console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${message}`);
};

const main = (): void => {
    const models = process.argv.slice(2);
    if (!models.length) {
        models.push(...DEFAULT_MODELS);
    }
    const results: KitResult[] = [];
    const tuned: Record<string, Record<string, Params & { tuneHardAuc: number | null }>> = {};
    const usedDatasets: string[] = [];

    for (const dataset of DATASETS) {
        const loaded = loadDataset(dataset, models);
        if (!loaded) {
            continue;
        }
        usedDatasets.push(dataset);
        const { data, modelData } = loaded;
        log(
            `${dataset}: ${data.size} images, ${data.labelNames.length} labels, ` +
                `${data.kits.length} eval kits (${[1, 2, 3].map((a) => `${data.kits.filter((k) => k.arity === a).length}×${a}`).join(", ")})`,
        );
        tuned[dataset] = {};
        for (const model of modelData) {
            const tuneContext = buildSeedContext(data, model, makeSplit(data, TUNE_SEED));
            const choice = tuneParams(tuneContext);
            tuned[dataset]![model.name] = choice;
            log(
                `${dataset}/${model.name}: tuned lambda=${choice.lambda} tau=${choice.tau} ` +
                    `(seed-7 hard AUC ${choice.tuneHardAuc === null ? "n/a" : (choice.tuneHardAuc * 100).toFixed(1)})`,
            );
            for (const seed of EVAL_SEEDS) {
                const context =
                    seed === TUNE_SEED ? tuneContext : buildSeedContext(data, model, makeSplit(data, seed));
                results.push(...evaluateSeed(context, choice));
                log(`${dataset}/${model.name}: seed ${seed} done`);
            }
        }
    }
    if (!usedDatasets.length) {
        throw new Error(`No dataset has a manifest and vectors for all of: ${models.join(", ")}`);
    }

    const markdown = renderMarkdown(models, usedDatasets, results, tuned);
    console.log(`\n${markdown}`);
    const directory = join(modelEvalDataRoot(), "results");
    mkdirSync(directory, { recursive: true });
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
        `${pad(now.getHours())}${pad(now.getMinutes())}`;
    writeFileSync(join(directory, `kits-${stamp}.md`), markdown);
    writeFileSync(
        join(directory, `kits-${stamp}.json`),
        JSON.stringify({ models, datasets: usedDatasets, tuned, results }),
    );
    log(`wrote ${join(directory, `kits-${stamp}`)}.{md,json}`);
};

// ---------------------------------------------------------------------------
// Data loading and eval kits

export const loadDataset = (
    name: string,
    models: string[],
): { data: DatasetData; modelData: ModelData[] } | undefined => {
    if (!existsSync(join(modelEvalDataRoot(), name, "manifest.json"))) {
        log(`${name}: no manifest, skipping`);
        return undefined;
    }
    const missing = models.filter((model) => !hasVectors(model, name));
    if (missing.length) {
        log(`${name}: no vectors for ${missing.join(", ")}, skipping`);
        return undefined;
    }
    const manifest = readManifest(name);
    const vectorSets = models.map((model) => loadVectors(model, name));
    const images = manifest.images.filter((image) =>
        vectorSets.every((set) => set.rowById.has(image.id)),
    );
    if (!images.length) {
        log(`${name}: no ids shared by all models, skipping`);
        return undefined;
    }

    const modelData = vectorSets.map((set): ModelData => {
        const packed = new Float32Array(images.length * set.dims);
        images.forEach((image, index) => {
            const row = set.rowById.get(image.id)!;
            packed.set(set.packed.subarray(row * set.dims, (row + 1) * set.dims), index * set.dims);
        });
        const vectors = new Map<number, Float32Array>();
        for (let index = 0; index < images.length; index += 1) {
            vectors.set(index, packed.subarray(index * set.dims, (index + 1) * set.dims));
        }
        return { name: set.model, dims: set.dims, packed, vectors };
    });

    const labelIdByName = new Map<string, number>();
    const labelNames: string[] = [];
    const imageLabels = images.map((image) =>
        [...new Set(image.labels ?? [])]
            .map((label) => {
                let id = labelIdByName.get(label);
                if (id === undefined) {
                    id = labelNames.length;
                    labelIdByName.set(label, id);
                    labelNames.push(label);
                }
                return id;
            })
            .sort((a, b) => a - b),
    );
    const labelMasks = labelNames.map(() => new Uint8Array(images.length));
    const labelCounts = new Uint16Array(images.length);
    imageLabels.forEach((ids, index) => {
        labelCounts[index] = ids.length;
        for (const id of ids) {
            labelMasks[id]![index] = 1;
        }
    });
    const data: DatasetData = {
        name,
        size: images.length,
        labelNames,
        labelMasks,
        labelCounts,
        kits: [],
    };
    data.kits = buildEvalKits(data, imageLabels);
    return { data, modelData };
};

/** Top single labels, plus de-duplicated top AND combinations of 2 and 3 labels. */
const buildEvalKits = (data: DatasetData, imageLabels: number[][]): EvalKit[] => {
    const kits: EvalKit[] = [];
    for (const arity of [1, 2, 3]) {
        const counts = new Map<string, number>();
        for (const ids of imageLabels) {
            forEachSubset(ids, arity, (subset) => {
                const key = subset.join(",");
                counts.set(key, (counts.get(key) ?? 0) + 1);
            });
        }
        const ranked = [...counts.entries()].sort(
            (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
        );
        const kept: EvalKit[] = [];
        for (const [key, count] of ranked) {
            if (kept.length >= KITS_PER_ARITY || count < MIN_CANDIDATE_MEMBERS) {
                break;
            }
            const labelIds = key.split(",").map(Number);
            const carried = carriedCounts(data, labelIds);
            const candidate: EvalKit = {
                name: labelIds.map((id) => data.labelNames[id]!).join("+"),
                labelIds,
                arity,
                members: count,
                carried,
            };
            // Ranked by member count, so a near-duplicate of a kept kit is never the larger one.
            if (arity === 1 || kept.every((other) => jaccard(candidate, other, data.size) < JACCARD_LIMIT)) {
                kept.push(candidate);
            }
        }
        kits.push(...kept);
    }
    return kits;
};

const forEachSubset = (ids: number[], size: number, visit: (subset: number[]) => void): void => {
    const pick = (start: number, chosen: number[]): void => {
        if (chosen.length === size) {
            visit(chosen);
            return;
        }
        for (let i = start; i < ids.length; i += 1) {
            pick(i + 1, [...chosen, ids[i]!]);
        }
    };
    pick(0, []);
};

const carriedCounts = (data: DatasetData, labelIds: number[]): Uint8Array => {
    const carried = new Uint8Array(data.size);
    for (const id of labelIds) {
        const mask = data.labelMasks[id]!;
        for (let i = 0; i < data.size; i += 1) {
            carried[i]! += mask[i]!;
        }
    }
    return carried;
};

const jaccard = (left: EvalKit, right: EvalKit, size: number): number => {
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < size; i += 1) {
        const inLeft = left.carried[i] === left.arity;
        const inRight = right.carried[i] === right.arity;
        if (inLeft && inRight) {
            intersection += 1;
        }
        if (inLeft || inRight) {
            union += 1;
        }
    }
    return union === 0 ? 0 : intersection / union;
};

// ---------------------------------------------------------------------------
// Splits and per-seed state

export const makeSplit = (data: DatasetData, seed: number): Split => {
    const order = shuffleInPlace(
        Array.from({ length: data.size }, (_, index) => index),
        createRng(seed),
    );
    const trainSize = Math.round(data.size * TRAIN_FRACTION);
    const isTrain = new Uint8Array(data.size);
    for (let i = 0; i < trainSize; i += 1) {
        isTrain[order[i]!] = 1;
    }
    const testRows: number[] = [];
    const population: number[] = [];
    for (let row = 0; row < data.size; row += 1) {
        if (!isTrain[row]) {
            testRows.push(row);
        } else if (data.labelCounts[row]! > 0) {
            population.push(row);
        }
    }
    if (population.length > MARGIN_TRAINING_ROW_CAP) {
        const rankByRow = new Map(population.map((row) => [row, sampleRank(row)]));
        population.sort((a, b) => rankByRow.get(a)! - rankByRow.get(b)! || a - b);
        population.length = MARGIN_TRAINING_ROW_CAP;
    }
    population.sort((a, b) => a - b);
    const testIndexByRow = new Int32Array(data.size).fill(-1);
    testRows.forEach((row, index) => {
        testIndexByRow[row] = index;
    });
    return {
        seed,
        isTrain,
        testRows: Int32Array.from(testRows),
        testIndexByRow,
        trainingRows: Int32Array.from(population),
    };
};

/**
 * [Note: Replicated from kit-nearness-margins-job.ts]
 *
 * `sampleRank` is not exported; copied verbatim so the 3000-row training
 * sample is drawn the same way (row indices stand in for file ids).
 */
const TRAINING_SAMPLE_SEED = 0x5a2f;
const sampleRank = (id: number): number => {
    let hash = Math.imul((id >>> 0) ^ TRAINING_SAMPLE_SEED, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13) ^ Math.floor(id / 0x1_0000_0000), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
};

export const buildSeedContext = (data: DatasetData, model: ModelData, split: Split): SeedContext => {
    const centroids: (Float32Array | undefined)[] = [];
    const trainCounts: number[] = [];
    for (const kit of data.kits) {
        const seedRows: number[] = [];
        let count = 0;
        for (let row = 0; row < data.size; row += 1) {
            if (split.isTrain[row] && kit.carried[row] === kit.arity) {
                count += 1;
                if (seedRows.length < MAX_KIT_SEEDS) {
                    seedRows.push(row);
                }
            }
        }
        trainCounts.push(count);
        centroids.push(kitCentroid(seedRows, model));
    }
    const kitCount = data.kits.length;
    const distances = new Float32Array(data.size * kitCount);
    for (let row = 0; row < data.size; row += 1) {
        const vector = model.vectors.get(row)!;
        for (let k = 0; k < kitCount; k += 1) {
            distances[row * kitCount + k] = centroids[k]
                ? embeddingCosineDistance(vector, centroids[k])
                : Number.POSITIVE_INFINITY;
        }
    }
    return {
        data,
        model,
        split,
        centroids,
        trainCounts,
        distances,
        trainingVectors: packRows(split.trainingRows, model),
        testVectors: packRows(split.testRows, model),
        tagModels: new Map(),
    };
};

/**
 * [Note: Replicated from kit-nearness-sort.ts]
 *
 * `buildKitEmbeddingCentroid` hardcodes `KIT_EMBEDDING_DIMS = 512`, so this
 * is the same few lines with the model's own dims. Seeds are the first
 * MAX_KIT_SEEDS rows in ascending id order, as `collectSeedCandidates` does.
 */
const kitCentroid = (seedRows: number[], model: ModelData): Float32Array | undefined => {
    const accumulator = new Float32Array(model.dims);
    for (const row of seedRows) {
        const vector = model.vectors.get(row)!;
        for (let i = 0; i < model.dims; i += 1) {
            accumulator[i]! += vector[i]!;
        }
    }
    return seedRows.length ? l2NormalizeEmbedding(accumulator) : undefined;
};

const packRows = (rows: Int32Array, model: ModelData): Float32Array => {
    const out = new Float32Array(rows.length * model.dims);
    rows.forEach((row, index) => {
        out.set(model.vectors.get(row)!, index * model.dims);
    });
    return out;
};

// ---------------------------------------------------------------------------
// Folds and scorers

export const buildFold = (context: SeedContext, kitIndex: number): Fold | undefined => {
    const kit = context.data.kits[kitIndex]!;
    if (context.trainCounts[kitIndex]! < MIN_TRAIN_POSITIVES) {
        return undefined;
    }
    const fold: Fold = { positives: [], hard: [], easy: [] };
    context.split.testRows.forEach((row, index) => {
        const carried = kit.carried[row]!;
        if (carried === kit.arity) {
            fold.positives.push(index);
        } else if (carried > 0) {
            fold.hard.push(index);
        } else {
            fold.easy.push(index);
        }
    });
    if (
        fold.positives.length < MIN_POSITIVES ||
        fold.easy.length < MIN_EASY ||
        (kit.arity >= 2 && fold.hard.length < MIN_HARD)
    ) {
        return undefined;
    }
    return fold;
};

/** Other eval kits with >= 2 train members, as the app's saved-kit rivals. */
const rivalsOf = (context: SeedContext, kitIndex: number): number[] =>
    context.data.kits
        .map((_, index) => index)
        .filter(
            (index) =>
                index !== kitIndex && context.trainCounts[index]! >= 2 && context.centroids[index],
        );

const rivalWeights = (
    context: SeedContext,
    kitIndex: number,
    rivals: number[],
    tau: number,
): number[] =>
    kitEmbeddingRivalWeights(
        [context.centroids[kitIndex]!],
        rivals.map((index) => [context.centroids[index]!]),
        tau,
    );

/**
 * [Note: Replicated from kit-nearness-sort.ts]
 *
 * Strongest weighted rival steal per row (`strongestRivalPenalty`), computed
 * from the precomputed distance matrix so every lambda reuses it. The
 * competitive distance is `dSelected + lambda * penalty`; the parity check in
 * {@link checkParity} compares this against `kitEmbeddingDistanceCompetitive`.
 */
const rivalPenalties = (
    context: SeedContext,
    kitIndex: number,
    rivals: number[],
    weights: number[],
    rows: ArrayLike<number>,
): Float64Array => {
    const kitCount = context.data.kits.length;
    const penalties = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        const base = rows[i]! * kitCount;
        const selected = context.distances[base + kitIndex]!;
        let best = 0;
        for (let r = 0; r < rivals.length; r += 1) {
            const steal = Math.max(0, selected - context.distances[base + rivals[r]!]!);
            if (steal > 0) {
                const penalty = steal * weights[r]!;
                if (penalty > best) {
                    best = penalty;
                }
            }
        }
        penalties[i] = best;
    }
    return penalties;
};

/** Higher-is-nearer production score: `-(dSelected + lambda * penalty)`. */
const productionScores = (
    context: SeedContext,
    kitIndex: number,
    rows: ArrayLike<number>,
    penalties: Float64Array,
    lambda: number,
): Float64Array => {
    const kitCount = context.data.kits.length;
    const scores = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        scores[i] = -(context.distances[rows[i]! * kitCount + kitIndex]! + lambda * penalties[i]!);
    }
    return scores;
};

/** Pick lambda and tau by mean hard AUC of arity 2-3 kits on the tuning split. */
const tuneParams = (context: SeedContext): Params & { tuneHardAuc: number | null } => {
    const sums = LAMBDAS.map(() => TAUS.map(() => 0));
    let kitsUsed = 0;
    context.data.kits.forEach((kit, kitIndex) => {
        const fold = kit.arity >= 2 ? buildFold(context, kitIndex) : undefined;
        if (!fold) {
            return;
        }
        kitsUsed += 1;
        const subset = [...fold.positives, ...fold.hard];
        const rows = subset.map((index) => context.split.testRows[index]!);
        const rivals = rivalsOf(context, kitIndex);
        TAUS.forEach((tau, tauIndex) => {
            const penalties = rivalPenalties(
                context,
                kitIndex,
                rivals,
                rivalWeights(context, kitIndex, rivals, tau),
                rows,
            );
            LAMBDAS.forEach((lambda, lambdaIndex) => {
                const scores = productionScores(context, kitIndex, rows, penalties, lambda);
                sums[lambdaIndex]![tauIndex]! += rankAuc(
                    scores.subarray(0, fold.positives.length),
                    scores.subarray(fold.positives.length),
                );
            });
        });
    });
    if (!kitsUsed) {
        return { ...PRODUCTION_PARAMS, tuneHardAuc: null };
    }
    let best = { ...PRODUCTION_PARAMS, tuneHardAuc: -1 };
    LAMBDAS.forEach((lambda, lambdaIndex) => {
        TAUS.forEach((tau, tauIndex) => {
            const mean = sums[lambdaIndex]![tauIndex]! / kitsUsed;
            if (mean > best.tuneHardAuc) {
                best = { lambda, tau, tuneHardAuc: mean };
            }
        });
    });
    return best;
};

/** Score every kit that has a valid fold under this seed with all four scorers. */
const evaluateSeed = (context: SeedContext, tunedParams: Params): KitResult[] => {
    const { data, model, split } = context;
    const results: KitResult[] = [];
    let parityChecked = false;
    data.kits.forEach((kit, kitIndex) => {
        const fold = buildFold(context, kitIndex);
        if (!fold) {
            return;
        }
        const rivals = rivalsOf(context, kitIndex);
        const testRows = split.testRows;
        const record = (scorer: Scorer, scores: Float64Array, fellBack?: boolean): void => {
            results.push({
                dataset: data.name,
                model: model.name,
                scorer,
                kit: kit.name,
                arity: kit.arity,
                seed: split.seed,
                ...(fellBack === undefined ? {} : { fellBack }),
                metrics: computeMetrics(scores, fold, kit.arity, testRows),
            });
        };
        const scoreWith = (params: Params, rows: ArrayLike<number>): Float64Array =>
            productionScores(
                context,
                kitIndex,
                rows,
                rivalPenalties(
                    context,
                    kitIndex,
                    rivals,
                    rivalWeights(context, kitIndex, rivals, params.tau),
                    rows,
                ),
                params.lambda,
            );

        record("centroid", productionScores(context, kitIndex, testRows, new Float64Array(testRows.length), 0));
        const production = scoreWith(PRODUCTION_PARAMS, testRows);
        record("production", production);
        if (!parityChecked) {
            checkParity(context, kitIndex, rivals, production);
            parityChecked = true;
        }
        const tunedScores = scoreWith(tunedParams, testRows);
        record("tuned", tunedScores);
        if (kit.arity >= 2) {
            const margins = marginsScores(
                context,
                kit,
                tunedScores,
                scoreWith(tunedParams, split.trainingRows),
            );
            record("margins", margins ?? tunedScores, margins === undefined);
        }
    });
    return results;
};

/**
 * Compare the matrix-based production score with the imported
 * `kitEmbeddingDistanceCompetitive` on a few test rows; throws on drift.
 */
const checkParity = (
    context: SeedContext,
    kitIndex: number,
    rivals: number[],
    scores: Float64Array,
): void => {
    const rivalSets = rivals.map((index) => [context.centroids[index]!]);
    const weights = rivalWeights(context, kitIndex, rivals, PRODUCTION_PARAMS.tau);
    const step = Math.max(1, Math.floor(context.split.testRows.length / 20));
    for (let i = 0; i < context.split.testRows.length; i += step) {
        const expected = -kitEmbeddingDistanceCompetitive(
            context.split.testRows[i]!,
            [context.centroids[kitIndex]!],
            rivalSets,
            context.model.vectors,
            { ...PRODUCTION_PARAMS, rivalWeights: weights },
        );
        if (Math.abs(expected - scores[i]!) > 1e-4) {
            throw new Error(
                `Production score drift for ${context.data.kits[kitIndex]!.name}: ${expected} vs ${scores[i]}`,
            );
        }
    }
};

/**
 * Shipped pass-5 margins on top of the tuned production scores, mirroring
 * `buildKitMarginsRanking` and the worker. Returns `undefined` where the app
 * keeps the production order.
 *
 * Whitening and per-tag models depend only on the training sample and the tag's
 * labels, so they are cached across kits (the worker's cache does the same).
 */
const marginsScores = (
    context: SeedContext,
    kit: EvalKit,
    tunedTestScores: Float64Array,
    tunedTrainingScores: Float64Array,
): Float64Array | undefined => {
    const { data, model, split } = context;
    const rows = split.trainingRows.length;
    const tags = kit.labelIds.map((id) => ({
        name: data.labelNames[id]!,
        labels: Uint8Array.from(split.trainingRows, (row) => data.labelMasks[id]![row]!),
    }));
    if (!hasEnoughExamples(tags, rows)) {
        return undefined;
    }
    context.whitening ??= buildKitWhitening(context.trainingVectors, rows, model.dims);
    const whitening = context.whitening;
    const tagModels = kit.labelIds.map((id, index) => {
        let tagModel = context.tagModels.get(id);
        if (!tagModel) {
            tagModel = trainTagLogOddsModel(whitening, tags[index]!.labels);
            context.tagModels.set(id, tagModel);
        }
        return tagModel;
    });
    const order = rankByKitMargins(
        {
            dim: model.dims,
            trainingVectors: context.trainingVectors,
            trainingProductionScores: Float32Array.from(tunedTrainingScores),
            tags,
            candidateIds: Float64Array.from(split.testRows),
            candidateVectors: context.testVectors,
            candidateProductionScores: Float32Array.from(tunedTestScores),
        },
        whitening,
        tagModels,
    );
    if (!order) {
        return undefined;
    }
    const scores = new Float64Array(split.testRows.length);
    order.forEach((row, position) => {
        scores[split.testIndexByRow[row]!] = order.length - position;
    });
    return scores;
};

/**
 * [Note: Replicated from kit-nearness-margins-job.ts]
 *
 * `hasEnoughExamples` and `hasEnoughTagExamples` are not exported; same
 * rule, using the exported `KIT_MARGIN_MIN_EXAMPLES`.
 */
const hasEnoughExamples = (tags: readonly { labels: Uint8Array }[], rows: number): boolean => {
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
    if (complete < KIT_MARGIN_MIN_EXAMPLES || partial < KIT_MARGIN_MIN_EXAMPLES) {
        return false;
    }
    return tags.every((tag) => {
        let positives = 0;
        for (const label of tag.labels) {
            positives += label;
        }
        return (
            positives >= KIT_MARGIN_MIN_EXAMPLES &&
            tag.labels.length - positives >= KIT_MARGIN_MIN_EXAMPLES
        );
    });
};

// ---------------------------------------------------------------------------
// Metrics

export const computeMetrics = (
    scores: Float64Array,
    fold: Fold,
    arity: number,
    testRows: Int32Array,
): Metrics => {
    const pick = (indices: number[]): number[] => indices.map((index) => scores[index]!);
    const isPositive = new Uint8Array(testRows.length);
    for (const index of fold.positives) {
        isPositive[index] = 1;
    }
    const k = Math.min(12, fold.positives.length);
    const everyIndex = Array.from({ length: testRows.length }, (_, index) => index);
    const metrics: Metrics = {
        easyAuc: rankAuc(pick(fold.positives), pick(fold.easy)),
        fullAt12: topFraction(rankIndices(scores, everyIndex, testRows), isPositive, k),
    };
    if (arity >= 2) {
        const subset = rankIndices(scores, [...fold.positives, ...fold.hard], testRows);
        metrics.hardAuc = rankAuc(pick(fold.positives), pick(fold.hard));
        metrics.hardAp = averagePrecision(subset, isPositive);
        metrics.hardAt12 = topFraction(subset, isPositive, k);
    }
    return metrics;
};

/** Indices ordered by descending score, ties by lower row (the app's id tie-break). */
const rankIndices = (scores: Float64Array, indices: number[], testRows: Int32Array): number[] =>
    [...indices].sort((a, b) => scores[b]! - scores[a]! || testRows[a]! - testRows[b]!);

const topFraction = (ranked: number[], isPositive: Uint8Array, k: number): number => {
    let hits = 0;
    for (let i = 0; i < k; i += 1) {
        hits += isPositive[ranked[i]!]!;
    }
    return hits / k;
};

export const averagePrecision = (ranked: number[], isPositive: Uint8Array): number => {
    let hits = 0;
    let sum = 0;
    ranked.forEach((index, position) => {
        if (isPositive[index]) {
            hits += 1;
            sum += hits / (position + 1);
        }
    });
    return hits ? sum / hits : 0;
};

/**
 * Mann-Whitney AUC via average ranks, O(n log n). Equivalent to the app's
 * `mannWhitneyAuc` (ties count half) without its O(positives x negatives) loop.
 */
export const rankAuc = (positives: ArrayLike<number>, negatives: ArrayLike<number>): number => {
    const positiveCount = positives.length;
    const negativeCount = negatives.length;
    if (!positiveCount || !negativeCount) {
        return 0.5;
    }
    const values = new Float64Array(positiveCount + negativeCount);
    for (let i = 0; i < positiveCount; i += 1) {
        values[i] = positives[i]!;
    }
    for (let i = 0; i < negativeCount; i += 1) {
        values[positiveCount + i] = negatives[i]!;
    }
    const order = Array.from(values.keys()).sort((a, b) => values[a]! - values[b]!);
    let positiveRankSum = 0;
    let start = 0;
    while (start < order.length) {
        let end = start;
        while (end + 1 < order.length && values[order[end + 1]!] === values[order[start]!]) {
            end += 1;
        }
        const averageRank = (start + end) / 2 + 1;
        for (let i = start; i <= end; i += 1) {
            if (order[i]! < positiveCount) {
                positiveRankSum += averageRank;
            }
        }
        start = end + 1;
    }
    return (
        (positiveRankSum - (positiveCount * (positiveCount + 1)) / 2) /
        (positiveCount * negativeCount)
    );
};

// ---------------------------------------------------------------------------
// Aggregation and output

export const groupOf = (arity: number): Group => (arity === 1 ? "arity1" : "arity2-3");

/** Per-kit mean over seeds of one metric. */
export const kitMeans = (rows: { kit: string; metrics: Metrics }[], metric: Metric): Map<string, number> => {
    const sums = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
        const value = row.metrics[metric];
        if (value === undefined) {
            continue;
        }
        const entry = sums.get(row.kit) ?? { sum: 0, count: 0 };
        entry.sum += value;
        entry.count += 1;
        sums.set(row.kit, entry);
    }
    return new Map([...sums].map(([kit, { sum, count }]) => [kit, sum / count]));
};

export const mean = (values: number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;

export const bootstrapInterval = (differences: number[]): [number, number] => {
    const rng = createRng(20240617);
    const means: number[] = [];
    for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
        let total = 0;
        for (let i = 0; i < differences.length; i += 1) {
            total += differences[Math.floor(rng() * differences.length)]!;
        }
        means.push(total / differences.length);
    }
    means.sort((a, b) => a - b);
    return [
        means[Math.floor(0.025 * (BOOTSTRAP_RESAMPLES - 1))]!,
        means[Math.ceil(0.975 * (BOOTSTRAP_RESAMPLES - 1))]!,
    ];
};

export const percent = (value: number): string => (value * 100).toFixed(1);
export const signedPercent = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;

const renderMarkdown = (
    models: string[],
    datasets: string[],
    results: KitResult[],
    tuned: Record<string, Record<string, Params & { tuneHardAuc: number | null }>>,
): string => {
    const lines = [
        `# Kit nearness model comparison`,
        ``,
        `Models: ${models.join(", ")}. Values are percentages; Δ = ${models.slice(1).join(" / ") || "n/a"} minus ${models[0]} in percentage points, with a 95% bootstrap CI over kits (${BOOTSTRAP_RESAMPLES} resamples). Seeds ${EVAL_SEEDS.join("/")} averaged per kit.`,
        ``,
    ];
    for (const dataset of datasets) {
        lines.push(
            `## ${dataset}`,
            ``,
            `Tuned (lambda, tau) by seed-${TUNE_SEED} hard AUC: ${models
                .map((model) => {
                    const choice = tuned[dataset]![model]!;
                    return `${model} λ=${choice.lambda} τ=${choice.tau}`;
                })
                .join("; ")}`,
            ``,
        );
        for (const scorer of SCORERS) {
            for (const group of ["arity1", "arity2-3"] as Group[]) {
                if (scorer === "margins" && group === "arity1") {
                    continue;
                }
                const rows = results.filter(
                    (row) =>
                        row.dataset === dataset &&
                        row.scorer === scorer &&
                        groupOf(row.arity) === group,
                );
                if (!rows.length) {
                    continue;
                }
                lines.push(...renderTable(models, dataset, scorer, group, rows), ``);
            }
        }
    }
    return lines.join("\n");
};

const renderTable = (
    models: string[],
    dataset: string,
    scorer: Scorer,
    group: Group,
    rows: KitResult[],
): string[] => {
    const rowsByModel = models.map((model) => rows.filter((row) => row.model === model));
    const kitCount = new Set(rows.map((row) => row.kit)).size;
    const seedCount = rows.length / models.length;
    const header = [
        `### ${dataset} · ${scorer} · ${group === "arity1" ? "arity 1" : "arity 2–3"} (${kitCount} kits, ${seedCount} kit-seeds per model)`,
        ``,
    ];
    if (scorer === "margins") {
        const fallbacks = models.map((model, index) => {
            const used = rowsByModel[index]!;
            return `${model}: ${used.filter((row) => row.fellBack).length}/${used.length}`;
        });
        header.push(`Fell back to tuned order (kit-seeds): ${fallbacks.join("; ")}`, ``);
    }
    const deltaColumns = models.slice(1).map((model) => `Δ ${model} − ${models[0]} [95% CI]`);
    const table = [
        `| Metric | ${[...models, ...deltaColumns].join(" | ")} |`,
        `|${"---|".repeat(1 + models.length + deltaColumns.length)}`,
    ];
    for (const metric of METRICS_BY_GROUP[group]) {
        const meansByModel = rowsByModel.map((modelRows) => kitMeans(modelRows, metric));
        const cells = meansByModel.map((kitValues) => percent(mean([...kitValues.values()])));
        const deltas = meansByModel.slice(1).map((kitValues) => {
            const differences = [...kitValues]
                .filter(([kit]) => meansByModel[0]!.has(kit))
                .map(([kit, value]) => value - meansByModel[0]!.get(kit)!);
            if (!differences.length) {
                return "n/a";
            }
            const [low, high] = bootstrapInterval(differences);
            return `${signedPercent(mean(differences))} [${signedPercent(low)}, ${signedPercent(high)}]`;
        });
        table.push(`| ${METRIC_LABELS[metric]} | ${[...cells, ...deltas].join(" | ")} |`);
    }
    return [...header, ...table];
};

// Only run as a CLI, not when score-kits-text.ts imports the helpers above.
if (/[\\/]score-kits\.ts$/.test(process.argv[1] ?? "")) {
    main();
}
