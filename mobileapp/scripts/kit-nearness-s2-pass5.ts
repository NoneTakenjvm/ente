/**
 * Pass 5: whitened (shrunk-LDA) hard-negative margin and learned per-tag
 * logistic directions on top of the pass-4 scorer.
 *
 * Same leakage-free protocol as pass 4: global photo split, dHash duplicate
 * groups stay on one side, every evaluated photo is absent from every
 * prototype. One global shrunk total-scatter matrix is estimated from training
 * photos; its Cholesky factor whitens the hard-negative direction and the
 * coordinates in which per-tag logistic regressions are trained.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass5.ts
 *
 * Env: PASS5_DUP_THRESHOLD (default 6), PASS5_SKIP_LR=1 to skip logistic
 * regression (stress runs).
 *
 * Families dropped after the first pass-5 run (results in the research log):
 * balanced hard negatives, whitened rival steal, whitened kit-vs-rest term,
 * learned kit-vs-hard logistic direction.
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    runStage1ClusteringSync,
    type Stage1Item,
} from "../src/lib/similarity-stage1-core";

const CORPUS_PATH = "C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json";

const DIM = 512;
const MIN_KIT_MEMBERS = 20;
const MIN_TRAIN_POSITIVES = 8;
const MIN_TEST_POSITIVES = 5;
const MIN_TEST_HARD_NEGATIVES = 16;
const MIN_TEST_EASY_NEGATIVES = 24;
const JACCARD_DEDUP = 0.85;
const MAX_KITS_PER_ARITY = 24;
const TRAIN_FRACTION = 0.6;
const PRODUCTION_SEED_CAP = 150;
const PRODUCTION_LAMBDA = 16;
const PRODUCTION_TAU = 0.02;
const PASS4_HARD_WEIGHT = 8;
const PASS4_TAG_WEIGHT = 8;
const DUPLICATE_HAMMING_THRESHOLD = Number.parseInt(
    process.env.PASS5_DUP_THRESHOLD ?? "6",
    10,
);
const SKIP_LR = process.env.PASS5_SKIP_LR === "1";
const DEVELOPMENT_SEED = 42;
const CONFIRMATION_SEEDS = [99, 123, 2024, 7] as const;
const RESERVED_SEED = 314159;

/** Shrinkage α: ridge = α · trace(S)/DIM added to the total scatter S. */
const ALPHAS = [1] as const;
const ALPHA_MAIN = 1;
const SCATTER_SAMPLE_SIZES = [2000] as const;
/** L2 ladder in whitened coordinates; each rung warm-starts from the previous. */
const LR_LADDER = [
    { l2: 3e-2, iterations: 60 },
    { l2: 1e-2, iterations: 60 },
    { l2: 3e-3, iterations: 80 },
    { l2: 1e-3, iterations: 100 },
] as const;
const LR_L2 = LR_LADDER.map((rung) => rung.l2);
const LR_MAIN_L2 = 1e-2;
const LR_LEARNING_RATE = 0.1;
/** Training subsample for the production-cost check of per-tag LR. */
const LR_SUBSAMPLE = 2000;
const HARD_WEIGHTS = [0, 0.5, 1, 1.5, 2] as const;
const TAG_WEIGHTS = [1, 2, 3, 4, 6] as const;

type SourcePhoto = AnonymisedKitNearnessCorpus["photos"][number];

type Photo = {
    id: number;
    index: number;
    tags: ReadonlySet<string>;
    vector: Float64Array;
    hashes: string[];
};

type EvalKit = {
    id: string;
    source: "saved" | "and-combo";
    tags: string[];
    memberIds: number[];
};

type Fold = {
    kit: EvalKit;
    trainPositiveIds: number[];
    testPositiveIds: number[];
    testHardNegativeIds: number[];
    testEasyNegativeIds: number[];
};

/** 0 positive, 1 hard negative, 2 easy negative. */
type Label = 0 | 1 | 2;

/** One row of score terms per candidate; `sigma` rows hold train-photo stds. */
type FoldFeatures = {
    fold: Fold;
    labels: Uint8Array;
    rows: Float64Array[];
    sigma: Float64Array;
};

type Metrics = {
    hardAuc: number;
    easyAuc: number;
    hardAveragePrecision: number;
    fullAveragePrecision: number;
    hardTop12: number;
    fullTop12: number;
};

type Scorer = {
    name: string;
    score: (t: Float64Array, sigma: Float64Array) => number;
};

type MethodResult = {
    all: Metrics;
    saved: Metrics;
    byKit: Map<string, Metrics>;
};

// ---------------------------------------------------------------------------
// Term columns
// ---------------------------------------------------------------------------

const COLUMNS = [
    "prod",
    "plain",
    "hardRaw",
    ...ALPHAS.map((alpha) => `hardW${alpha}`),
    ...SCATTER_SAMPLE_SIZES.map((size) => `hardSample${size}`),
    "hardUnitW",
    "tagRaw",
    ...LR_L2.map((l2) => `tagLRmin${l2}`),
    ...LR_L2.map((l2) => `tagLRsum${l2}`),
    "tagLRsubMin",
] as const;
type Column = (typeof COLUMNS)[number];
const col = (name: Column): number => COLUMNS.indexOf(name);
const C = {
    prod: col("prod"),
    /** Selected-centroid cosine without the rival steal. */
    plain: col("plain"),
    hardRaw: col("hardRaw"),
    hardW: (alpha: number) => col(`hardW${alpha}` as Column),
    hardSample: (size: number) => col(`hardSample${size}` as Column),
    hardUnitW: col("hardUnitW"),
    tagRaw: col("tagRaw"),
    tagLRmin: (l2: number) => col(`tagLRmin${l2}` as Column),
    tagLRsum: (l2: number) => col(`tagLRsum${l2}` as Column),
    tagLRsubMin: col("tagLRsubMin"),
};

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const shuffleInPlace = <T>(items: T[], random: () => number): void => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const value = items[i]!;
        items[i] = items[j]!;
        items[j] = value;
    }
};

const mean = (values: readonly number[]): number =>
    values.length > 0 ?
        values.reduce((total, value) => total + value, 0) / values.length :
        0;

const dot = (left: Float64Array, right: Float64Array): number => {
    let result = 0;
    for (let i = 0; i < DIM; i++) {
        result += left[i]! * right[i]!;
    }
    return result;
};

const l2Normalize = (values: Float64Array): Float64Array => {
    const norm = Math.sqrt(dot(values, values)) || 1;
    return values.map((value) => value / norm);
};

const difference = (left: Float64Array, right: Float64Array): Float64Array =>
    left.map((value, i) => value - right[i]!);

const comboKey = (tags: readonly string[]): string =>
    [...tags].sort().join("|");

const hasAll = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.length > 0 && kitTags.every((tag) => photoTags.has(tag));

const sharesAny = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.some((tag) => photoTags.has(tag));

