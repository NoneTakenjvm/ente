/**
 * Pass 6: tile embeddings (`thirds-v1` grid) as an input to the per-tag
 * detectors of the pass-5 shipped scorer.
 *
 * Same leakage-free protocol as passes 4/5: global photo split, dHash
 * duplicate groups stay on one side, every evaluated photo is absent from
 * every prototype and every trained detector. The centroid, rival steal and
 * whitened hard-negative margin stay on the global vector; only the tag term
 * changes:
 *
 *   G        pass-5 shipped — logistic on whitened global vectors
 *   T0       G applied to each tile, pooled (max / mean); `gmax` = max(G, tile max)
 *   T1       MIL logistic trained on whitened tile vectors from zero, max
 *            pooling (the argmax tile carries the gradient)
 *   T1w      MIL warm-started from G, top-3 mean pooling while training,
 *            200 steps; max-pooled at inference
 *   T2       naive instance training (every tile inherits the photo label),
 *            max-pooled at inference — development seed only
 *   M / X    logistic on one derived 512-d view per photo: the L2-normalised
 *            mean / per-dimension max of its tile embeddings
 *   M4       as M but over the four corner tiles only (a 4-tile scan)
 *   GM / GX / GM4  logistic on [whitened global ; whitened view] (1024-d)
 *   hybrid   per tag, G or T1w whichever has the higher training-set AUC
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass6.ts
 *
 * Env: PASS6_DEV_ONLY=1 skips confirmation seeds and the reserved split.
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    runStage1ClusteringSync,
    type Stage1Item,
} from "../src/lib/similarity-stage1-core";

const CORPUS_PATH = "C:/Users/Elliot/Downloads/kit-nearness-corpus (3).json";
const SIDECAR_PATH = "C:/Users/Elliot/Downloads/kit-nearness-corpus-tiles.f32";
const EXPECTED_LAYOUT = "thirds-v1";

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
const DUPLICATE_HAMMING_THRESHOLD = 6;
const DEVELOPMENT_SEED = 42;
const CONFIRMATION_SEEDS = [99, 123, 2024, 7] as const;
const RESERVED_SEED = 314159;
const DEV_ONLY = process.env.PASS6_DEV_ONLY === "1";

/** Shipped pass-5 settings (`kit-nearness-margins.ts`). */
const SHRINKAGE = 1;
const LR_L2 = 0.01;
const LR_ITERATIONS = 100;
const LR_LEARNING_RATE = 0.1;
const SHIPPED_HARD_WEIGHT = 1.5;
const SHIPPED_TAG_WEIGHT = 4;
const HARD_WEIGHTS = [1, 1.5] as const;
const TAG_WEIGHTS = [3, 4, 6] as const;
/** Extra weight on an additive tile term next to the shipped global term. */
const DUAL_WEIGHTS = [1, 2, 4] as const;

type SourcePhoto = AnonymisedKitNearnessCorpus["photos"][number];

