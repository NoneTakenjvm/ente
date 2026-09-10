/**
 * AND vs exact-tag membership for kit likeness (research only).
 *
 * Current production: a photo is a kit member / seed if it has every kit
 * tag (extras allowed). This run asks what happens if seeds, hard-negatives,
 * ranking labels, and kit-list counts use the exact tag set instead.
 *
 * Ranking uses the shipped pass-5 scorer (centroid λ=16 τ=0.02, whitened
 * hard margin, per-tag logistic min, h1.5 t4) on the pass-5 corpus and
 * leakage-free splits. Presence uses the shipped tag-product@0.5 estimator
 * on the pass-6 / presence corpus.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-exact-membership.ts
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    runStage1ClusteringSync,
    type Stage1Item,
} from "../src/lib/similarity-stage1-core";

const RANKING_CORPUS = "C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json";
const PRESENCE_CORPUS = "C:/Users/Elliot/Downloads/kit-nearness-corpus (3).json";

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
const HARD_WEIGHT = 1.5;
const TAG_WEIGHT = 4;
const SHRINKAGE = 1;
const LR_L2 = 0.01;
const LR_ITERATIONS = 100;
const LR_LEARNING_RATE = 0.1;
const DUP_THRESHOLD = 6;
const WINDOW_SIZE = 60;
const RANDOM_VIEWS = 30;
const FIT_THRESHOLD = 0.5;
const GHOST_SHOWN = 0.1;
const GHOST_TRUE = 0.02;
const MISSED_TRUE = 0.3;
const MISSED_SHOWN = 0.1;
const DEVELOPMENT_SEED = 42;
const CONFIRMATION_SEEDS = [99, 123, 2024, 7] as const;

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
    andIds: number[];
    exactIds: number[];
};

type Metrics = {
    hardAuc: number;
    easyAuc: number;
    hardAveragePrecision: number;
    fullAveragePrecision: number;
    hardTop12: number;
    fullTop12: number;
};

type SeedPolicy = "and" | "exact-purity" | "exact-hard";
type EvalPolicy = "and" | "exact";

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
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
    }
};

const mean = (values: readonly number[]): number =>
    values.length > 0 ?
        values.reduce((total, value) => total + value, 0) / values.length :
        Number.NaN;

const pct = (value: number): string => (value * 100).toFixed(1);

const comboKey = (tags: readonly string[]): string =>
    [...tags].sort().join("|");

const hasAll = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.length > 0 && kitTags.every((tag) => photoTags.has(tag));

const isExact = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean =>
    photoTags.size === kitTags.length && hasAll(photoTags, kitTags);

const sharesAny = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.some((tag) => photoTags.has(tag));

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

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

const loadCorpus = (path: string): {
    raw: AnonymisedKitNearnessCorpus;
    photos: Photo[];
    photoById: Map<number, Photo>;
} => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AnonymisedKitNearnessCorpus;
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
    return { raw, photos, photoById: new Map(photos.map((photo) => [photo.id, photo])) };
};

const centroidOf = (
    ids: readonly number[],
    photoById: ReadonlyMap<number, Photo>,
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

const duplicateGroupsOf = (photos: readonly Photo[]): number[][] => {
    const hashedItems: Stage1Item[] = photos
        .filter((photo) => photo.hashes.length > 0)
        .map((photo) => ({ fileId: photo.id, hashes: photo.hashes }));
    const clusters = runStage1ClusteringSync(hashedItems, DUP_THRESHOLD);
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
};

const splitByGroups = (
    photos: readonly Photo[],
    groups: readonly number[][],
    seed: number,
): [Set<number>, Set<number>] => {
    const shuffled = groups.map((group) => [...group]);
    shuffleInPlace(shuffled, mulberry32(seed));
    const target = Math.floor(photos.length * TRAIN_FRACTION);
    const train = new Set<number>();
    const test = new Set<number>();
    for (const group of shuffled) {
        group.forEach((id) => (train.size < target ? train : test).add(id));
    }
    return [train, test];
};

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

const choleskySolve = (lower: Float64Array, rhs: Float64Array): Float64Array =>
    backwardSolve(lower, forwardSolve(lower, rhs));

const whiteningOf = (rows: readonly Photo[]): { mu: Float64Array; lower: Float64Array } => {
    const mu = new Float64Array(DIM);
    for (const photo of rows) {
        for (let i = 0; i < DIM; i++) {
            mu[i]! += photo.vector[i]!;
        }
    }
    for (let i = 0; i < DIM; i++) {
        mu[i]! /= rows.length || 1;
    }
    const scatter = new Float64Array(DIM * DIM);
    const centred = new Float64Array(DIM);
    for (const photo of rows) {
        for (let i = 0; i < DIM; i++) {
            centred[i] = photo.vector[i]! - mu[i]!;
        }
        for (let i = 0; i < DIM; i++) {
            const xi = centred[i]!;
            for (let j = i; j < DIM; j++) {
                scatter[i * DIM + j]! += xi * centred[j]!;
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

type LogisticModel = { weights: Float64Array; offset: number };

const trainLogistic = (
    z: readonly Float64Array[],
    labels: Uint8Array,
    whitening: { mu: Float64Array; lower: Float64Array },
    prior: "balanced" | "natural",
): LogisticModel => {
    const n = z.length;
    let positives = 0;
    for (let i = 0; i < n; i++) {
        positives += labels[i]!;
    }
    const positiveWeight = prior === "balanced" ? n / (2 * Math.max(positives, 1)) : 1;
    const negativeWeight = prior === "balanced" ? n / (2 * Math.max(n - positives, 1)) : 1;
    const w = new Float64Array(DIM);
    let bias = 0;
    const grad = new Float64Array(DIM);
    const m = new Float64Array(DIM + 1);
    const v = new Float64Array(DIM + 1);
    for (let iteration = 1; iteration <= LR_ITERATIONS; iteration++) {
        grad.fill(0);
        let gradBias = 0;
        for (let i = 0; i < n; i++) {
            const row = z[i]!;
            let logit = bias;
            for (let d = 0; d < DIM; d++) {
                logit += w[d]! * row[d]!;
            }
            const g =
                ((labels[i] ? positiveWeight : negativeWeight) * (sigmoid(logit) - labels[i]!)) /
                n;
            for (let d = 0; d < DIM; d++) {
                grad[d]! += g * row[d]!;
            }
            gradBias += g;
        }
        const correction1 = 1 - 0.9 ** iteration;
        const correction2 = 1 - 0.999 ** iteration;
        for (let d = 0; d <= DIM; d++) {
            const g = d < DIM ? grad[d]! + LR_L2 * w[d]! : gradBias;
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
    const weights = backwardSolve(whitening.lower, w);
    let offset = bias;
    for (let i = 0; i < DIM; i++) {
        offset -= whitening.mu[i]! * weights[i]!;
    }
    return { weights, offset };
};

const logOdds = (model: LogisticModel, photo: Photo): number => {
    let z = model.offset;
    for (let i = 0; i < DIM; i++) {
        z += model.weights[i]! * photo.vector[i]!;
    }
    return z;
};

const priorShift = (labels: Uint8Array): number => {
    let positives = 0;
    for (let i = 0; i < labels.length; i++) {
        positives += labels[i]!;
    }
    const negatives = labels.length - positives;
    return Math.log(Math.max(positives, 1) / Math.max(negatives, 1));
};

const ranks = (values: readonly number[]): number[] => {
    const order = values
        .map((value, i) => i)
        .sort((a, b) => values[b]! - values[a]! || a - b);
    const out = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
        let j = i;
        while (j < order.length && values[order[j]!] === values[order[i]!]) {
            j += 1;
        }
        const rank = (i + j - 1) / 2;
        for (let k = i; k < j; k++) {
            out[order[k]!] = rank;
        }
        i = j;
    }
    return out;
};

const spearman = (a: readonly number[], b: readonly number[]): number => {
    const ra = ranks(a);
    const rb = ranks(b);
    const ma = mean(ra);
    const mb = mean(rb);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
        cov += (ra[i]! - ma) * (rb[i]! - mb);
        va += (ra[i]! - ma) ** 2;
        vb += (rb[i]! - mb) ** 2;
    }
    return va && vb ? cov / Math.sqrt(va * vb) : Number.NaN;
};

const kendallTau = (a: readonly number[], b: readonly number[]): number => {
    let concordant = 0;
    let discordant = 0;
    for (let i = 0; i < a.length; i++) {
        for (let j = i + 1; j < a.length; j++) {
            const da = Math.sign(a[i]! - a[j]!);
            const db = Math.sign(b[i]! - b[j]!);
            if (da === 0 || db === 0) {
                continue;
            }
            if (da === db) {
                concordant += 1;
            } else {
                discordant += 1;
            }
        }
    }
    const total = concordant + discordant;
    return total ? (concordant - discordant) / total : Number.NaN;
};

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
            const label = labels[order[j]!]!;
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
    let hardHits = 0;
    let hardRank = 0;
    let fullPrecisionSum = 0;
    let hardPrecisionSum = 0;
    const requested = Math.min(12, positives);
    let fullTopHits = 0;
    let hardTopHits = 0;
    for (let k = 0; k < n; k++) {
        const label = labels[order[k]!]!;
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

const fmtMetrics = (m: Metrics): string =>
    `hard=${pct(m.hardAuc)} hardAP=${pct(m.hardAveragePrecision)} hard@12=${pct(m.hardTop12)} full@12=${pct(m.fullTop12)} easy=${pct(m.easyAuc)}`;

const bootstrapInterval = (values: readonly number[]): [number, number] => {
    const random = mulberry32(7);
    const samples: number[] = [];
    for (let i = 0; i < 4000; i++) {
        samples.push(
            mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)),
        );
    }
    samples.sort((a, b) => a - b);
    return [samples[Math.floor(0.025 * samples.length)]!, samples[Math.floor(0.975 * samples.length)]!];
};

const buildEvalKits = (
    raw: AnonymisedKitNearnessCorpus,
    photos: readonly Photo[],
): EvalKit[] => {
    const kits: EvalKit[] = [];
    const add = (id: string, source: EvalKit["source"], tags: string[], andIds: number[]): void => {
        if (tags.length === 0 || andIds.length < MIN_KIT_MEMBERS) {
            return;
        }
        const exactIds = andIds.filter((id) => isExact(photoByIdLocal.get(id)!.tags, tags));
        kits.push({ id, source, tags: [...tags].sort(), andIds, exactIds });
    };
    const photoByIdLocal = new Map(photos.map((photo) => [photo.id, photo]));
    for (const saved of raw.kits) {
        add(
            saved.id,
            "saved",
            [...saved.tags].sort(),
            photos.filter((photo) => hasAll(photo.tags, saved.tags)).map((photo) => photo.id),
        );
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
            add(`and${arity}_${String(index + 1).padStart(2, "0")}`, "and-combo", key.split("|"), memberIds);
        });
    }
    const uniqueByTags = new Map<string, EvalKit>();
    for (const kit of kits) {
        const key = comboKey(kit.tags);
        const previous = uniqueByTags.get(key);
        if (
            !previous ||
            (previous.source !== "saved" && kit.source === "saved") ||
            kit.andIds.length > previous.andIds.length
        ) {
            uniqueByTags.set(key, kit);
        }
    }
    const sorted = [...uniqueByTags.values()].sort(
        (left, right) =>
            right.tags.length - left.tags.length || right.andIds.length - left.andIds.length,
    );
    const kept: EvalKit[] = [];
    const memberSets: Set<number>[] = [];
    for (const kit of sorted) {
        const members = new Set(kit.andIds);
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

const seedIdsFor = (kit: EvalKit, policy: SeedPolicy): number[] =>
    policy === "and" ? kit.andIds : kit.exactIds;

/** Hard-neg labels depend on the eval task, not on how the prototype was built. */
const isHardNegative = (photo: Photo, kit: EvalKit, evalPolicy: EvalPolicy): boolean => {
    if (evalPolicy === "and") {
        return !hasAll(photo.tags, kit.tags) && sharesAny(photo.tags, kit.tags);
    }
    return sharesAny(photo.tags, kit.tags) && !isExact(photo.tags, kit.tags);
};