// ---------------------------------------------------------------------------
// Corpus, kits, duplicate groups, splits (mirrors pass 4)
// ---------------------------------------------------------------------------

const raw = JSON.parse(
    readFileSync(CORPUS_PATH, "utf8"),
) as AnonymisedKitNearnessCorpus;

const photos: Photo[] = [];
for (const source of raw.photos as SourcePhoto[]) {
    if (!source.embedding || source.embedding.length !== DIM) {
        continue;
    }
    photos.push({
        id: source.id,
        index: photos.length,
        tags: new Set(source.tags),
        vector: l2Normalize(Float64Array.from(source.embedding)),
        hashes: source.hashes,
    });
}
const photoById = new Map(photos.map((photo) => [photo.id, photo]));
const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();
const tagIndex = new Map(allTags.map((tag, index) => [tag, index]));

const centroid = (
    ids: readonly number[],
    cap: number = Number.POSITIVE_INFINITY,
): Float64Array | undefined => {
    const selected =
        Number.isFinite(cap) ?
            [...ids].sort((a, b) => a - b).slice(0, cap) :
            ids;
    const sum = new Float64Array(DIM);
    let count = 0;
    for (const id of selected) {
        const vector = photoById.get(id)?.vector;
        if (!vector) {
            continue;
        }
        for (let i = 0; i < DIM; i++) {
            sum[i]! += vector[i]!;
        }
        count += 1;
    }
    return count > 0 ? l2Normalize(sum) : undefined;
};

const buildEvalKits = (): EvalKit[] => {
    const kits: EvalKit[] = [];
    for (const saved of raw.kits) {
        const memberIds = photos
            .filter((photo) => hasAll(photo.tags, saved.tags))
            .map((photo) => photo.id);
        if (saved.tags.length > 0 && memberIds.length >= MIN_KIT_MEMBERS) {
            kits.push({
                id: saved.id,
                source: "saved",
                tags: [...saved.tags].sort(),
                memberIds,
            });
        }
    }
    for (const arity of [1, 2, 3]) {
        const counts = new Map<string, number[]>();
        for (const photo of photos) {
            const tags = [...photo.tags].sort();
            const visit = (start: number, chosen: string[]): void => {
                if (chosen.length === arity) {
                    const key = comboKey(chosen);
                    counts.set(key, [...(counts.get(key) ?? []), photo.id]);
                    return;
                }
                const remaining = arity - chosen.length;
                for (let i = start; i <= tags.length - remaining; i++) {
                    chosen.push(tags[i]!);
                    visit(i + 1, chosen);
                    chosen.pop();
                }
            };
            visit(0, []);
        }
        const combos = [...counts.entries()]
            .filter(([, ids]) => ids.length >= MIN_KIT_MEMBERS)
            .sort((left, right) => right[1].length - left[1].length)
            .slice(0, MAX_KITS_PER_ARITY);
        combos.forEach(([key, memberIds], index) => {
            kits.push({
                id: `and${arity}_${String(index + 1).padStart(2, "0")}`,
                source: "and-combo",
                tags: key.split("|"),
                memberIds,
            });
        });
    }
    const uniqueByTags = new Map<string, EvalKit>();
    for (const kit of kits) {
        const key = comboKey(kit.tags);
        const previous = uniqueByTags.get(key);
        if (
            !previous ||
            (previous.source !== "saved" && kit.source === "saved") ||
            kit.memberIds.length > previous.memberIds.length
        ) {
            uniqueByTags.set(key, kit);
        }
    }
    const sorted = [...uniqueByTags.values()].sort(
        (left, right) =>
            right.tags.length - left.tags.length ||
            right.memberIds.length - left.memberIds.length,
    );
    const kept: EvalKit[] = [];
    const memberSets: Set<number>[] = [];
    for (const kit of sorted) {
        const members = new Set(kit.memberIds);
        const jaccard = (other: Set<number>): number => {
            let intersection = 0;
            for (const id of members) {
                if (other.has(id)) {
                    intersection += 1;
                }
            }
            return intersection / (members.size + other.size - intersection);
        };
        if (memberSets.some((existing) => jaccard(existing) >= JACCARD_DEDUP)) {
            continue;
        }
        kept.push(kit);
        memberSets.push(members);
    }
    return kept;
};
const evalKits = buildEvalKits();

const duplicateGroups = ((): number[][] => {
    const hashedItems: Stage1Item[] = photos
        .filter((photo) => photo.hashes.length > 0)
        .map((photo) => ({ fileId: photo.id, hashes: photo.hashes }));
    const clusters = runStage1ClusteringSync(
        hashedItems,
        DUPLICATE_HAMMING_THRESHOLD,
    );
    const grouped = new Set<number>();
    const groups: number[][] = [];
    for (const cluster of clusters) {
        const ids = [...cluster.fileIds].sort((a, b) => a - b);
        groups.push(ids);
        ids.forEach((id) => grouped.add(id));
    }
    for (const photo of photos) {
        if (!grouped.has(photo.id)) {
            groups.push([photo.id]);
        }
    }
    return groups;
})();

const splitByGroups = (
    seed: number,
    fractions: readonly number[],
): Set<number>[] => {
    const groups = duplicateGroups.map((group) => [...group]);
    shuffleInPlace(groups, mulberry32(seed));
    const targets = fractions.map((fraction) =>
        Math.floor(photos.length * fraction));
    const partitions = fractions.map(() => new Set<number>());
    for (const group of groups) {
        let index = partitions.findIndex(
            (partition, i) =>
                i < partitions.length - 1 && partition.size < targets[i]!,
        );
        if (index < 0) {
            index = partitions.length - 1;
        }
        group.forEach((id) => partitions[index]!.add(id));
    }
    return partitions;
};

const buildFolds = (
    trainIds: ReadonlySet<number>,
    testIds: ReadonlySet<number>,
): Fold[] => {
    const folds: Fold[] = [];
    for (const kit of evalKits) {
        if (kit.tags.length < 2) {
            continue;
        }
        const trainPositiveIds = kit.memberIds.filter((id) => trainIds.has(id));
        const testPositiveIds = kit.memberIds.filter((id) => testIds.has(id));
        const testHardNegativeIds: number[] = [];
        const testEasyNegativeIds: number[] = [];
        for (const photo of photos) {
            if (!testIds.has(photo.id) || hasAll(photo.tags, kit.tags)) {
                continue;
            }
            (sharesAny(photo.tags, kit.tags) ?
                testHardNegativeIds :
                testEasyNegativeIds
            ).push(photo.id);
        }
        if (
            trainPositiveIds.length < MIN_TRAIN_POSITIVES ||
            testPositiveIds.length < MIN_TEST_POSITIVES ||
            testHardNegativeIds.length < MIN_TEST_HARD_NEGATIVES ||
            testEasyNegativeIds.length < MIN_TEST_EASY_NEGATIVES
        ) {
            continue;
        }
        folds.push({
            kit,
            trainPositiveIds,
            testPositiveIds,
            testHardNegativeIds,
            testEasyNegativeIds,
        });
    }
    return folds;
};