type Photo = {
    id: number;
    index: number;
    tags: ReadonlySet<string>;
    vector: Float64Array;
    hashes: string[];
    /** First row of this photo in `tileVectors`; `tileRows × tileColumns` follow. */
    tileStart: number;
    tileCount: number;
    tileRows: number;
    tileColumns: number;
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
// Term columns — one per tag-term variant, each a min over the kit's tags
// ---------------------------------------------------------------------------

const TAG_VARIANTS = [
    "G",
    "T0max",
    "T0mean",
    "T0gmax",
    "T1max",
    "T1gmax",
    "T1w",
    "T1wgmax",
    "T2max",
    "M",
    "X",
    "M4",
    "GM",
    "GX",
    "GM4",
    "hybrid",
] as const;
type TagVariant = (typeof TAG_VARIANTS)[number];
const TILE_VARIANTS = TAG_VARIANTS.filter((v) => v !== "G");
/** Variants shown in the per-tag detector table. */
const DETECTOR_TABLE: TagVariant[] = ["G", "T0max", "T0mean", "T1max", "T1w", "T2max", "M", "X", "M4", "GM", "GX", "GM4"];
/** Variants whose tile term is also tried additively next to the shipped G term. */
const DUAL_VARIANTS = ["T1max", "T1w", "GM"] as const;

const COLUMNS = ["prod", "hardW", ...TAG_VARIANTS] as const;
type Column = (typeof COLUMNS)[number];
const col = (name: Column): number => COLUMNS.indexOf(name);
const C = { prod: col("prod"), hardW: col("hardW") };
const tagCol = (variant: TagVariant): number => col(variant);

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

/** `weights · matrix[row]` for a flat row-major matrix (Float32 or Float64). */
const dotRow = (
    weights: Float64Array,
    matrix: Float32Array | Float64Array,
    row: number,
): number => {
    const offset = row * DIM;
    let result = 0;
    for (let i = 0; i < DIM; i++) {
        result += weights[i]! * matrix[offset + i]!;
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

/** AUC of `scores` for binary `labels` (1 positive), ties count half. */
const binaryAuc = (labels: Uint8Array, scores: Float64Array): number => {
    const order = Array.from({ length: labels.length }, (_, i) => i).sort(
        (a, b) => scores[b]! - scores[a]! || a - b,
    );
    let positives = 0;
    for (let i = 0; i < labels.length; i++) {
        positives += labels[i]!;
    }
    const negatives = labels.length - positives;
    if (!positives || !negatives) {
        return 0.5;
    }
    let wins = 0;
    let negativesSeen = 0;
    let i = 0;
    while (i < order.length) {
        let j = i;
        let groupPositives = 0;
        let groupNegatives = 0;
        while (j < order.length && scores[order[j]!] === scores[order[i]!]) {
            if (labels[order[j]!]) {
                groupPositives += 1;
            } else {
                groupNegatives += 1;
            }
            j += 1;
        }
        wins +=
            groupPositives * (negatives - negativesSeen - groupNegatives + 0.5 * groupNegatives);
        negativesSeen += groupNegatives;
        i = j;
    }
    return wins / (positives * negatives);
};

// ---------------------------------------------------------------------------
// Corpus (JSON + float32 tile sidecar), kits, duplicate groups, splits
// ---------------------------------------------------------------------------

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnonymisedKitNearnessCorpus & {
    tileRows?: number;
};
if (raw.tileLayout !== EXPECTED_LAYOUT || !raw.tileRows) {
    throw new Error(`corpus has no ${EXPECTED_LAYOUT} tiles`);
}
const sidecar = readFileSync(SIDECAR_PATH);
const tileVectors = new Float32Array(
    sidecar.buffer.slice(sidecar.byteOffset, sidecar.byteOffset + sidecar.byteLength),
);
if (tileVectors.length !== raw.tileRows * DIM) {
    throw new Error(`sidecar has ${tileVectors.length} floats, expected ${raw.tileRows * DIM}`);
}

const photos: Photo[] = [];
for (const source of raw.photos as SourcePhoto[]) {
    if (!source.embedding || source.embedding.length !== DIM || !source.tiles) {
        continue;
    }
    photos.push({
        id: source.id,
        index: photos.length,
        tags: new Set(source.tags),
        vector: l2Normalize(Float64Array.from(source.embedding)),
        hashes: source.hashes,
        tileStart: source.tiles.offset,
        tileCount: source.tiles.rows * source.tiles.columns,
        tileRows: source.tiles.rows,
        tileColumns: source.tiles.columns,
    });
}
const photoById = new Map(photos.map((photo) => [photo.id, photo]));
const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();
const tagIndex = new Map(allTags.map((tag, index) => [tag, index]));
const T = allTags.length;

/** Photos as one flat Float64 matrix so global rows share the tile code path. */
const globalMatrix = new Float64Array(photos.length * DIM);
/**
 * Derived 512-d views per photo: L2-normalised mean and per-dim max of all
 * its tiles, and the mean of its four corner tiles only (a 4-tile scan).
 */
const tileMeanMatrix = new Float64Array(photos.length * DIM);
const tileMaxMatrix = new Float64Array(photos.length * DIM);
const cornerMeanMatrix = new Float64Array(photos.length * DIM);
for (const photo of photos) {
    globalMatrix.set(photo.vector, photo.index * DIM);
    const sum = new Float64Array(DIM);
    const max = new Float64Array(DIM).fill(Number.NEGATIVE_INFINITY);
    const cornerSum = new Float64Array(DIM);
    const lastRow = photo.tileRows - 1;
    const lastColumn = photo.tileColumns - 1;
    for (let tile = 0; tile < photo.tileCount; tile++) {
        const row = Math.floor(tile / photo.tileColumns);
        const column = tile % photo.tileColumns;
        const isCorner = (row === 0 || row === lastRow) && (column === 0 || column === lastColumn);
        const offset = (photo.tileStart + tile) * DIM;
        for (let i = 0; i < DIM; i++) {
            const value = tileVectors[offset + i]!;
            sum[i]! += value;
            if (value > max[i]!) {
                max[i] = value;
            }
            if (isCorner) {
                cornerSum[i]! += value;
            }
        }
    }
    tileMeanMatrix.set(l2Normalize(sum), photo.index * DIM);
    tileMaxMatrix.set(l2Normalize(max), photo.index * DIM);
    cornerMeanMatrix.set(l2Normalize(cornerSum), photo.index * DIM);
}

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
    const clusters = runStage1ClusteringSync(hashedItems, DUPLICATE_HAMMING_THRESHOLD);
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

const splitByGroups = (seed: number, fractions: readonly number[]): Set<number>[] => {
    const groups = duplicateGroups.map((group) => [...group]);
    shuffleInPlace(groups, mulberry32(seed));
    const targets = fractions.map((fraction) => Math.floor(photos.length * fraction));
    const partitions = fractions.map(() => new Set<number>());
    for (const group of groups) {
        let index = partitions.findIndex(
            (partition, i) => i < partitions.length - 1 && partition.size < targets[i]!,
        );
        if (index < 0) {
            index = partitions.length - 1;
        }
        group.forEach((id) => partitions[index]!.add(id));
    }
    return partitions;
};

const buildFolds = (trainIds: ReadonlySet<number>, testIds: ReadonlySet<number>): Fold[] => {
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
            (sharesAny(photo.tags, kit.tags) ? testHardNegativeIds : testEasyNegativeIds).push(
                photo.id,
            );
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
// Linear algebra: shrunk total scatter, Cholesky, solves, whitening
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
                i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / lower[j * DIM + j]!;
        }
    }
    return lower;
};

/** Solve L y = b into `out` (forward substitution). */
const forwardSolveInto = (lower: Float64Array, rhs: Float64Array, out: Float64Array): void => {
    for (let i = 0; i < DIM; i++) {
        let sum = rhs[i]!;
        const row = i * DIM;
        for (let k = 0; k < i; k++) {
            sum -= lower[row + k]! * out[k]!;
        }
        out[i] = sum / lower[row + i]!;
    }
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
const choleskySolve = (lower: Float64Array, rhs: Float64Array): Float64Array => {
    const y = new Float64Array(DIM);
    forwardSolveInto(lower, rhs, y);
    return backwardSolve(lower, y);
};

/** Rows of a flat row-major matrix selected by index. */
type RowSource = { matrix: Float32Array | Float64Array; rows: number[] };

type Whitening = { mu: Float64Array; lower: Float64Array };

/** Mean and shrunk-covariance Cholesky factor of the selected rows. */
const whiteningOf = (source: RowSource): Whitening => {
    const { matrix, rows } = source;
    const mu = new Float64Array(DIM);
    for (const row of rows) {
        const offset = row * DIM;
        for (let i = 0; i < DIM; i++) {
            mu[i]! += matrix[offset + i]!;
        }
    }
    for (let i = 0; i < DIM; i++) {
        mu[i]! /= rows.length || 1;
    }
    const scatter = new Float64Array(DIM * DIM);
    const centred = new Float64Array(DIM);
    for (const row of rows) {
        const offset = row * DIM;
        for (let i = 0; i < DIM; i++) {
            centred[i] = matrix[offset + i]! - mu[i]!;
        }
        for (let i = 0; i < DIM; i++) {
            const xi = centred[i]!;
            const scatterRow = i * DIM;
            for (let j = i; j < DIM; j++) {
                scatter[scatterRow + j]! += xi * centred[j]!;
            }
        }
    }
    let trace = 0;
    for (let i = 0; i < DIM; i++) {
        for (let j = i; j < DIM; j++) {
            const value = scatter[i * DIM + j]! / (rows.length || 1);
            scatter[i * DIM + j] = value;
            scatter[j * DIM + i] = value;
        }
        trace += scatter[i * DIM + i]!;
    }
    const ridge = (SHRINKAGE * trace) / DIM;
    for (let i = 0; i < DIM; i++) {
        scatter[i * DIM + i]! += ridge;
    }
    return { mu, lower: cholesky(scatter) };
};

/** z = L⁻¹(x − μ) for every selected row, as one flat matrix. */
const whitenRows = (source: RowSource, whitening: Whitening): Float64Array => {
    const { matrix, rows } = source;
    const out = new Float64Array(rows.length * DIM);
    const centred = new Float64Array(DIM);
    const z = new Float64Array(DIM);
    rows.forEach((row, r) => {
        const offset = row * DIM;
        for (let i = 0; i < DIM; i++) {
            centred[i] = matrix[offset + i]! - whitening.mu[i]!;
        }
        forwardSolveInto(whitening.lower, centred, z);
        out.set(z, r * DIM);
    });
    return out;
};

// ---------------------------------------------------------------------------
// Logistic regression on whitened rows (Adam, class-balanced, L2) with
// optional multiple-instance pooling over bags of rows
// ---------------------------------------------------------------------------

/** Log-odds(x) = x·weights + offset in original coordinates. */
type LogisticModel = { weights: Float64Array; offset: number };

/** Logistic weights and bias in whitened coordinates (`width` entries). */
type WhitenedModel = { w: Float64Array; bias: number };

/** Consecutive whitened rows `[start, start + count)` sharing one label. */
type Bag = { start: number; count: number };

type TrainOptions = {
    /**
     * `max`: the bag's highest-scoring row is its logit and alone receives
     * the gradient. `top3`: mean of the three highest rows (gradient split
     * across them). `instance`: every row is scored with the bag's label.
     * Bags of one row make every pooling the shipped trainer.
     */
    pooling: "max" | "top3" | "instance";
    iterations: number;
    init?: WhitenedModel;
};

const trainLogistic = (
    z: Float64Array,
    width: number,
    bags: readonly Bag[],
    labels: Uint8Array,
    options: TrainOptions,
): WhitenedModel => {
    const { pooling } = options;
    let units = 0;
    let positiveUnits = 0;
    bags.forEach((bag, b) => {
        const size = pooling === "instance" ? bag.count : 1;
        units += size;
        positiveUnits += labels[b]! * size;
    });
    const positiveWeight = units / (2 * Math.max(positiveUnits, 1));
    const negativeWeight = units / (2 * Math.max(units - positiveUnits, 1));
    const w = options.init ? Float64Array.from(options.init.w) : new Float64Array(width);
    let bias = options.init?.bias ?? 0;
    const grad = new Float64Array(width);
    const m = new Float64Array(width + 1);
    const v = new Float64Array(width + 1);
    const logitOf = (row: number): number => {
        const offset = row * width;
        let result = 0;
        for (let d = 0; d < width; d++) {
            result += w[d]! * z[offset + d]!;
        }
        return result;
    };
    const accumulate = (row: number, g: number): void => {
        const offset = row * width;
        for (let d = 0; d < width; d++) {
            grad[d]! += g * z[offset + d]!;
        }
    };
    const logits: number[] = [];
    const order: number[] = [];
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
        grad.fill(0);
        let gradBias = 0;
        bags.forEach((bag, b) => {
            const label = labels[b]!;
            const classWeight = (label ? positiveWeight : negativeWeight) / units;
            if (pooling === "instance") {
                for (let row = bag.start; row < bag.start + bag.count; row++) {
                    const p = 1 / (1 + Math.exp(-(bias + logitOf(row))));
                    const g = classWeight * (p - label);
                    accumulate(row, g);
                    gradBias += g;
                }
                return;
            }
            logits.length = 0;
            order.length = 0;
            for (let row = bag.start; row < bag.start + bag.count; row++) {
                logits.push(logitOf(row));
                order.push(row);
            }
            const k = pooling === "max" ? 1 : Math.min(3, bag.count);
            order.sort((a, b) => logits[b - bag.start]! - logits[a - bag.start]!);
            let pooled = 0;
            for (let i = 0; i < k; i++) {
                pooled += logits[order[i]! - bag.start]!;
            }
            pooled /= k;
            const p = 1 / (1 + Math.exp(-(bias + pooled)));
            const g = classWeight * (p - label);
            for (let i = 0; i < k; i++) {
                accumulate(order[i]!, g / k);
            }
            gradBias += g;
        });
        const correction1 = 1 - 0.9 ** iteration;
        const correction2 = 1 - 0.999 ** iteration;
        for (let d = 0; d <= width; d++) {
            const g = d < width ? grad[d]! + LR_L2 * w[d]! : gradBias;
            m[d] = 0.9 * m[d]! + 0.1 * g;
            v[d] = 0.999 * v[d]! + 0.001 * g * g;
            const step =
                (LR_LEARNING_RATE * (m[d]! / correction1)) /
                (Math.sqrt(v[d]! / correction2) + 1e-8);
            if (d < width) {
                w[d]! -= step;
            } else {
                bias -= step;
            }
        }
    }
    return { w, bias };
};

/** Map a whitened 512-d model back to x-space: w_x = L⁻ᵀ w_z. */
const toRawModel = (model: WhitenedModel, whitening: Whitening): LogisticModel => {
    const weights = backwardSolve(whitening.lower, model.w);
    return { weights, offset: model.bias - dot(whitening.mu, weights) };
};

/** Express an x-space model in another whitening's coordinates: w_z = Lᵀ w_x. */
const toWhitenedModel = (model: LogisticModel, whitening: Whitening): WhitenedModel => {
    const w = new Float64Array(DIM);
    for (let i = 0; i < DIM; i++) {
        let sum = 0;
        for (let k = i; k < DIM; k++) {
            sum += whitening.lower[k * DIM + i]! * model.weights[k]!;
        }
        w[i] = sum;
    }
    return { w, bias: model.offset + dot(whitening.mu, model.weights) };
};

/** Concatenate two whitened matrices row-wise into one of width 2·DIM. */
const concatRows = (left: Float64Array, right: Float64Array, rows: number): Float64Array => {
    const out = new Float64Array(rows * 2 * DIM);
    for (let r = 0; r < rows; r++) {
        out.set(left.subarray(r * DIM, (r + 1) * DIM), r * 2 * DIM);
        out.set(right.subarray(r * DIM, (r + 1) * DIM), r * 2 * DIM + DIM);
    }
    return out;
};

/** A 1024-d model split into two x-space blocks (global, derived view). */
type BlockModel = { left: LogisticModel; right: LogisticModel };

const toRawBlocks = (model: WhitenedModel, left: Whitening, right: Whitening): BlockModel => {
    const leftRaw = toRawModel({ w: model.w.slice(0, DIM), bias: 0 }, left);
    const rightRaw = toRawModel({ w: model.w.slice(DIM), bias: 0 }, right);
    return {
        left: { weights: leftRaw.weights, offset: model.bias + leftRaw.offset + rightRaw.offset },
        right: { weights: rightRaw.weights, offset: 0 },
    };
};

// ---------------------------------------------------------------------------
// Train model (depends only on the training partition)
// ---------------------------------------------------------------------------

type TrainModel = {
    trainIds: ReadonlySet<number>;
    trainPhotos: Photo[];
    globalWhitening: Whitening;
    rivals: { id: string; tagsKey: string; centroid: Float64Array }[];
    /** photo index × rival index → cosine similarity. */
    rivalSimilarity: Float64Array;
    /** variant → photo index × tag index → per-tag log-odds (pooled). */
    tagScores: Map<TagVariant, Float64Array>;
    /** Tag index → variant chosen for `hybrid`. */
    hybridPick: ("G" | "T1w")[];
    /** Per-tag detector AUC on the training photos (variant → tag index). */
    trainDetectorAuc: Map<TagVariant, number[]>;
    /** Stage name → ms. */
    timing: Record<string, number>;
};

type KitModel = {
    selected: Float64Array;
    hardWDir: Float64Array;
    rivalIndices: number[];
    rivalWeights: number[];
    tagIndices: number[];
};

type Pooled = { max: number; mean: number };

const poolTiles = (model: LogisticModel, photo: Photo): Pooled => {
    let best = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let row = photo.tileStart; row < photo.tileStart + photo.tileCount; row++) {
        const value = dotRow(model.weights, tileVectors, row) + model.offset;
        sum += value;
        best = Math.max(best, value);
    }
    return { max: best, mean: sum / photo.tileCount };
};