const hardCentroidIds = (
    trainPhotos: readonly Photo[],
    kit: EvalKit,
    seedPolicy: SeedPolicy,
): number[] => {
    if (seedPolicy === "and" || seedPolicy === "exact-purity") {
        return trainPhotos
            .filter((photo) => !hasAll(photo.tags, kit.tags) && sharesAny(photo.tags, kit.tags))
            .map((photo) => photo.id);
    }
    return trainPhotos
        .filter((photo) => sharesAny(photo.tags, kit.tags) && !isExact(photo.tags, kit.tags))
        .map((photo) => photo.id);
};

type PresenceMetrics = {
    mae: number;
    maeMajor: number;
    spearman: number;
    top1: number;
    top3: number;
    ghosts: number;
    missed: number;
};

const comparePresence = (
    estimated: readonly number[],
    truth: readonly number[],
    tagCounts: readonly number[],
): PresenceMetrics => {
    const errors = truth.map((t, k) => Math.abs(estimated[k]! - t));
    const major = truth.map((t, k) => (t >= 0.1 ? errors[k]! : Number.NaN));
    const trueOrder = [...truth.keys()].sort(
        (a, b) => truth[b]! - truth[a]! || tagCounts[b]! - tagCounts[a]!,
    );
    const estimatedOrder = [...estimated.keys()].sort(
        (a, b) => estimated[b]! - estimated[a]! || tagCounts[b]! - tagCounts[a]!,
    );
    const maxTruth = truth[trueOrder[0]!]!;
    const top1 = maxTruth > 0 ? (truth[estimatedOrder[0]!]! >= 0.9 * maxTruth ? 1 : 0) : Number.NaN;
    const trueTop3 = new Set(trueOrder.slice(0, 3).filter((k) => truth[k]! > 0));
    const top3 = trueTop3.size ?
        estimatedOrder.slice(0, 3).filter((k) => trueTop3.has(k)).length / trueTop3.size :
        Number.NaN;
    let ghosts = 0;
    let missed = 0;
    for (let k = 0; k < truth.length; k++) {
        if (truth[k]! < GHOST_TRUE && estimated[k]! >= GHOST_SHOWN) {
            ghosts += 1;
        }
        if (truth[k]! >= MISSED_TRUE && estimated[k]! < MISSED_SHOWN) {
            missed += 1;
        }
    }
    return {
        mae: mean(errors),
        maeMajor: mean(major),
        spearman: spearman(estimated, truth),
        top1,
        top3,
        ghosts,
        missed,
    };
};