// ---------------------------------------------------------------------------
// Linear algebra: total scatter, shrunk Cholesky factor, solves
// ---------------------------------------------------------------------------

const cholesky = (matrix: Float64Array): Float64Array => {
    const lower = new Float64Array(DIM * DIM);
    for (let i = 0; i < DIM; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = matrix[i * DIM + j]!;
            for (let k = 0; k < j; k++) {
                sum -= lower[i * DIM + k]! * lower[j * DIM + k]!;
            }
            lower[i * DIM + j] =
                i === j ?
                    Math.sqrt(Math.max(sum, 1e-12)) :
                    sum / lower[j * DIM + j]!;
        }
    }
    return lower;
};

/** Solve L y = b (forward substitution). */
const forwardSolve = (lower: Float64Array, rhs: Float64Array): Float64Array => {
    const y = new Float64Array(DIM);
    for (let i = 0; i < DIM; i++) {
        let sum = rhs[i]!;
        for (let k = 0; k < i; k++) {
            sum -= lower[i * DIM + k]! * y[k]!;
        }
        y[i] = sum / lower[i * DIM + i]!;
    }
    return y;
};

/** Solve Lᵀ x = y (back substitution). */
const backwardSolve = (lower: Float64Array, rhs: Float64Array): Float64Array => {
    const x = new Float64Array(DIM);
    for (let i = DIM - 1; i >= 0; i--) {
        let sum = rhs[i]!;
        for (let k = i + 1; k < DIM; k++) {
            sum -= lower[k * DIM + i]! * x[k]!;
        }
        x[i] = sum / lower[i * DIM + i]!;
    }
    return x;
};

/** Solve (L Lᵀ) x = b. */
const choleskySolve = (lower: Float64Array, rhs: Float64Array): Float64Array =>
    backwardSolve(lower, forwardSolve(lower, rhs));

const meanVector = (rows: readonly Photo[]): Float64Array => {
    const mu = new Float64Array(DIM);
    for (const photo of rows) {
        for (let i = 0; i < DIM; i++) {
            mu[i]! += photo.vector[i]!;
        }
    }
    return mu.map((value) => value / (rows.length || 1));
};

/** Mean-centred total scatter (covariance) of the given photos, plus trace. */
const totalScatter = (
    rows: readonly Photo[],
    mu: Float64Array,
): { matrix: Float64Array; trace: number; ms: number } => {
    const started = Date.now();
    const matrix = new Float64Array(DIM * DIM);
    const centred = new Float64Array(DIM);
    for (const photo of rows) {
        for (let i = 0; i < DIM; i++) {
            centred[i] = photo.vector[i]! - mu[i]!;
        }
        for (let i = 0; i < DIM; i++) {
            const xi = centred[i]!;
            const row = i * DIM;
            for (let j = i; j < DIM; j++) {
                matrix[row + j]! += xi * centred[j]!;
            }
        }
    }
    let trace = 0;
    for (let i = 0; i < DIM; i++) {
        for (let j = i; j < DIM; j++) {
            matrix[i * DIM + j]! /= rows.length;
            matrix[j * DIM + i] = matrix[i * DIM + j]!;
        }
        trace += matrix[i * DIM + i]!;
    }
    return { matrix, trace, ms: Date.now() - started };
};

const shrunkFactor = (
    scatter: { matrix: Float64Array; trace: number },
    alpha: number,
): Float64Array => {
    const shrunk = Float64Array.from(scatter.matrix);
    const ridge = (alpha * scatter.trace) / DIM;
    for (let i = 0; i < DIM; i++) {
        shrunk[i * DIM + i]! += ridge;
    }
    return cholesky(shrunk);
};

// ---------------------------------------------------------------------------
// Logistic regression in whitened coordinates (Adam, class-balanced, L2)
// ---------------------------------------------------------------------------

/** Log-odds(x) = x·weights + offset, expressed in original coordinates. */
type LogisticModel = { weights: Float64Array; offset: number };

/**
 * Train one L2 ladder on whitened rows z = L⁻¹(x − μ); each rung warm-starts
 * from the previous. Returns one model per rung, mapped back to x-space via
 * w_x = L⁻ᵀ w_z so scoring stays a single dot product.
 */
const trainLogisticLadder = (
    whitenedRows: readonly Float64Array[],
    labels: Uint8Array,
    lower: Float64Array,
    mu: Float64Array,
): LogisticModel[] => {
    const n = whitenedRows.length;
    let positives = 0;
    for (let i = 0; i < n; i++) {
        positives += labels[i]!;
    }
    const positiveWeight = n / (2 * Math.max(positives, 1));
    const negativeWeight = n / (2 * Math.max(n - positives, 1));
    const w = new Float64Array(DIM);
    let bias = 0;
    const grad = new Float64Array(DIM);
    const models: LogisticModel[] = [];
    for (const rung of LR_LADDER) {
        const m = new Float64Array(DIM + 1);
        const v = new Float64Array(DIM + 1);
        for (let iteration = 1; iteration <= rung.iterations; iteration++) {
            grad.fill(0);
            let gradBias = 0;
            for (let i = 0; i < n; i++) {
                const z = whitenedRows[i]!;
                const p = 1 / (1 + Math.exp(-(bias + dot(w, z))));
                const g =
                    ((labels[i] ? positiveWeight : negativeWeight) *
                        (p - labels[i]!)) /
                    n;
                for (let d = 0; d < DIM; d++) {
                    grad[d]! += g * z[d]!;
                }
                gradBias += g;
            }
            const correction1 = 1 - 0.9 ** iteration;
            const correction2 = 1 - 0.999 ** iteration;
            for (let d = 0; d <= DIM; d++) {
                const g = d < DIM ? grad[d]! + rung.l2 * w[d]! : gradBias;
                m[d] = 0.9 * m[d]! + 0.1 * g;
                v[d] = 0.999 * v[d]! + 0.001 * g * g;
                const step =
                    (LR_LEARNING_RATE * (m[d]! / correction1)) /
                    (Math.sqrt(v[d]! / correction2) + 1e-8);
                if (d < DIM) {
                    w[d]! -= step;
                } else {
                    bias -= step;
                }
            }
        }
        const weights = backwardSolve(lower, w);
        models.push({ weights, offset: bias - dot(mu, weights) });
    }
    return models;
};

// ---------------------------------------------------------------------------
// Train model (depends only on the training partition)
// ---------------------------------------------------------------------------