const buildTrainModel = (
    trainIds: ReadonlySet<number>,
    includeInstance: boolean,
): TrainModel => {
    const trainPhotos = photos.filter((photo) => trainIds.has(photo.id));
    const trainRows = trainPhotos.map((photo) => photo.index);
    const cell = (photo: Photo, t: number): number => photo.index * T + t;
    const labelsFor = (tag: string): Uint8Array =>
        Uint8Array.from(trainPhotos, (photo) => (photo.tags.has(tag) ? 1 : 0));
    const timing: Record<string, number> = {};
    const timed = <R>(name: string, run: () => R): R => {
        const startedAt = Date.now();
        const result = run();
        timing[name] = Date.now() - startedAt;
        return result;
    };

    // One whitening per view: global, tile rows, tile mean, tile max.
    const globalWhitening = whiteningOf({ matrix: globalMatrix, rows: trainRows });
    const globalZ = whitenRows({ matrix: globalMatrix, rows: trainRows }, globalWhitening);
    const meanWhitening = whiteningOf({ matrix: tileMeanMatrix, rows: trainRows });
    const meanZ = whitenRows({ matrix: tileMeanMatrix, rows: trainRows }, meanWhitening);
    const maxWhitening = whiteningOf({ matrix: tileMaxMatrix, rows: trainRows });
    const maxZ = whitenRows({ matrix: tileMaxMatrix, rows: trainRows }, maxWhitening);
    const cornerWhitening = whiteningOf({ matrix: cornerMeanMatrix, rows: trainRows });
    const cornerZ = whitenRows({ matrix: cornerMeanMatrix, rows: trainRows }, cornerWhitening);
    const tileRows: number[] = [];
    const tileBags: Bag[] = [];
    for (const photo of trainPhotos) {
        tileBags.push({ start: tileRows.length, count: photo.tileCount });
        for (let row = photo.tileStart; row < photo.tileStart + photo.tileCount; row++) {
            tileRows.push(row);
        }
    }
    const tileWhitening = timed("tileWhiten", () =>
        whiteningOf({ matrix: tileVectors, rows: tileRows }),
    );
    const tileZ = timed("tileZ", () =>
        whitenRows({ matrix: tileVectors, rows: tileRows }, tileWhitening),
    );
    const singleBags: Bag[] = trainPhotos.map((_, i) => ({ start: i, count: 1 }));
    const shipped: TrainOptions = { pooling: "max", iterations: LR_ITERATIONS };

    // Per-view detectors.
    const globalModels = timed("G", () =>
        allTags.map((tag) =>
            toRawModel(trainLogistic(globalZ, DIM, singleBags, labelsFor(tag), shipped), globalWhitening),
        ),
    );
    const milModels = timed("T1", () =>
        allTags.map((tag) =>
            toRawModel(trainLogistic(tileZ, DIM, tileBags, labelsFor(tag), shipped), tileWhitening),
        ),
    );
    const warmModels = timed("T1w", () =>
        allTags.map((tag, t) =>
            toRawModel(
                trainLogistic(tileZ, DIM, tileBags, labelsFor(tag), {
                    pooling: "top3",
                    iterations: 2 * LR_ITERATIONS,
                    init: toWhitenedModel(globalModels[t]!, tileWhitening),
                }),
                tileWhitening,
            ),
        ),
    );
    const instanceModels = timed("T2", () =>
        includeInstance ?
            allTags.map((tag) =>
                toRawModel(
                    trainLogistic(tileZ, DIM, tileBags, labelsFor(tag), {
                        pooling: "instance",
                        iterations: LR_ITERATIONS,
                    }),
                    tileWhitening,
                ),
            ) :
            undefined,
    );
    const meanModels = timed("M", () =>
        allTags.map((tag) =>
            toRawModel(trainLogistic(meanZ, DIM, singleBags, labelsFor(tag), shipped), meanWhitening),
        ),
    );
    const maxModels = timed("X", () =>
        allTags.map((tag) =>
            toRawModel(trainLogistic(maxZ, DIM, singleBags, labelsFor(tag), shipped), maxWhitening),
        ),
    );
    const globalMeanZ = concatRows(globalZ, meanZ, trainPhotos.length);
    const globalMeanModels = timed("GM", () =>
        allTags.map((tag) =>
            toRawBlocks(
                trainLogistic(globalMeanZ, 2 * DIM, singleBags, labelsFor(tag), shipped),
                globalWhitening,
                meanWhitening,
            ),
        ),
    );
    const globalMaxZ = concatRows(globalZ, maxZ, trainPhotos.length);
    const globalMaxModels = timed("GX", () =>
        allTags.map((tag) =>
            toRawBlocks(
                trainLogistic(globalMaxZ, 2 * DIM, singleBags, labelsFor(tag), shipped),
                globalWhitening,
                maxWhitening,
            ),
        ),
    );
    const cornerModels = timed("M4", () =>
        allTags.map((tag) =>
            toRawModel(trainLogistic(cornerZ, DIM, singleBags, labelsFor(tag), shipped), cornerWhitening),
        ),
    );
    const globalCornerZ = concatRows(globalZ, cornerZ, trainPhotos.length);
    const globalCornerModels = timed("GM4", () =>
        allTags.map((tag) =>
            toRawBlocks(
                trainLogistic(globalCornerZ, 2 * DIM, singleBags, labelsFor(tag), shipped),
                globalWhitening,
                cornerWhitening,
            ),
        ),
    );

    // Per-tag scores for every photo under every variant.
    const tagScores = new Map<TagVariant, Float64Array>(
        TAG_VARIANTS.map((variant) => [variant, new Float64Array(photos.length * T)]),
    );
    const score = (variant: TagVariant): Float64Array => tagScores.get(variant)!;
    const viewScore = (model: LogisticModel, matrix: Float64Array, photo: Photo): number =>
        dotRow(model.weights, matrix, photo.index) + model.offset;
    const blockScore = (model: BlockModel, right: Float64Array, photo: Photo): number =>
        viewScore(model.left, globalMatrix, photo) + viewScore(model.right, right, photo);
    for (const photo of photos) {
        allTags.forEach((_, t) => {
            const g = viewScore(globalModels[t]!, globalMatrix, photo);
            const t0 = poolTiles(globalModels[t]!, photo);
            const t1 = poolTiles(milModels[t]!, photo).max;
            const t1w = poolTiles(warmModels[t]!, photo).max;
            const c = cell(photo, t);
            score("G")[c] = g;
            score("T0max")[c] = t0.max;
            score("T0mean")[c] = t0.mean;
            score("T0gmax")[c] = Math.max(g, t0.max);
            score("T1max")[c] = t1;
            score("T1gmax")[c] = Math.max(g, t1);
            score("T1w")[c] = t1w;
            score("T1wgmax")[c] = Math.max(g, t1w);
            score("T2max")[c] = instanceModels ? poolTiles(instanceModels[t]!, photo).max : g;
            score("M")[c] = viewScore(meanModels[t]!, tileMeanMatrix, photo);
            score("X")[c] = viewScore(maxModels[t]!, tileMaxMatrix, photo);
            score("GM")[c] = blockScore(globalMeanModels[t]!, tileMeanMatrix, photo);
            score("GX")[c] = blockScore(globalMaxModels[t]!, tileMaxMatrix, photo);
            score("M4")[c] = viewScore(cornerModels[t]!, cornerMeanMatrix, photo);
            score("GM4")[c] = blockScore(globalCornerModels[t]!, cornerMeanMatrix, photo);
        });
    }

    // Hybrid: per tag, G or T1w by training-set detector AUC.
    const trainDetectorAuc = new Map<TagVariant, number[]>();
    for (const variant of TAG_VARIANTS) {
        if (variant === "hybrid") {
            continue;
        }
        trainDetectorAuc.set(
            variant,
            allTags.map((tag, t) =>
                binaryAuc(
                    labelsFor(tag),
                    Float64Array.from(trainPhotos, (photo) => score(variant)[cell(photo, t)]!),
                ),
            ),
        );
    }
    const hybridPick = allTags.map((_, t) =>
        trainDetectorAuc.get("T1w")![t]! > trainDetectorAuc.get("G")![t]! ? "T1w" : "G",
    );
    for (const photo of photos) {
        allTags.forEach((_, t) => {
            const c = cell(photo, t);
            score("hybrid")[c] = score(hybridPick[t]!)[c]!;
        });
    }

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
            rivalSimilarity[photo.index * rivals.length + r] = dot(photo.vector, rival.centroid);
        });
    }

    return {
        trainIds,
        trainPhotos,
        globalWhitening,
        rivals,
        rivalSimilarity,
        tagScores,
        hybridPick,
        trainDetectorAuc,
        timing,
    };
};