const averagePresence = (list: readonly PresenceMetrics[]): PresenceMetrics => ({
    mae: mean(list.map((m) => m.mae)),
    maeMajor: mean(list.map((m) => m.maeMajor)),
    spearman: mean(list.map((m) => m.spearman)),
    top1: mean(list.map((m) => m.top1)),
    top3: mean(list.map((m) => m.top3)),
    ghosts: mean(list.map((m) => m.ghosts)),
    missed: mean(list.map((m) => m.missed)),
});

const fmtPresence = (m: PresenceMetrics): string =>
    `MAE=${pct(m.mae).padStart(5)}pp major=${pct(m.maeMajor).padStart(5)}pp ρ=${m.spearman.toFixed(2)} top1=${pct(m.top1).padStart(5)} top3=${pct(m.top3).padStart(5)} ghosts=${m.ghosts.toFixed(2)} missed=${m.missed.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const runRanking = (): void => {
    const { raw, photos, photoById } = loadCorpus(RANKING_CORPUS);
    const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();
    const tagIndex = new Map(allTags.map((tag, index) => [tag, index]));
    const evalKits = buildEvalKits(raw, photos);
    const savedKits = evalKits.filter((kit) => kit.source === "saved" && kit.tags.length >= 2);
    const groups = duplicateGroupsOf(photos);

    console.log("\n=== Ranking corpus (pass 5) ===");
    console.log(`photos=${photos.length} tags=${allTags.length} saved arity≥2 kits=${savedKits.length}`);
    console.log("kit  arity  AND  exact  extras  extras%  centroidΔ");
    for (const kit of savedKits) {
        const extras = kit.andIds.length - kit.exactIds.length;
        const andC = centroidOf(kit.andIds, photoById);
        const exactC = centroidOf(kit.exactIds, photoById);
        const delta = andC && exactC ? (1 - dot(andC, exactC)).toFixed(4) : "n/a";
        console.log(
            `${kit.id.padEnd(8)} ${String(kit.tags.length).padStart(5)}  ${String(kit.andIds.length).padStart(4)}  ${String(kit.exactIds.length).padStart(5)}  ${String(extras).padStart(6)}  ${((100 * extras) / kit.andIds.length).toFixed(1).padStart(7)}  ${delta}`,
        );
    }

    const andCounts = savedKits.map((kit) => kit.andIds.length);
    const exactCounts = savedKits.map((kit) => kit.exactIds.length);
    console.log(
        `\nkit-list order (tagged counts, saved arity≥2): Spearman ρ=${spearman(andCounts, exactCounts).toFixed(3)}  Kendall τ=${kendallTau(andCounts, exactCounts).toFixed(3)}`,
    );
    const andOrder = savedKits
        .map((kit, i) => i)
        .sort((a, b) => andCounts[b]! - andCounts[a]! || savedKits[b]!.tags.length - savedKits[a]!.tags.length);
    const exactOrder = savedKits
        .map((kit, i) => i)
        .sort((a, b) => exactCounts[b]! - exactCounts[a]! || savedKits[b]!.tags.length - savedKits[a]!.tags.length);
    console.log(
        `AND top3: ${andOrder.slice(0, 3).map((i) => `${savedKits[i]!.id}(${andCounts[i]})`).join(", ")}`,
    );
    console.log(
        `exact top3: ${exactOrder.slice(0, 3).map((i) => `${savedKits[i]!.id}(${exactCounts[i]})`).join(", ")}`,
    );
    const exactTooSmall = savedKits.filter((kit) => kit.exactIds.length < MIN_KIT_MEMBERS);
    console.log(
        `kits with <${MIN_KIT_MEMBERS} exact members: ${exactTooSmall.length}/${savedKits.length}` +
            (exactTooSmall.length ?
                ` (${exactTooSmall.map((kit) => `${kit.id}:${kit.exactIds.length}`).join(", ")})` :
                ""),
    );

    type Cell = { seed: SeedPolicy; eval: EvalPolicy };
    const cells: Cell[] = [
        { seed: "and", eval: "and" },
        { seed: "exact-purity", eval: "and" },
        { seed: "exact-hard", eval: "and" },
        { seed: "and", eval: "exact" },
        { seed: "exact-purity", eval: "exact" },
        { seed: "exact-hard", eval: "exact" },
    ];
    const byCell = new Map<string, Metrics[]>();
    const kitsByCell = new Map<string, number[]>();
    const extraRankPercentiles: number[] = [];

    const cellKey = (cell: Cell): string => `${cell.seed} / ${cell.eval}`;

    const runSplit = (seed: number): void => {
        const [trainIds, testIds] = splitByGroups(photos, groups, seed);
        const trainPhotos = photos.filter((photo) => trainIds.has(photo.id));
        const whitening = whiteningOf(trainPhotos);
        const whitened = trainPhotos.map((photo) =>
            forwardSolve(whitening.lower, difference(photo.vector, whitening.mu)));
        const tagModels = allTags.map((tag) => {
            const labels = Uint8Array.from(trainPhotos, (photo) => (photo.tags.has(tag) ? 1 : 0));
            return trainLogistic(whitened, labels, whitening, "balanced");
        });
        const tagLogOdds = new Float64Array(photos.length * allTags.length);
        for (const photo of photos) {
            tagModels.forEach((model, t) => {
                tagLogOdds[photo.index * allTags.length + t] = logOdds(model, photo);
            });
        }

        for (const cell of cells) {
            const rivalCentroids = savedKits
                .map((kit) => {
                    const ids = seedIdsFor(kit, cell.seed).filter((id) => trainIds.has(id));
                    const centroid = centroidOf(ids, photoById, PRODUCTION_SEED_CAP);
                    return centroid ?
                        { id: kit.id, tagsKey: comboKey(kit.tags), centroid } :
                        undefined;
                })
                .filter((rival): rival is { id: string; tagsKey: string; centroid: Float64Array } =>
                    Boolean(rival));
            const rivalSimilarity = new Float64Array(photos.length * rivalCentroids.length);
            for (const photo of photos) {
                rivalCentroids.forEach((rival, r) => {
                    rivalSimilarity[photo.index * rivalCentroids.length + r] = dot(
                        photo.vector,
                        rival.centroid,
                    );
                });
            }

            const kitMetrics: Metrics[] = [];
            for (const kit of savedKits) {
                const selectedIds = seedIdsFor(kit, cell.seed).filter((id) => trainIds.has(id));
                const hardIds = hardCentroidIds(trainPhotos, kit, cell.seed);
                const selected = centroidOf(selectedIds, photoById, PRODUCTION_SEED_CAP);
                const hard = centroidOf(hardIds, photoById);
                const tagIndices = kit.tags.map((tag) => tagIndex.get(tag)!);
                if (
                    !selected ||
                    !hard ||
                    selectedIds.length < MIN_TRAIN_POSITIVES ||
                    tagIndices.some((t) => tagModels[t] === undefined)
                ) {
                    continue;
                }
                const hardWDir = choleskySolve(whitening.lower, difference(selected, hard));
                const rivalIndices: number[] = [];
                const rivalWeights: number[] = [];
                rivalCentroids.forEach((rival, r) => {
                    if (rival.id === kit.id || rival.tagsKey === comboKey(kit.tags)) {
                        return;
                    }
                    const distance = 1 - dot(selected, rival.centroid);
                    rivalIndices.push(r);
                    rivalWeights.push(distance > 0 ? distance / (distance + PRODUCTION_TAU) : 0);
                });

                const termsOf = (photo: Photo): [number, number, number] => {
                    const selectedSimilarity = dot(photo.vector, selected);
                    let steal = 0;
                    const rivalRow = photo.index * rivalCentroids.length;
                    for (let i = 0; i < rivalIndices.length; i++) {
                        const similarity = rivalSimilarity[rivalRow + rivalIndices[i]!]!;
                        steal = Math.max(
                            steal,
                            Math.max(0, similarity - selectedSimilarity) * rivalWeights[i]!,
                        );
                    }
                    const prod = selectedSimilarity - PRODUCTION_LAMBDA * steal;
                    const hardW = dot(photo.vector, hardWDir);
                    const tagRow = photo.index * allTags.length;
                    let tagMin = Number.POSITIVE_INFINITY;
                    for (const tagIdx of tagIndices) {
                        tagMin = Math.min(tagMin, tagLogOdds[tagRow + tagIdx]!);
                    }
                    return [prod, hardW, tagMin];
                };

                const sigma = (() => {
                    const sums = [0, 0, 0];
                    const squares = [0, 0, 0];
                    for (const photo of trainPhotos) {
                        const t = termsOf(photo);
                        for (let c = 0; c < 3; c++) {
                            sums[c]! += t[c]!;
                            squares[c]! += t[c]! * t[c]!;
                        }
                    }
                    return sums.map((sum, c) => {
                        const m = sum / trainPhotos.length;
                        return Math.sqrt(Math.max(0, squares[c]! / trainPhotos.length - m * m)) || 1;
                    });
                })();

                const scoreOf = (photo: Photo): number => {
                    const [prod, hardW, tagMin] = termsOf(photo);
                    return prod / sigma[0]! + (HARD_WEIGHT * hardW) / sigma[1]! + (TAG_WEIGHT * tagMin) / sigma[2]!;
                };

                const positiveIds = (cell.eval === "and" ? kit.andIds : kit.exactIds).filter((id) =>
                    testIds.has(id));
                const hardNegIds: number[] = [];
                const easyNegIds: number[] = [];
                for (const photo of photos) {
                    if (!testIds.has(photo.id)) {
                        continue;
                    }
                    if (cell.eval === "and" ? hasAll(photo.tags, kit.tags) : isExact(photo.tags, kit.tags)) {
                        continue;
                    }
                    if (isHardNegative(photo, kit, cell.eval)) {
                        hardNegIds.push(photo.id);
                    } else if (!sharesAny(photo.tags, kit.tags)) {
                        easyNegIds.push(photo.id);
                    }
                }
                if (
                    positiveIds.length < MIN_TEST_POSITIVES ||
                    hardNegIds.length < MIN_TEST_HARD_NEGATIVES ||
                    easyNegIds.length < MIN_TEST_EASY_NEGATIVES
                ) {
                    continue;
                }
                const labelled: [number[], number][] = [
                    [positiveIds, 0],
                    [hardNegIds, 1],
                    [easyNegIds, 2],
                ];
                const rows: number[] = [];
                const labels: number[] = [];
                for (const [ids, label] of labelled) {
                    for (const id of ids) {
                        rows.push(scoreOf(photoById.get(id)!));
                        labels.push(label);
                    }
                }
                const metrics = metricsOf(Uint8Array.from(labels), Float64Array.from(rows));
                kitMetrics.push(metrics);

                if (cell.seed === "and" && cell.eval === "and") {
                    const extras = kit.andIds.filter(
                        (id) => testIds.has(id) && !isExact(photoById.get(id)!.tags, kit.tags),
                    );
                    if (extras.length) {
                        const pool = [...positiveIds, ...hardNegIds, ...easyNegIds];
                        const scored = pool
                            .map((id) => ({ id, score: scoreOf(photoById.get(id)!) }))
                            .sort((a, b) => b.score - a.score || a.id - b.id);
                        const rankOf = new Map(scored.map((row, index) => [row.id, index]));
                        for (const id of extras) {
                            extraRankPercentiles.push((rankOf.get(id)! + 1) / scored.length);
                        }
                    }
                }
            }
            if (kitMetrics.length) {
                const key = cellKey(cell);
                byCell.set(key, [...(byCell.get(key) ?? []), averageMetrics(kitMetrics)]);
                kitsByCell.set(key, [...(kitsByCell.get(key) ?? []), kitMetrics.length]);
            }
        }
    };

    const seeds = [DEVELOPMENT_SEED, ...CONFIRMATION_SEEDS];
    for (const seed of seeds) {
        const started = Date.now();
        runSplit(seed);
        console.log(`split seed=${seed} ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }

    console.log("\n=== Gallery ranking (shipped pass-5 scorer, saved arity≥2) ===");
    console.log("seed policy = who builds the centroid / rivals / hard centroid");
    console.log("eval = who counts as a positive on the test side");
    console.log("exact-purity: extras leave the centroid but stay out of c_hard");
    console.log("exact-hard: extras leave the centroid and join c_hard");
    const baseline = byCell.get("and / and")!;
    for (const cell of cells) {
        const rows = byCell.get(cellKey(cell));
        if (!rows?.length) {
            console.log(`${cellKey(cell).padEnd(28)}  (no kits passed thresholds)`);
            continue;
        }
        const avg = averageMetrics(rows);
        const delta = mean(rows.map((row, i) => row.hardAuc - baseline[i]!.hardAuc));
        const [lo, hi] = bootstrapInterval(rows.map((row, i) => row.hardAuc - baseline[i]!.hardAuc));
        const kitN = mean(kitsByCell.get(cellKey(cell)) ?? []);
        console.log(
            `${cellKey(cell).padEnd(28)}  kits=${kitN.toFixed(0)}  ${fmtMetrics(avg)}  Δhard=${(delta * 100).toFixed(1)}pp [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]`,
        );
    }
    if (extraRankPercentiles.length) {
        extraRankPercentiles.sort((a, b) => a - b);
        const mid = extraRankPercentiles[Math.floor(extraRankPercentiles.length / 2)]!;
        console.log(
            `\nAND-eval extras under current ranking: n=${extraRankPercentiles.length} median percentile=${(mid * 100).toFixed(1)} (0=top)`,
        );
    }
};

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