type TrainModel = {
    trainIds: ReadonlySet<number>;
    trainPhotos: Photo[];
    factors: Float64Array[];
    sampleFactors: Float64Array[];
    rivals: { id: string; tagsKey: string; centroid: Float64Array }[];
    /** photo index × rival index → cosine similarity. */
    rivalSimilarity: Float64Array;
    tagDirections: (Float64Array | undefined)[];
    /** photo index × tag index → raw tag margin. */
    tagRawMargin: Float64Array;
    /** Per L2 rung: photo index × tag index → log-odds. */
    tagLogOdds: Float64Array[];
    /** Subsample-trained log-odds at LR_MAIN_L2, photo index × tag index. */
    tagLogOddsSub: Float64Array;
    timing: { scatterMs: number; whitenMs: number; lrMs: number };
};

type KitModel = {
    selected: Float64Array;
    hardRawDir: Float64Array;
    hardWDirs: Float64Array[];
    hardSampleWDirs: Float64Array[];
    hardUnitWDir: Float64Array;
    rivalIndices: number[];
    rivalWeights: number[];
    tagIndices: number[];
};

const buildTrainModel = (trainIds: ReadonlySet<number>): TrainModel => {
    const trainPhotos = photos.filter((photo) => trainIds.has(photo.id));
    const mu = meanVector(trainPhotos);
    const scatter = totalScatter(trainPhotos, mu);
    const factors = ALPHAS.map((alpha) => shrunkFactor(scatter, alpha));
    const mainFactor = factors[ALPHAS.indexOf(ALPHA_MAIN)]!;
    const shuffled = [...trainPhotos];
    shuffleInPlace(shuffled, mulberry32(1234));
    const sampleFactors = SCATTER_SAMPLE_SIZES.map((size) => {
        const sample = shuffled.slice(0, size);
        return shrunkFactor(totalScatter(sample, meanVector(sample)), ALPHA_MAIN);
    });

    const rivals = evalKits
        .filter((kit) => kit.source === "saved")
        .map((kit) => ({
            id: kit.id,
            tagsKey: comboKey(kit.tags),
            centroid: centroid(
                kit.memberIds.filter((id) => trainIds.has(id)),
                PRODUCTION_SEED_CAP,
            ),
        }))
        .filter((rival) => rival.centroid) as TrainModel["rivals"];
    const rivalSimilarity = new Float64Array(photos.length * rivals.length);
    for (const photo of photos) {
        rivals.forEach((rival, r) => {
            rivalSimilarity[photo.index * rivals.length + r] = dot(
                photo.vector,
                rival.centroid,
            );
        });
    }

    const tagDirections = allTags.map((tag) => {
        const positive = centroid(
            trainPhotos.filter((photo) => photo.tags.has(tag)).map((photo) => photo.id),
        );
        const negative = centroid(
            trainPhotos.filter((photo) => !photo.tags.has(tag)).map((photo) => photo.id),
        );
        return positive && negative ? difference(positive, negative) : undefined;
    });
    const tagRawMargin = new Float64Array(photos.length * allTags.length);
    for (const photo of photos) {
        tagDirections.forEach((direction, t) => {
            tagRawMargin[photo.index * allTags.length + t] =
                direction ? dot(photo.vector, direction) : 0;
        });
    }

    const tagLogOdds = LR_L2.map(() => new Float64Array(photos.length * allTags.length));
    const tagLogOddsSub = new Float64Array(photos.length * allTags.length);
    let whitenMs = 0;
    let lrMs = 0;
    if (!SKIP_LR) {
        const whitenStart = Date.now();
        const whitened = trainPhotos.map((photo) =>
            forwardSolve(mainFactor, difference(photo.vector, mu)));
        whitenMs = Date.now() - whitenStart;
        const lrStart = Date.now();
        const subsampleIndices = shuffled
            .slice(0, LR_SUBSAMPLE)
            .map((photo) => trainPhotos.indexOf(photo));
        const subsampleRows = subsampleIndices.map((i) => whitened[i]!);
        allTags.forEach((tag, t) => {
            const labels = Uint8Array.from(trainPhotos, (photo) =>
                photo.tags.has(tag) ? 1 : 0);
            const models = trainLogisticLadder(whitened, labels, mainFactor, mu);
            const subLabels = Uint8Array.from(subsampleIndices, (i) => labels[i]!);
            const subModel = trainLogisticLadder(subsampleRows, subLabels, mainFactor, mu)[
                LR_L2.indexOf(LR_MAIN_L2)
            ]!;
            for (const photo of photos) {
                const cell = photo.index * allTags.length + t;
                models.forEach((model, li) => {
                    tagLogOdds[li]![cell] = dot(photo.vector, model.weights) + model.offset;
                });
                tagLogOddsSub[cell] = dot(photo.vector, subModel.weights) + subModel.offset;
            }
        });
        lrMs = Date.now() - lrStart;
    }
    return {
        trainIds,
        trainPhotos,
        factors,
        sampleFactors,
        rivals,
        rivalSimilarity,
        tagDirections,
        tagRawMargin,
        tagLogOdds,
        tagLogOddsSub,
        timing: { scatterMs: scatter.ms, whitenMs, lrMs },
    };
};

const buildKitModel = (model: TrainModel, fold: Fold): KitModel | undefined => {
    const selected = centroid(fold.trainPositiveIds, PRODUCTION_SEED_CAP);
    const hard = centroid(
        model.trainPhotos
            .filter(
                (photo) =>
                    !hasAll(photo.tags, fold.kit.tags) &&
                    sharesAny(photo.tags, fold.kit.tags),
            )
            .map((photo) => photo.id),
    );
    const tagIndices = fold.kit.tags.map((tag) => tagIndex.get(tag)!);
    if (!selected || !hard || tagIndices.some((t) => !model.tagDirections[t])) {
        return undefined;
    }
    const hardRawDir = difference(selected, hard);
    const mainFactor = model.factors[ALPHAS.indexOf(ALPHA_MAIN)]!;
    const rivalIndices: number[] = [];
    const rivalWeights: number[] = [];
    model.rivals.forEach((rival, r) => {
        if (rival.id === fold.kit.id || rival.tagsKey === comboKey(fold.kit.tags)) {
            return;
        }
        const distance = 1 - dot(selected, rival.centroid);
        rivalIndices.push(r);
        rivalWeights.push(distance > 0 ? distance / (distance + PRODUCTION_TAU) : 0);
    });
    return {
        selected,
        hardRawDir,
        hardWDirs: model.factors.map((L) => choleskySolve(L, hardRawDir)),
        hardSampleWDirs: model.sampleFactors.map((L) => choleskySolve(L, hardRawDir)),
        hardUnitWDir: l2Normalize(choleskySolve(mainFactor, hardRawDir)),
        rivalIndices,
        rivalWeights,
        tagIndices,
    };
};