const buildKitModel = (model: TrainModel, fold: Fold): KitModel | undefined => {
    const selected = centroid(fold.trainPositiveIds, PRODUCTION_SEED_CAP);
    const hard = centroid(
        model.trainPhotos
            .filter(
                (photo) =>
                    !hasAll(photo.tags, fold.kit.tags) && sharesAny(photo.tags, fold.kit.tags),
            )
            .map((photo) => photo.id),
    );
    if (!selected || !hard) {
        return undefined;
    }
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
        hardWDir: choleskySolve(model.globalWhitening.lower, difference(selected, hard)),
        rivalIndices,
        rivalWeights,
        tagIndices: fold.kit.tags.map((tag) => tagIndex.get(tag)!),
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
        steal = Math.max(steal, Math.max(0, similarity - selectedSimilarity) * kit.rivalWeights[i]!);
    }
    t[C.prod] = selectedSimilarity - PRODUCTION_LAMBDA * steal;
    t[C.hardW] = dot(x, kit.hardWDir);
    for (const variant of TAG_VARIANTS) {
        const scores = model.tagScores.get(variant)!;
        let weakest = Number.POSITIVE_INFINITY;
        for (const tagIdx of kit.tagIndices) {
            weakest = Math.min(weakest, scores[photo.index * T + tagIdx]!);
        }
        t[tagCol(variant)] = weakest;
    }
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