const runPresence = (): void => {
    const { raw, photos } = loadCorpus(PRESENCE_CORPUS);
    const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();
    const tagIndex = new Map(allTags.map((tag, index) => [tag, index]));
    const kits = raw.kits
        .map((saved) => {
            const tags = [...saved.tags].sort();
            const andIds = photos.filter((photo) => hasAll(photo.tags, tags)).map((photo) => photo.id);
            const exactIds = photos
                .filter((photo) => isExact(photo.tags, tags))
                .map((photo) => photo.id);
            return { id: saved.id, tags, andIds, exactIds };
        })
        .filter((kit) => kit.tags.length > 0 && kit.andIds.length >= MIN_KIT_MEMBERS)
        .sort((a, b) => a.id.localeCompare(b.id));
    const groups = duplicateGroupsOf(photos);
    const K = kits.length;

    console.log("\n=== Presence corpus (kit likeness list) ===");
    console.log(`photos=${photos.length} tags=${allTags.length} saved kits=${K}`);
    const andCounts = kits.map((kit) => kit.andIds.length);
    const exactCounts = kits.map((kit) => kit.exactIds.length);
    console.log(
        `kit-list order (full tagged set): Spearman ρ=${spearman(andCounts, exactCounts).toFixed(3)}  Kendall τ=${kendallTau(andCounts, exactCounts).toFixed(3)}`,
    );
    console.log("kit  arity  AND  exact  extras%");
    for (const kit of kits) {
        const extras = kit.andIds.length - kit.exactIds.length;
        console.log(
            `${kit.id.padEnd(8)} ${String(kit.tags.length).padStart(5)}  ${String(kit.andIds.length).padStart(4)}  ${String(kit.exactIds.length).padStart(5)}  ${((100 * extras) / kit.andIds.length).toFixed(1).padStart(7)}`,
        );
    }

    type View = { kind: string; photos: Photo[] };
    const buildViews = (testIds: ReadonlySet<number>, seed: number): View[] => {
        const test = photos.filter((photo) => testIds.has(photo.id)).sort((a, b) => a.id - b.id);
        const views: View[] = [{ kind: "all", photos: test }];
        for (const tag of allTags) {
            const subset = test.filter((photo) => photo.tags.has(tag));
            if (subset.length >= 10) {
                views.push({ kind: "tag", photos: subset });
            }
        }
        for (const kit of kits) {
            const andSet = new Set(kit.andIds);
            const subset = test.filter((photo) => andSet.has(photo.id));
            if (subset.length >= 10) {
                views.push({ kind: "kit", photos: subset });
            }
        }
        for (let start = 0; start + WINDOW_SIZE <= test.length; start += WINDOW_SIZE) {
            views.push({ kind: "window", photos: test.slice(start, start + WINDOW_SIZE) });
        }
        const random = mulberry32(seed ^ 0x9e37);
        for (let i = 0; i < RANDOM_VIEWS; i++) {
            const shuffled = [...test];
            shuffleInPlace(shuffled, random);
            views.push({ kind: "random", photos: shuffled.slice(0, WINDOW_SIZE) });
        }
        return views;
    };

    const seeds = [DEVELOPMENT_SEED, ...CONFIRMATION_SEEDS];
    const andVsAnd: PresenceMetrics[] = [];
    const andVsExact: PresenceMetrics[] = [];
    const exactVsExact: PresenceMetrics[] = [];
    const tagCounts = kits.map((kit) => kit.tags.length);

    for (const seed of seeds) {
        const started = Date.now();
        const [trainIds, testIds] = splitByGroups(photos, groups, seed);
        const train = photos.filter((photo) => trainIds.has(photo.id));
        const whitening = whiteningOf(train);
        const z = train.map((photo) => forwardSolve(whitening.lower, difference(photo.vector, whitening.mu)));
        const tagLabels = allTags.map((tag) =>
            Uint8Array.from(train, (photo) => (photo.tags.has(tag) ? 1 : 0)));
        const tagBalanced = allTags.map((_, t) => trainLogistic(z, tagLabels[t]!, whitening, "balanced"));
        const tagShift = tagLabels.map((labels) => priorShift(labels));
        const views = buildViews(testIds, seed);

        const tagProb = (photo: Photo): number[] =>
            tagBalanced.map((model, t) => sigmoid(logOdds(model, photo) + tagShift[t]!));

        for (const view of views) {
            const andTruth = kits.map(
                (kit) => view.photos.filter((photo) => hasAll(photo.tags, kit.tags)).length / view.photos.length,
            );
            const exactTruth = kits.map(
                (kit) => view.photos.filter((photo) => isExact(photo.tags, kit.tags)).length / view.photos.length,
            );
            const andEstimate = new Array<number>(K).fill(0);
            const exactEstimate = new Array<number>(K).fill(0);
            for (const photo of view.photos) {
                const p = tagProb(photo);
                const predicted = new Set(
                    allTags.filter((_, t) => p[t]! >= FIT_THRESHOLD),
                );
                for (let k = 0; k < K; k++) {
                    const kit = kits[k]!;
                    const product = kit.tags.reduce((acc, tag) => acc * p[tagIndex.get(tag)!]!, 1);
                    if (product >= FIT_THRESHOLD) {
                        andEstimate[k]! += 1;
                    }
                    const predictedExact =
                        predicted.size === kit.tags.length && kit.tags.every((tag) => predicted.has(tag));
                    if (predictedExact) {
                        exactEstimate[k]! += 1;
                    }
                }
            }
            for (let k = 0; k < K; k++) {
                andEstimate[k]! /= view.photos.length;
                exactEstimate[k]! /= view.photos.length;
            }
            andVsAnd.push(comparePresence(andEstimate, andTruth, tagCounts));
            andVsExact.push(comparePresence(andEstimate, exactTruth, tagCounts));
            exactVsExact.push(comparePresence(exactEstimate, exactTruth, tagCounts));
        }
        console.log(`presence seed=${seed} ${((Date.now() - started) / 1000).toFixed(0)}s views=${views.length}`);
    }

    console.log("\n=== Kit likeness list (shipped tag-product @0.5 vs truth) ===");
    console.log(`estimator AND, truth AND    ${fmtPresence(averagePresence(andVsAnd))}`);
    console.log(`estimator AND, truth exact  ${fmtPresence(averagePresence(andVsExact))}`);
    console.log(`estimator exact-set @0.5, truth exact  ${fmtPresence(averagePresence(exactVsExact))}`);
};

console.log("Kit likeness: AND vs exact tag-set membership");
console.log("Shipped settings: centroid λ=16 τ=0.02, margins h=1.5 t=4, l2=0.01");
runRanking();
runPresence();