const termsOf = (model: TrainModel, kit: KitModel, photo: Photo): Float64Array => {
    const t = new Float64Array(COLUMNS.length);
    const x = photo.vector;
    const selectedSimilarity = dot(x, kit.selected);
    let steal = 0;
    const rivalRow = photo.index * model.rivals.length;
    for (let i = 0; i < kit.rivalIndices.length; i++) {
        const similarity = model.rivalSimilarity[rivalRow + kit.rivalIndices[i]!]!;
        steal = Math.max(
            steal,
            Math.max(0, similarity - selectedSimilarity) * kit.rivalWeights[i]!,
        );
    }
    t[C.prod] = selectedSimilarity - PRODUCTION_LAMBDA * steal;
    t[C.plain] = selectedSimilarity;
    t[C.hardRaw] = dot(x, kit.hardRawDir);
    ALPHAS.forEach((alpha, i) => {
        t[C.hardW(alpha)] = dot(x, kit.hardWDirs[i]!);
    });
    SCATTER_SAMPLE_SIZES.forEach((size, i) => {
        t[C.hardSample(size)] = dot(x, kit.hardSampleWDirs[i]!);
    });
    t[C.hardUnitW] = dot(x, kit.hardUnitWDir);
    const tagRow = photo.index * allTags.length;
    let tagRaw = Number.POSITIVE_INFINITY;
    let subMin = Number.POSITIVE_INFINITY;
    const lrMin = LR_L2.map(() => Number.POSITIVE_INFINITY);
    const lrSum = LR_L2.map(() => 0);
    for (const tagIdx of kit.tagIndices) {
        tagRaw = Math.min(tagRaw, model.tagRawMargin[tagRow + tagIdx]!);
        subMin = Math.min(subMin, model.tagLogOddsSub[tagRow + tagIdx]!);
        LR_L2.forEach((_, li) => {
            const value = model.tagLogOdds[li]![tagRow + tagIdx]!;
            lrMin[li] = Math.min(lrMin[li]!, value);
            lrSum[li]! += value;
        });
    }
    t[C.tagRaw] = tagRaw;
    t[C.tagLRsubMin] = subMin;
    LR_L2.forEach((l2, li) => {
        t[C.tagLRmin(l2)] = lrMin[li]!;
        t[C.tagLRsum(l2)] = lrSum[li]!;
    });
    return t;
};

/** Column-wise std over rows (0 → 1 so division is safe). */
const sigmaOf = (rows: readonly Float64Array[]): Float64Array => {
    const sums = new Float64Array(COLUMNS.length);
    const squares = new Float64Array(COLUMNS.length);
    for (const row of rows) {
        for (let c = 0; c < COLUMNS.length; c++) {
            sums[c]! += row[c]!;
            squares[c]! += row[c]! * row[c]!;
        }
    }
    return sums.map((sum, c) => {
        const m = sum / rows.length;
        return Math.sqrt(Math.max(0, squares[c]! / rows.length - m * m)) || 1;
    });
};

const buildFoldFeatures = (
    model: TrainModel,
    evalIds: ReadonlySet<number>,
): FoldFeatures[] => {
    const features: FoldFeatures[] = [];
    for (const fold of buildFolds(model.trainIds, evalIds)) {
        const kit = buildKitModel(model, fold);
        if (!kit) {
            continue;
        }
        const sigma = sigmaOf(
            model.trainPhotos.map((photo) => termsOf(model, kit, photo)),
        );
        const labelled: [number[], Label][] = [
            [fold.testPositiveIds, 0],
            [fold.testHardNegativeIds, 1],
            [fold.testEasyNegativeIds, 2],
        ];
        const rows: Float64Array[] = [];
        const labels: number[] = [];
        for (const [ids, label] of labelled) {
            for (const id of ids) {
                rows.push(termsOf(model, kit, photoById.get(id)!));
                labels.push(label);
            }
        }
        features.push({ fold, labels: Uint8Array.from(labels), rows, sigma });
    }
    return features;
};

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

const mixScorer = (alpha: number, hardWeight: number, tagWeight: number): Scorer => {
    const hardColumn = C.hardW(alpha);
    return {
        name: `mix a${alpha} h${hardWeight} t${tagWeight}`,
        score: (t, s) =>
            t[C.prod]! / s[C.prod]! +
            (hardWeight * t[hardColumn]!) / s[hardColumn]! +
            (tagWeight * t[C.tagRaw]!) / s[C.tagRaw]!,
    };
};

const tagLRScorer = (
    kind: "min" | "sum",
    l2: number,
    hardWeight: number,
    tagWeight: number,
): Scorer => {
    const hardColumn = C.hardW(ALPHA_MAIN);
    const tagColumn = kind === "min" ? C.tagLRmin(l2) : C.tagLRsum(l2);
    return {
        name: `tagLR${kind} l2=${l2} h${hardWeight} t${tagWeight}`,
        score: (t, s) =>
            t[C.prod]! / s[C.prod]! +
            (hardWeight * t[hardColumn]!) / s[hardColumn]! +
            (tagWeight * t[tagColumn]!) / s[tagColumn]!,
    };
};

const buildScorers = (): Scorer[] => {
    const scorers: Scorer[] = [
        { name: "production", score: (t) => t[C.prod]! },
        {
            name: "pass4 8/8",
            score: (t) =>
                t[C.prod]! +
                PASS4_HARD_WEIGHT * t[C.hardRaw]! +
                PASS4_TAG_WEIGHT * t[C.tagRaw]!,
        },
    ];
    for (const alpha of ALPHAS) {
        for (const hardWeight of HARD_WEIGHTS) {
            for (const tagWeight of TAG_WEIGHTS) {
                scorers.push(mixScorer(alpha, hardWeight, tagWeight));
            }
        }
    }
    if (!SKIP_LR) {
        for (const kind of ["min", "sum"] as const) {
            for (const l2 of LR_L2) {
                for (const hardWeight of HARD_WEIGHTS) {
                    for (const tagWeight of TAG_WEIGHTS) {
                        scorers.push(tagLRScorer(kind, l2, hardWeight, tagWeight));
                    }
                }
            }
        }
        for (const hardWeight of [0, 0.5, 1]) {
            for (const tagWeight of [2, 3, 4]) {
                scorers.push({
                    name: `tagLRsub${LR_SUBSAMPLE} h${hardWeight} t${tagWeight}`,
                    score: (t, s) =>
                        t[C.prod]! / s[C.prod]! +
                        (hardWeight * t[C.hardW(ALPHA_MAIN)]!) / s[C.hardW(ALPHA_MAIN)]! +
                        (tagWeight * t[C.tagLRsubMin]!) / s[C.tagLRsubMin]!,
                });
            }
        }
        // Ablations: is the rival steal still needed? Is the centroid needed at all?
        const tagColumn = C.tagLRmin(LR_MAIN_L2);
        for (const hardWeight of [0, 0.5, 1]) {
            for (const tagWeight of [2, 3, 4]) {
                scorers.push({
                    name: `noSteal l2=${LR_MAIN_L2} h${hardWeight} t${tagWeight}`,
                    score: (t, s) =>
                        t[C.plain]! / s[C.plain]! +
                        (hardWeight * t[C.hardW(ALPHA_MAIN)]!) / s[C.hardW(ALPHA_MAIN)]! +
                        (tagWeight * t[tagColumn]!) / s[tagColumn]!,
                });
            }
        }
        scorers.push({ name: `tagLRmin-only l2=${LR_MAIN_L2}`, score: (t) => t[tagColumn]! });
        for (const hardWeight of [0.5, 1]) {
            scorers.push({
                name: `tagLRmin+hardW-only l2=${LR_MAIN_L2} h${hardWeight}`,
                score: (t, s) =>
                    (hardWeight * t[C.hardW(ALPHA_MAIN)]!) / s[C.hardW(ALPHA_MAIN)]! +
                    t[tagColumn]! / s[tagColumn]!,
            });
        }
    }
    for (const size of SCATTER_SAMPLE_SIZES) {
        for (const [hardWeight, tagWeight] of [[2, 1.5], [1, 1]] as const) {
            scorers.push({
                name: `sample${size} h${hardWeight} t${tagWeight}`,
                score: (t, s) =>
                    t[C.prod]! / s[C.prod]! +
                    (hardWeight * t[C.hardSample(size)]!) / s[C.hardSample(size)]! +
                    (tagWeight * t[C.tagRaw]!) / s[C.tagRaw]!,
            });
        }
    }
    for (const [hardWeight, tagWeight] of [[8, 8], [4, 4]] as const) {
        scorers.push({
            name: `fixed unitW h${hardWeight} tagRaw${tagWeight}`,
            score: (t) =>
                t[C.prod]! + hardWeight * t[C.hardUnitW]! + tagWeight * t[C.tagRaw]!,
        });
    }
    return scorers;
};