const buildFoldFeatures = (model: TrainModel, evalIds: ReadonlySet<number>): FoldFeatures[] => {
    const features: FoldFeatures[] = [];
    for (const fold of buildFolds(model.trainIds, evalIds)) {
        const kit = buildKitModel(model, fold);
        if (!kit) {
            continue;
        }
        const sigma = sigmaOf(model.trainPhotos.map((photo) => termsOf(model, kit, photo)));
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

const shippedScorer = (variant: TagVariant, hardWeight: number, tagWeight: number): Scorer => {
    const tagColumn = tagCol(variant);
    return {
        name: `${variant} h${hardWeight} t${tagWeight}`,
        score: (t, s) =>
            t[C.prod]! / s[C.prod]! +
            (hardWeight * t[C.hardW]!) / s[C.hardW]! +
            (tagWeight * t[tagColumn]!) / s[tagColumn]!,
    };
};

const PASS5_NAME = `G h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`;

const buildScorers = (): Scorer[] => {
    const scorers: Scorer[] = [
        { name: "production", score: (t) => t[C.prod]! },
        shippedScorer("G", SHIPPED_HARD_WEIGHT, SHIPPED_TAG_WEIGHT),
        { name: "G-only", score: (t) => t[tagCol("G")]! },
    ];
    for (const variant of TILE_VARIANTS) {
        for (const hardWeight of HARD_WEIGHTS) {
            for (const tagWeight of TAG_WEIGHTS) {
                scorers.push(shippedScorer(variant, hardWeight, tagWeight));
            }
        }
        scorers.push({ name: `${variant}-only`, score: (t) => t[tagCol(variant)]! });
    }
    // Additive: shipped scorer plus a weighted tile term.
    for (const variant of DUAL_VARIANTS) {
        for (const weight of DUAL_WEIGHTS) {
            const tagColumn = tagCol(variant);
            scorers.push({
                name: `dual ${variant} +${weight}`,
                score: (t, s) =>
                    t[C.prod]! / s[C.prod]! +
                    (SHIPPED_HARD_WEIGHT * t[C.hardW]!) / s[C.hardW]! +
                    (SHIPPED_TAG_WEIGHT * t[tagCol("G")]!) / s[tagCol("G")]! +
                    (weight * t[tagColumn]!) / s[tagColumn]!,
            });
        }
    }
    return scorers;
};

// ---------------------------------------------------------------------------
// Metrics (same definitions as passes 4/5)
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

const pct = (value: number): string => (value * 100).toFixed(1);

const fmt = (m: Metrics): string =>
    `hard=${pct(m.hardAuc)} hardAP=${pct(m.hardAveragePrecision)} hard@12=${pct(m.hardTop12)} fullAP=${pct(m.fullAveragePrecision)} full@12=${pct(m.fullTop12)} easy=${pct(m.easyAuc)}`;

const evaluateMethod = (features: readonly FoldFeatures[], scorer: Scorer): MethodResult => {
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
    return { all: averageMetrics([...byKit.values()]), saved: averageMetrics(saved), byKit };
};

const bootstrapInterval = (values: readonly number[]): [number, number] => {
    const random = mulberry32(7);
    const samples: number[] = [];
    for (let i = 0; i < 4000; i++) {
        samples.push(
            mean(
                Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!),
            ),
        );
    }
    samples.sort((a, b) => a - b);
    return [samples[Math.floor(samples.length * 0.025)]!, samples[Math.floor(samples.length * 0.975)]!];
};

/** scorer name → kit id → per-seed metric values. */
type PerKitStore = Map<string, Map<string, number[]>>;

const pairedDelta = (store: PerKitStore, candidate: string, baseline: string): string => {
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
const isReference = (name: string): boolean =>
    name === "production" || name === PASS5_NAME || name === "G-only";

const tilesPerPhoto = photos.reduce((total, photo) => total + photo.tileCount, 0) / photos.length;
console.log(
    `pass6 photos=${photos.length} tags=${T} kits=${evalKits.length} tileRows=${raw.tileRows} tiles/photo=${tilesPerPhoto.toFixed(1)} dupGroups=${duplicateGroups.length} scorers=${scorers.length}`,
);
console.log(
    `tag prevalence: ${allTags
        .map((tag) => `${tag}=${photos.filter((photo) => photo.tags.has(tag)).length}`)
        .join(" ")}`,
);

const [devTrain, devTest] = splitByGroups(DEVELOPMENT_SEED, [TRAIN_FRACTION, 1 - TRAIN_FRACTION]);
const devModel = buildTrainModel(devTrain!, true);
const devFeatures = buildFoldFeatures(devModel, devTest!);
console.log(
    `development train=${devTrain!.size} test=${devTest!.size} folds=${devFeatures.length} saved=${devFeatures.filter((f) => f.fold.kit.source === "saved").length} (${elapsed()})`,
);
console.log(
    `timing (ms, train tiles=${devModel.trainPhotos.reduce((n, p) => n + p.tileCount, 0)}): ${Object.entries(devModel.timing)
        .map(([name, ms]) => `${name}=${ms}`)
        .join(" ")}`,
);

// Per-tag detector quality on the held-out development photos.
const devTestPhotos = photos.filter((photo) => devTest!.has(photo.id));
console.log("\n=== per-tag detector AUC on development test photos (positives = photos carrying the tag) ===");
console.log(`  tag      n_test  ${DETECTOR_TABLE.map((v) => v.padStart(7)).join("")}  hybrid`);
allTags.forEach((tag, t) => {
    const labels = Uint8Array.from(devTestPhotos, (photo) => (photo.tags.has(tag) ? 1 : 0));
    const aucOf = (variant: TagVariant): number =>
        binaryAuc(
            labels,
            Float64Array.from(devTestPhotos, (photo) => devModel.tagScores.get(variant)![photo.index * T + t]!),
        );
    const cells = DETECTOR_TABLE.map((v) => pct(aucOf(v)).padStart(7));
    const positives = labels.reduce((n, l) => n + l, 0);
    console.log(
        `  ${tag.padEnd(8)} ${String(positives).padStart(6)}  ${cells.join("")}  ${devModel.hybridPick[t]}`,
    );
});
console.log("  training-set AUC (fit check):");
console.log(`  tag              ${DETECTOR_TABLE.map((v) => v.padStart(7)).join("")}`);
allTags.forEach((tag, t) => {
    const cells = DETECTOR_TABLE.map((v) => pct(devModel.trainDetectorAuc.get(v)![t]!).padStart(7));
    console.log(`  ${tag.padEnd(8)}         ${cells.join("")}`);
});

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
            `  ${scorer.name.padEnd(22)} ${fmt(result.saved)} obj=${pct(objective(result.saved))} | all hard=${pct(result.all.hardAuc)} hard@12=${pct(result.all.hardTop12)}`,
        );
    }
};
printRows("=== development (seed 42), saved kits, references ===", devResults.filter((r) => isReference(r.scorer.name)));
printRows("=== development top 12 by objective ===", bySavedObjective.slice(0, 12));
printRows(
    "=== best cell per tag-term variant ===",
    TILE_VARIANTS.map((variant) => family(`${variant} h`)[0]!),
);
printRows(
    "=== tag term only (no centroid, no hard margin) ===",
    TAG_VARIANTS.map((variant) => byName.get(`${variant}-only`)!).map(
        (scorer) => devResults.find((r) => r.scorer === scorer)!,
    ),
);
printRows("=== additive global + tile ===", family("dual "));