// ---------------------------------------------------------------------------
// Metrics (same definitions as pass 4; one stable sort per evaluation)
// ---------------------------------------------------------------------------

const metricsOf = (labels: Uint8Array, scores: Float64Array): Metrics => {
    const n = labels.length;
    const order = Array.from({ length: n }, (_, i) => i).sort(
        (a, b) => scores[b]! - scores[a]! || a - b,
    );
    let positives = 0;
    let hard = 0;
    let easy = 0;
    for (let i = 0; i < n; i++) {
        if (labels[i] === 0) {
            positives += 1;
        } else if (labels[i] === 1) {
            hard += 1;
        } else {
            easy += 1;
        }
    }
    // AUC via descending traversal with tie groups.
    let hardWins = 0;
    let easyWins = 0;
    let hardSeen = 0;
    let easySeen = 0;
    let i = 0;
    while (i < n) {
        let j = i;
        let groupPositives = 0;
        let groupHard = 0;
        let groupEasy = 0;
        while (j < n && scores[order[j]!] === scores[order[i]!]) {
            const label = labels[order[j]!];
            if (label === 0) {
                groupPositives += 1;
            } else if (label === 1) {
                groupHard += 1;
            } else {
                groupEasy += 1;
            }
            j += 1;
        }
        hardWins += groupPositives * (hard - hardSeen - groupHard + 0.5 * groupHard);
        easyWins += groupPositives * (easy - easySeen - groupEasy + 0.5 * groupEasy);
        hardSeen += groupHard;
        easySeen += groupEasy;
        i = j;
    }
    // Average precision and first-screen hit rates on the ranked order.
    let hits = 0;
    let fullPrecisionSum = 0;
    let hardRank = 0;
    let hardHits = 0;
    let hardPrecisionSum = 0;
    const requested = Math.min(12, positives);
    let fullTopHits = 0;
    let hardTopHits = 0;
    for (let k = 0; k < n; k++) {
        const label = labels[order[k]!];
        if (label !== 2) {
            hardRank += 1;
        }
        if (label === 0) {
            hits += 1;
            fullPrecisionSum += hits / (k + 1);
            hardHits += 1;
            hardPrecisionSum += hardHits / hardRank;
            if (k < requested) {
                fullTopHits += 1;
            }
            if (hardRank <= requested) {
                hardTopHits += 1;
            }
        }
    }
    return {
        hardAuc: positives && hard ? hardWins / (positives * hard) : 0.5,
        easyAuc: positives && easy ? easyWins / (positives * easy) : 0.5,
        hardAveragePrecision: positives ? hardPrecisionSum / positives : 0,
        fullAveragePrecision: positives ? fullPrecisionSum / positives : 0,
        hardTop12: requested ? hardTopHits / requested : 0,
        fullTop12: requested ? fullTopHits / requested : 0,
    };
};

const averageMetrics = (list: readonly Metrics[]): Metrics => ({
    hardAuc: mean(list.map((m) => m.hardAuc)),
    easyAuc: mean(list.map((m) => m.easyAuc)),
    hardAveragePrecision: mean(list.map((m) => m.hardAveragePrecision)),
    fullAveragePrecision: mean(list.map((m) => m.fullAveragePrecision)),
    hardTop12: mean(list.map((m) => m.hardTop12)),
    fullTop12: mean(list.map((m) => m.fullTop12)),
});

const objective = (m: Metrics): number =>
    0.5 * m.hardAuc + 0.3 * m.hardAveragePrecision + 0.2 * m.hardTop12;

const firstScreenObjective = (m: Metrics): number =>
    0.4 * m.hardAuc + 0.2 * m.hardAveragePrecision + 0.4 * m.hardTop12;

const fmt = (m: Metrics): string =>
    `hard=${(m.hardAuc * 100).toFixed(1)} hardAP=${(m.hardAveragePrecision * 100).toFixed(1)} hard@12=${(m.hardTop12 * 100).toFixed(1)} fullAP=${(m.fullAveragePrecision * 100).toFixed(1)} full@12=${(m.fullTop12 * 100).toFixed(1)} easy=${(m.easyAuc * 100).toFixed(1)}`;

const evaluateMethod = (
    features: readonly FoldFeatures[],
    scorer: Scorer,
): MethodResult => {
    const byKit = new Map<string, Metrics>();
    for (const f of features) {
        const scores = new Float64Array(f.rows.length);
        for (let i = 0; i < f.rows.length; i++) {
            scores[i] = scorer.score(f.rows[i]!, f.sigma);
        }
        byKit.set(f.fold.kit.id, metricsOf(f.labels, scores));
    }
    const saved = features
        .filter((f) => f.fold.kit.source === "saved")
        .map((f) => byKit.get(f.fold.kit.id)!);
    return {
        all: averageMetrics([...byKit.values()]),
        saved: averageMetrics(saved),
        byKit,
    };
};

const bootstrapInterval = (values: readonly number[]): [number, number] => {
    const random = mulberry32(7);
    const samples: number[] = [];
    for (let i = 0; i < 4000; i++) {
        samples.push(
            mean(
                Array.from(
                    { length: values.length },
                    () => values[Math.floor(random() * values.length)]!,
                ),
            ),
        );
    }
    samples.sort((a, b) => a - b);
    return [
        samples[Math.floor(samples.length * 0.025)]!,
        samples[Math.floor(samples.length * 0.975)]!,
    ];
};

/** scorer name → kit id → per-seed metric values. */
type PerKitStore = Map<string, Map<string, number[]>>;

const pairedDelta = (
    store: PerKitStore,
    candidate: string,
    baseline: string,
): string => {
    const a = store.get(candidate)!;
    const b = store.get(baseline)!;
    const deltas = [...a.keys()]
        .filter((kit) => b.has(kit))
        .map((kit) => mean(a.get(kit)!) - mean(b.get(kit)!));
    const [low, high] = bootstrapInterval(deltas);
    return `Δ=${(mean(deltas) * 100).toFixed(2)}pp CI=[${(low * 100).toFixed(2)},${(high * 100).toFixed(2)}] +2pp=${deltas.filter((d) => d >= 0.02).length} -2pp=${deltas.filter((d) => d <= -0.02).length}`;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();
const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const scorers = buildScorers();
const byName = new Map(scorers.map((s) => [s.name, s]));
const isBaseline = (name: string): boolean =>
    name === "production" || name === "pass4 8/8";

console.log(
    `pass5 photos=${photos.length} tags=${allTags.length} kits=${evalKits.length} dupThreshold=${DUPLICATE_HAMMING_THRESHOLD} dupGroups=${duplicateGroups.length} scorers=${scorers.length} skipLR=${SKIP_LR}`,
);

const [devTrain, devTest] = splitByGroups(DEVELOPMENT_SEED, [TRAIN_FRACTION, 1 - TRAIN_FRACTION]);
const devModel = buildTrainModel(devTrain!);
const devFeatures = buildFoldFeatures(devModel, devTest!);
console.log(
    `development train=${devTrain!.size} test=${devTest!.size} folds=${devFeatures.length} saved=${devFeatures.filter((f) => f.fold.kit.source === "saved").length} (${elapsed()})`,
);
console.log(
    `timing: scatter n=${devModel.trainPhotos.length} ${devModel.timing.scatterMs}ms · whiten ${devModel.timing.whitenMs}ms · per-tag LR ladder ×${allTags.length} (+subsample) ${devModel.timing.lrMs}ms`,
);

type Ranked = { scorer: Scorer; result: MethodResult };
const devResults: Ranked[] = scorers.map((scorer) => ({
    scorer,
    result: evaluateMethod(devFeatures, scorer),
}));
const bySavedObjective = [...devResults].sort(
    (a, b) => objective(b.result.saved) - objective(a.result.saved),
);
const family = (prefix: string): Ranked[] =>
    bySavedObjective.filter((r) => r.scorer.name.startsWith(prefix));
const printRows = (title: string, rows: readonly Ranked[]): void => {
    console.log(`\n${title}`);
    for (const { scorer, result } of rows) {
        console.log(
            `  ${scorer.name.padEnd(32)} ${fmt(result.saved)} obj=${(objective(result.saved) * 100).toFixed(1)} | all hard=${(result.all.hardAuc * 100).toFixed(1)} hard@12=${(result.all.hardTop12 * 100).toFixed(1)}`,
        );
    }
};
printRows("=== development (seed 42), saved kits, references ===", devResults.filter((r) => isBaseline(r.scorer.name)));
printRows("=== development top 12 by objective ===", bySavedObjective.slice(0, 12));
printRows("=== best mix per α ===", ALPHAS.map((alpha) => family(`mix a${alpha} `)[0]!));
if (!SKIP_LR) {
    for (const kind of ["min", "sum"] as const) {
        printRows(`=== tagLR ${kind}: best per L2 ===`, LR_L2.map((l2) => family(`tagLR${kind} l2=${l2} `)[0]!));
    }
    printRows(`=== tagLR trained on ${LR_SUBSAMPLE}-photo subsample ===`, family("tagLRsub"));
    printRows("=== ablations: no rival steal / LR only ===", [...family("noSteal"), ...family("tagLRmin-only"), ...family("tagLRmin+hardW-only")]);
}
printRows("=== sampled scatter ===", family("sample"));
printRows("=== fixed weights, unit whitened direction ===", family("fixed"));

const heatmap = (title: string, name: (h: number, t: number) => string): void => {
    console.log(`\n=== ${title}: hard AUC (hard@12) saved kits, rows=hard weight, cols=tag weight ===`);
    console.log(`        ${TAG_WEIGHTS.map((t) => `t${t}`.padStart(13)).join("")}`);
    for (const hardWeight of HARD_WEIGHTS) {
        const cells = TAG_WEIGHTS.map((tagWeight) => {
            const found = devResults.find((d) => d.scorer.name === name(hardWeight, tagWeight));
            if (!found) {
                return "-".padStart(13);
            }
            const r = found.result.saved;
            return `${(r.hardAuc * 100).toFixed(1)} (${(r.hardTop12 * 100).toFixed(1)})`.padStart(13);
        });
        console.log(`  h${String(hardWeight).padEnd(4)} ${cells.join("")}`);
    }
};
heatmap(`mix α=${ALPHA_MAIN}`, (h, t) => `mix a${ALPHA_MAIN} h${h} t${t}`);
if (!SKIP_LR) {
    heatmap(`tagLRmin l2=${LR_MAIN_L2}`, (h, t) => `tagLRmin l2=${LR_MAIN_L2} h${h} t${t}`);
    heatmap(`tagLRsum l2=${LR_MAIN_L2}`, (h, t) => `tagLRsum l2=${LR_MAIN_L2} h${h} t${t}`);
}

// Fixed picks for confirmation.
const candidates = bySavedObjective.filter((r) => !isBaseline(r.scorer.name));
const best = candidates[0]!;
const bestFirstScreen = [...candidates].sort(
    (a, b) => firstScreenObjective(b.result.saved) - firstScreenObjective(a.result.saved),
)[0]!;
const picks = [
    ...new Set<Scorer>([
        byName.get("production")!,
        byName.get("pass4 8/8")!,
        best.scorer,
        bestFirstScreen.scorer,
        family(`mix a${ALPHA_MAIN} `)[0]!.scorer,
        ...(SKIP_LR ?
            [] :
            [
                ...LR_L2.map((l2) => family(`tagLRmin l2=${l2} `)[0]!.scorer),
                family(`tagLRsum l2=${LR_MAIN_L2} `)[0]!.scorer,
                family("tagLRsub")[0]!.scorer,
                family("noSteal")[0]!.scorer,
                byName.get(`tagLRmin l2=${LR_MAIN_L2} h0 t3`)!,
                family("tagLRmin+hardW-only")[0]!.scorer,
            ]),
        family("sample2000")[0]!.scorer,
        family("fixed")[0]!.scorer,
    ]),
];
console.log(`\npicks: best=${best.scorer.name} · first-screen=${bestFirstScreen.scorer.name}`);

// Per-kit weight tune within the best scorer's family (same prefix up to " h").
const tuneFamilyPrefix = best.scorer.name.slice(0, best.scorer.name.indexOf(" h") + 1);
const tuneCells = devResults.filter((r) => r.scorer.name.startsWith(tuneFamilyPrefix));
const perKitPick = new Map<string, Scorer>();
for (const f of devFeatures) {
    if (f.fold.kit.source !== "saved") {
        continue;
    }
    const bestCell = [...tuneCells].sort(
        (a, b) =>
            objective(b.result.byKit.get(f.fold.kit.id)!) -
            objective(a.result.byKit.get(f.fold.kit.id)!),
    )[0]!;
    perKitPick.set(f.fold.kit.id, bestCell.scorer);
}
const PER_KIT_NAME = `per-kit tuned (${tuneFamilyPrefix.trim()})`;

// Confirmation.
const hardStore: PerKitStore = new Map();
const topStore: PerKitStore = new Map();
const savedMeans = new Map<string, Metrics[]>();
const allMeans = new Map<string, Metrics[]>();
const record = (name: string, features: FoldFeatures[], result: MethodResult): void => {
    savedMeans.set(name, [...(savedMeans.get(name) ?? []), result.saved]);
    allMeans.set(name, [...(allMeans.get(name) ?? []), result.all]);
    for (const f of features) {
        if (f.fold.kit.source !== "saved") {
            continue;
        }
        const m = result.byKit.get(f.fold.kit.id)!;
        for (const [store, value] of [[hardStore, m.hardAuc], [topStore, m.hardTop12]] as const) {
            const byKit = store.get(name) ?? new Map<string, number[]>();
            byKit.set(f.fold.kit.id, [...(byKit.get(f.fold.kit.id) ?? []), value]);
            store.set(name, byKit);
        }
    }
};
for (const seed of CONFIRMATION_SEEDS) {
    const [train, test] = splitByGroups(seed, [TRAIN_FRACTION, 1 - TRAIN_FRACTION]);
    const features = buildFoldFeatures(buildTrainModel(train!), test!);
    for (const scorer of picks) {
        record(scorer.name, features, evaluateMethod(features, scorer));
    }
    const byKit = new Map<string, Metrics>();
    for (const f of features) {
        const scorer = perKitPick.get(f.fold.kit.id) ?? best.scorer;
        byKit.set(f.fold.kit.id, evaluateMethod([f], scorer).byKit.get(f.fold.kit.id)!);
    }
    const savedKits = features
        .filter((f) => f.fold.kit.source === "saved")
        .map((f) => byKit.get(f.fold.kit.id)!);
    record(PER_KIT_NAME, features, {
        all: averageMetrics([...byKit.values()]),
        saved: averageMetrics(savedKits),
        byKit,
    });
    console.log(`confirmation seed ${seed} folds=${features.length} (${elapsed()})`);
}
console.log("\n=== confirmation mean over seeds 99/123/2024/7 — saved kits ===");
for (const name of savedMeans.keys()) {
    console.log(`  ${name.padEnd(36)} ${fmt(averageMetrics(savedMeans.get(name)!))}`);
}
console.log("\n=== confirmation mean — all AND kits ===");
for (const name of allMeans.keys()) {
    console.log(`  ${name.padEnd(36)} ${fmt(averageMetrics(allMeans.get(name)!))}`);
}
console.log("\n=== paired deltas vs pass4 8/8 (saved kits, per-kit seed-averaged) ===");
for (const name of savedMeans.keys()) {
    if (name === "pass4 8/8") {
        continue;
    }
    console.log(`  ${name.padEnd(36)} hardAUC ${pairedDelta(hardStore, name, "pass4 8/8")} | hard@12 ${pairedDelta(topStore, name, "pass4 8/8")}`);
}
console.log(`  ${PER_KIT_NAME} vs ${best.scorer.name}: hardAUC ${pairedDelta(hardStore, PER_KIT_NAME, best.scorer.name)} | hard@12 ${pairedDelta(topStore, PER_KIT_NAME, best.scorer.name)}`);

// Reserved three-way split: validation picks one cell, test reports.
const [reservedTrain, reservedValidation, reservedTest] = splitByGroups(RESERVED_SEED, [0.6, 0.2, 0.2]);
const reservedModel = buildTrainModel(reservedTrain!);
const validationFeatures = buildFoldFeatures(reservedModel, reservedValidation!);
const testFeatures = buildFoldFeatures(reservedModel, reservedTest!);
const validationCells = scorers.filter(
    (s) => s.name.startsWith("mix ") || s.name.startsWith("tagLRmin ") || s.name.startsWith("tagLRsum "),
);
const validationBest = validationCells
    .map((scorer) => ({ scorer, result: evaluateMethod(validationFeatures, scorer) }))
    .sort((a, b) => objective(b.result.saved) - objective(a.result.saved))[0]!;
console.log(`\n=== reserved split seed ${RESERVED_SEED}: train=${reservedTrain!.size} validation=${reservedValidation!.size} test=${reservedTest!.size} validationFolds=${validationFeatures.length} testFolds=${testFeatures.length} ===`);
console.log(`  validation picked: ${validationBest.scorer.name}`);
const reservedHard: PerKitStore = new Map();
const reservedTop: PerKitStore = new Map();
const reservedScorers = [...new Set([byName.get("production")!, byName.get("pass4 8/8")!, validationBest.scorer, best.scorer, family(`mix a${ALPHA_MAIN} `)[0]!.scorer])];
for (const scorer of reservedScorers) {
    const result = evaluateMethod(testFeatures, scorer);
    console.log(`  test ${scorer.name.padEnd(32)} saved ${fmt(result.saved)} | all hard=${(result.all.hardAuc * 100).toFixed(1)} hard@12=${(result.all.hardTop12 * 100).toFixed(1)}`);
    for (const [store, read] of [[reservedHard, (m: Metrics) => m.hardAuc], [reservedTop, (m: Metrics) => m.hardTop12]] as const) {
        const byKit = new Map<string, number[]>();
        for (const f of testFeatures) {
            if (f.fold.kit.source === "saved") {
                byKit.set(f.fold.kit.id, [read(result.byKit.get(f.fold.kit.id)!)]);
            }
        }
        store.set(scorer.name, byKit);
    }
}
for (const scorer of reservedScorers.slice(2)) {
    console.log(`  test Δ ${scorer.name} vs pass4 8/8: hardAUC ${pairedDelta(reservedHard, scorer.name, "pass4 8/8")} | hard@12 ${pairedDelta(reservedTop, scorer.name, "pass4 8/8")}`);
}
console.log(`  test Δ ${validationBest.scorer.name} vs production: hardAUC ${pairedDelta(reservedHard, validationBest.scorer.name, "production")} | hard@12 ${pairedDelta(reservedTop, validationBest.scorer.name, "production")}`);
console.log(`\ntotal ${elapsed()}`);