const heatmap = (variant: TagVariant): void => {
    console.log(`\n=== ${variant}: hard AUC (hard@12) saved kits, rows=hard weight, cols=tag weight ===`);
    console.log(`        ${TAG_WEIGHTS.map((t) => `t${t}`.padStart(13)).join("")}`);
    for (const hardWeight of HARD_WEIGHTS) {
        const cells = TAG_WEIGHTS.map((tagWeight) => {
            const found = devResults.find((d) => d.scorer.name === `${variant} h${hardWeight} t${tagWeight}`);
            if (!found) {
                return "-".padStart(13);
            }
            const r = found.result.saved;
            return `${pct(r.hardAuc)} (${pct(r.hardTop12)})`.padStart(13);
        });
        console.log(`  h${String(hardWeight).padEnd(4)} ${cells.join("")}`);
    }
};
heatmap("T1w");
heatmap("GM");
heatmap("GM4");
heatmap("hybrid");

// Per-kit view: which kits move, and which tags they contain.
const candidates = bySavedObjective.filter((r) => !isReference(r.scorer.name));
const best = candidates[0]!;
const bestFirstScreen = [...candidates].sort(
    (a, b) => firstScreenObjective(b.result.saved) - firstScreenObjective(a.result.saved),
)[0]!;
const pass5Result = devResults.find((r) => r.scorer.name === PASS5_NAME)!.result;
console.log(`\n=== per saved kit, development: ${PASS5_NAME} → ${best.scorer.name} (hard AUC / hard@12) ===`);
for (const f of devFeatures) {
    if (f.fold.kit.source !== "saved") {
        continue;
    }
    const before = pass5Result.byKit.get(f.fold.kit.id)!;
    const after = best.result.byKit.get(f.fold.kit.id)!;
    console.log(
        `  ${f.fold.kit.id.padEnd(8)} [${f.fold.kit.tags.join(",")}]`.padEnd(48) +
            ` pos=${String(f.fold.testPositiveIds.length).padStart(3)} hardNeg=${String(f.fold.testHardNegativeIds.length).padStart(4)}  hard ${pct(before.hardAuc)} → ${pct(after.hardAuc)} (${((after.hardAuc - before.hardAuc) * 100).toFixed(1).padStart(5)})  @12 ${pct(before.hardTop12)} → ${pct(after.hardTop12)}`,
    );
}
console.log(`\npicks: best=${best.scorer.name} · first-screen=${bestFirstScreen.scorer.name}`);

if (DEV_ONLY) {
    console.log(`\ntotal ${elapsed()} (development only)`);
    process.exit(0);
}

// Confirmation on fixed picks (no instance training — development ablation only).
const picks = [
    ...new Set<Scorer>([
        byName.get("production")!,
        byName.get(PASS5_NAME)!,
        best.scorer,
        bestFirstScreen.scorer,
        ...(["T1max", "T1w", "T1wgmax", "GM", "GX", "GM4", "hybrid"] as const).map(
            (variant) => byName.get(`${variant} h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`)!,
        ),
        family("dual ")[0]!.scorer,
    ]),
].filter((scorer) => !scorer.name.startsWith("T2max"));

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
    const model = buildTrainModel(train!, false);
    const features = buildFoldFeatures(model, test!);
    for (const scorer of picks) {
        record(scorer.name, features, evaluateMethod(features, scorer));
    }
    console.log(
        `confirmation seed ${seed} folds=${features.length} hybrid=[${model.hybridPick.join(",")}] (${elapsed()})`,
    );
}
console.log(`\n=== confirmation mean over seeds ${CONFIRMATION_SEEDS.join("/")} — saved kits ===`);
for (const name of savedMeans.keys()) {
    console.log(`  ${name.padEnd(24)} ${fmt(averageMetrics(savedMeans.get(name)!))}`);
}
console.log("\n=== confirmation mean — all AND kits ===");
for (const name of allMeans.keys()) {
    console.log(`  ${name.padEnd(24)} ${fmt(averageMetrics(allMeans.get(name)!))}`);
}
console.log(`\n=== paired deltas vs ${PASS5_NAME} (saved kits, per-kit seed-averaged) ===`);
for (const name of savedMeans.keys()) {
    if (name === PASS5_NAME) {
        continue;
    }
    console.log(
        `  ${name.padEnd(24)} hardAUC ${pairedDelta(hardStore, name, PASS5_NAME)} | hard@12 ${pairedDelta(topStore, name, PASS5_NAME)}`,
    );
}

// Reserved three-way split: validation picks one cell, test reports.
const [reservedTrain, reservedValidation, reservedTest] = splitByGroups(RESERVED_SEED, [0.6, 0.2, 0.2]);
const reservedModel = buildTrainModel(reservedTrain!, false);
const validationFeatures = buildFoldFeatures(reservedModel, reservedValidation!);
const testFeatures = buildFoldFeatures(reservedModel, reservedTest!);
const validationCells = scorers.filter(
    (s) =>
        !s.name.startsWith("T2max") &&
        !s.name.endsWith("-only") &&
        s.name !== "production" &&
        (TILE_VARIANTS.some((v) => s.name.startsWith(`${v} h`)) || s.name.startsWith("dual ")),
);
const validationBest = validationCells
    .map((scorer) => ({ scorer, result: evaluateMethod(validationFeatures, scorer) }))
    .sort((a, b) => objective(b.result.saved) - objective(a.result.saved))[0]!;
console.log(
    `\n=== reserved split seed ${RESERVED_SEED}: train=${reservedTrain!.size} validation=${reservedValidation!.size} test=${reservedTest!.size} validationFolds=${validationFeatures.length} testFolds=${testFeatures.length} hybrid=[${reservedModel.hybridPick.join(",")}] ===`,
);
console.log(`  validation picked: ${validationBest.scorer.name}`);
const reservedHard: PerKitStore = new Map();
const reservedTop: PerKitStore = new Map();
const reservedScorers = [
    ...new Set([
        byName.get("production")!,
        byName.get(PASS5_NAME)!,
        validationBest.scorer,
        best.scorer,
        byName.get(`T1w h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`)!,
        byName.get(`GM h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`)!,
        byName.get(`GM4 h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`)!,
        byName.get(`hybrid h${SHIPPED_HARD_WEIGHT} t${SHIPPED_TAG_WEIGHT}`)!,
    ]),
];
for (const scorer of reservedScorers) {
    const result = evaluateMethod(testFeatures, scorer);
    console.log(
        `  test ${scorer.name.padEnd(22)} saved ${fmt(result.saved)} | all hard=${pct(result.all.hardAuc)} hard@12=${pct(result.all.hardTop12)}`,
    );
    for (const [store, read] of [
        [reservedHard, (m: Metrics) => m.hardAuc],
        [reservedTop, (m: Metrics) => m.hardTop12],
    ] as const) {
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
    console.log(
        `  test Δ ${scorer.name} vs ${PASS5_NAME}: hardAUC ${pairedDelta(reservedHard, scorer.name, PASS5_NAME)} | hard@12 ${pairedDelta(reservedTop, scorer.name, PASS5_NAME)}`,
    );
}
console.log(`\ntotal ${elapsed()}`);
