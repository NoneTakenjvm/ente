/**
 * ONLY (exact tag-set) kit likeness: drowning diagnosis, presence search,
 * and ranking retune (grid + GA). Research only.
 *
 * The previous exact-membership run reused AND-tuned genes (λ=16 τ=0.02
 * h1.5 t4). This one searches genes for the ONLY task and measures the
 * nested-kit drowning the AND dropdown causes by construction.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-only-tune.ts
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
const MIN_KIT_MEMBERS = 8;
const MIN_TRAIN_POSITIVES = 8;
const MIN_TEST_POSITIVES = 5;
const MIN_TEST_HARD = 16;
const MIN_TEST_EASY = 24;
const TRAIN_FRACTION = 0.6;
const SEED_CAP = 150;
const SHRINKAGE = 1;
const LR_L2 = 0.01;
const LR_ITERATIONS = 100;
const LR_LEARNING_RATE = 0.1;
const DUP_THRESHOLD = 6;
const WINDOW_SIZE = 60;
const RANDOM_VIEWS = 30;
const GHOST_SHOWN = 0.1;
const GHOST_TRUE = 0.02;
const MISSED_TRUE = 0.3;
const MISSED_SHOWN = 0.1;
const DEV_SEED = 42;
const CONFIRM_SEEDS = [99, 123, 2024, 7] as const;

type SourcePhoto = AnonymisedKitNearnessCorpus["photos"][number];
type Photo = {
    id: number;
    index: number;
    tags: ReadonlySet<string>;
    vector: Float64Array;
    hashes: string[];
};
type Kit = {
    id: string;
    tags: string[];
    andIds: number[];
    exactIds: number[];
};
type Metrics = {
    hardAuc: number;
    easyAuc: number;
    exclAuc: number;
    hardAp: number;
    hardTop12: number;
};
type PresenceRow = {
    mae: number;
    spearman: number;
    top1: number;
    top3: number;
    ghosts: number;
    missed: number;
    parentWins: number;
    childTop5: number;
    top1Share: number;
};
type Genes = {
    lambda: number;
    tau: number;
    hPartial: number;
    hExtra: number;
    tTag: number;
    xExcl: number;
};

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
const mean = (values: readonly number[]): number => {
    const kept = values.filter((value) => Number.isFinite(value));
    return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : Number.NaN;
};
const pct = (value: number): string => (value * 100).toFixed(1);
const comboKey = (tags: readonly string[]): string => [...tags].sort().join("|");
const hasAll = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.length > 0 && kit.every((tag) => have.has(tag));
const isExact = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    have.size === kit.length && hasAll(have, kit);
const sharesAny = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.some((tag) => have.has(tag));
const isSubset = (inner: readonly string[], outer: readonly string[]): boolean =>
    inner.length < outer.length && inner.every((tag) => outer.includes(tag));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
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

const loadCorpus = (path: string): {
    raw: AnonymisedKitNearnessCorpus;
    photos: Photo[];
    photoById: Map<number, Photo>;
    allTags: string[];
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
    const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();
    return { raw, photos, photoById: new Map(photos.map((p) => [p.id, p])), allTags };
};

const centroidOf = (
    ids: readonly number[],
    photoById: ReadonlyMap<number, Photo>,
    cap: number = Number.POSITIVE_INFINITY,
): Float64Array | undefined => {
    const selected = Number.isFinite(cap) ? [...ids].sort((a, b) => a - b).slice(0, cap) : ids;
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

const savedKitsOf = (raw: AnonymisedKitNearnessCorpus, photos: readonly Photo[]): Kit[] =>
    raw.kits
        .map((saved) => {
            const tags = [...saved.tags].sort();
            const andIds = photos.filter((photo) => hasAll(photo.tags, tags)).map((p) => p.id);
            const exactIds = photos.filter((photo) => isExact(photo.tags, tags)).map((p) => p.id);
            return { id: saved.id, tags, andIds, exactIds };
        })
        .filter((kit) => kit.tags.length > 0 && kit.andIds.length >= MIN_KIT_MEMBERS)
        .sort((a, b) => a.id.localeCompare(b.id));

const nestedPairsOf = (kits: readonly Kit[]): { parent: number; child: number }[] => {
    const pairs: { parent: number; child: number }[] = [];
    for (let parent = 0; parent < kits.length; parent++) {
        for (let child = 0; child < kits.length; child++) {
            if (isSubset(kits[parent]!.tags, kits[child]!.tags)) {
                pairs.push({ parent, child });
            }
        }
    }
    return pairs;
};

const duplicateGroupsOf = (photos: readonly Photo[]): number[][] => {
    const items: Stage1Item[] = photos
        .filter((photo) => photo.hashes.length > 0)
        .map((photo) => ({ fileId: photo.id, hashes: photo.hashes }));
    const grouped = new Set<number>();
    const groups: number[][] = [];
    for (const cluster of runStage1ClusteringSync(items, DUP_THRESHOLD)) {
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
                i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / lower[j * DIM + j]!;
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
                ((labels[i] ? positiveWeight : negativeWeight) * (sigmoid(logit) - labels[i]!)) / n;
            for (let d = 0; d < DIM; d++) {
                grad[d]! += g * row[d]!;
            }
            gradBias += g;
        }
        const c1 = 1 - 0.9 ** iteration;
        const c2 = 1 - 0.999 ** iteration;
        for (let d = 0; d <= DIM; d++) {
            const g = d < DIM ? grad[d]! + LR_L2 * w[d]! : gradBias;
            m[d] = 0.9 * m[d]! + 0.1 * g;
            v[d] = 0.999 * v[d]! + 0.001 * g * g;
            const step = (LR_LEARNING_RATE * (m[d]! / c1)) / (Math.sqrt(v[d]! / c2) + 1e-8);
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
    for (const label of labels) {
        positives += label;
    }
    return Math.log(Math.max(positives, 1) / Math.max(labels.length - positives, 1));
};

const ranks = (values: readonly number[]): number[] => {
    const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]! || a - b);
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

const mannWhitney = (pos: readonly number[], neg: readonly number[]): number => {
    if (!pos.length || !neg.length) {
        return 0.5;
    }
    let wins = 0;
    for (const p of pos) {
        for (const n of neg) {
            wins += p > n ? 1 : p === n ? 0.5 : 0;
        }
    }
    return wins / (pos.length * neg.length);
};

const metricsOf = (
    labels: Uint8Array,
    scores: Float64Array,
    extraMask: Uint8Array,
): Metrics => {
    const n = labels.length;
    const order = Array.from({ length: n }, (_, i) => i).sort(
        (a, b) => scores[b]! - scores[a]! || a - b,
    );
    let positives = 0;
    let hard = 0;
    let easy = 0;
    const posScores: number[] = [];
    const extraScores: number[] = [];
    for (let i = 0; i < n; i++) {
        if (labels[i] === 0) {
            positives += 1;
            posScores.push(scores[i]!);
        } else if (labels[i] === 1) {
            hard += 1;
            if (extraMask[i]) {
                extraScores.push(scores[i]!);
            }
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
        let groupPos = 0;
        let groupHard = 0;
        let groupEasy = 0;
        while (j < n && scores[order[j]!] === scores[order[i]!]) {
            const label = labels[order[j]!]!;
            if (label === 0) {
                groupPos += 1;
            } else if (label === 1) {
                groupHard += 1;
            } else {
                groupEasy += 1;
            }
            j += 1;
        }
        hardWins += groupPos * (hard - hardSeen - groupHard + 0.5 * groupHard);
        easyWins += groupPos * (easy - easySeen - groupEasy + 0.5 * groupEasy);
        hardSeen += groupHard;
        easySeen += groupEasy;
        i = j;
    }
    let hardHits = 0;
    let hardRank = 0;
    let hardPrecisionSum = 0;
    const requested = Math.min(12, positives);
    let hardTopHits = 0;
    for (let k = 0; k < n; k++) {
        const label = labels[order[k]!]!;
        if (label !== 2) {
            hardRank += 1;
        }
        if (label === 0) {
            hardHits += 1;
            hardPrecisionSum += hardHits / hardRank;
            if (hardRank <= requested) {
                hardTopHits += 1;
            }
        }
    }
    return {
        hardAuc: positives && hard ? hardWins / (positives * hard) : 0.5,
        easyAuc: positives && easy ? easyWins / (positives * easy) : 0.5,
        exclAuc: mannWhitney(posScores, extraScores),
        hardAp: positives ? hardPrecisionSum / positives : 0,
        hardTop12: requested ? hardTopHits / requested : 0,
    };
};

const averageMetrics = (list: readonly Metrics[]): Metrics => ({
    hardAuc: mean(list.map((m) => m.hardAuc)),
    easyAuc: mean(list.map((m) => m.easyAuc)),
    exclAuc: mean(list.map((m) => m.exclAuc)),
    hardAp: mean(list.map((m) => m.hardAp)),
    hardTop12: mean(list.map((m) => m.hardTop12)),
});
const firstScreen = (m: Metrics): number =>
    0.4 * m.hardAuc + 0.2 * m.hardAp + 0.4 * m.hardTop12;
const fmtMetrics = (m: Metrics): string =>
    `hard=${pct(m.hardAuc)} excl=${pct(m.exclAuc)} hardAP=${pct(m.hardAp)} @12=${pct(m.hardTop12)} easy=${pct(m.easyAuc)}`;
const geneKey = (g: Genes): string =>
    `λ${g.lambda} τ${g.tau} hP${g.hPartial} hE${g.hExtra} t${g.tTag} x${g.xExcl}`;
const shippedOnlyGenes = (): Genes => ({
    lambda: 16,
    tau: 0.02,
    hPartial: 1.5,
    hExtra: 0,
    tTag: 4,
    xExcl: 0,
});

const ranksByCount = (counts: readonly number[], tagCounts: readonly number[]): number[] =>
    [...counts.keys()].sort(
        (a, b) => counts[b]! - counts[a]! || tagCounts[b]! - tagCounts[a]!,
    );

const presenceOf = (
    estimated: readonly number[],
    truth: readonly number[],
    tagCounts: readonly number[],
    pairs: readonly { parent: number; child: number }[],
): PresenceRow => {
    const errors = truth.map((t, k) => Math.abs(estimated[k]! - t));
    const trueOrder = ranksByCount(truth, tagCounts);
    const estOrder = ranksByCount(estimated, tagCounts);
    const maxTruth = truth[trueOrder[0]!]!;
    const top1 = maxTruth > 0 ? (truth[estOrder[0]!]! >= 0.9 * maxTruth ? 1 : 0) : Number.NaN;
    const trueTop3 = new Set(trueOrder.slice(0, 3).filter((k) => truth[k]! > 0));
    const top3 = trueTop3.size ?
        estOrder.slice(0, 3).filter((k) => trueTop3.has(k)).length / trueTop3.size :
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
    let parentWins = 0;
    let pairN = 0;
    for (const pair of pairs) {
        pairN += 1;
        if (estimated[pair.parent]! > estimated[pair.child]!) {
            parentWins += 1;
        }
    }
    const trueTop5 = new Set(
        trueOrder.slice(0, 5).filter((k) => truth[k]! > 0 && tagCounts[k]! >= 2),
    );
    const estTop5 = new Set(estOrder.slice(0, 5));
    const childTop5 = trueTop5.size ?
        [...trueTop5].filter((k) => estTop5.has(k)).length / trueTop5.size :
        Number.NaN;
    const total = estimated.reduce((a, b) => a + b, 0);
    return {
        mae: mean(errors),
        spearman: spearman(estimated, truth),
        top1,
        top3,
        ghosts,
        missed,
        parentWins: pairN ? parentWins / pairN : Number.NaN,
        childTop5,
        top1Share: total > 0 ? estimated[estOrder[0]!]! / total : Number.NaN,
    };
};
const averagePresence = (list: readonly PresenceRow[]): PresenceRow => ({
    mae: mean(list.map((m) => m.mae)),
    spearman: mean(list.map((m) => m.spearman)),
    top1: mean(list.map((m) => m.top1)),
    top3: mean(list.map((m) => m.top3)),
    ghosts: mean(list.map((m) => m.ghosts)),
    missed: mean(list.map((m) => m.missed)),
    parentWins: mean(list.map((m) => m.parentWins)),
    childTop5: mean(list.map((m) => m.childTop5)),
    top1Share: mean(list.map((m) => m.top1Share)),
});
const fmtPresence = (m: PresenceRow): string =>
    `MAE=${pct(m.mae)}pp ρ=${m.spearman.toFixed(2)} top1=${pct(m.top1)} child@5=${pct(m.childTop5)} parentWins=${pct(m.parentWins)} topShare=${pct(m.top1Share)} ghosts=${m.ghosts.toFixed(2)}`;

const bootstrapInterval = (values: readonly number[]): [number, number] => {
    const random = mulberry32(7);
    const samples: number[] = [];
    for (let i = 0; i < 4000; i++) {
        samples.push(mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)));
    }
    samples.sort((a, b) => a - b);
    return [samples[Math.floor(0.025 * samples.length)]!, samples[Math.floor(0.975 * samples.length)]!];
};

// ---------------------------------------------------------------------------
// 1. Tagged drowning (no CLIP) — this is the dropdown if every photo is tagged
// ---------------------------------------------------------------------------

const runDrowning = (): { kits: Kit[]; pairs: { parent: number; child: number }[] } => {
    const { raw, photos } = loadCorpus(PRESENCE_CORPUS);
    const kits = savedKitsOf(raw, photos);
    const pairs = nestedPairsOf(kits);
    const tagCounts = kits.map((kit) => kit.tags.length);
    const andCounts = kits.map((kit) => kit.andIds.length);
    const exactCounts = kits.map((kit) => kit.exactIds.length);
    console.log("\n############ DROPDOWN DROWNING (tagged truth, presence corpus) ############");
    console.log(`photos=${photos.length} saved kits=${kits.length} nested pairs=${pairs.length}`);
    console.log(
        `AND vs ONLY list Spearman ρ=${spearman(andCounts, exactCounts).toFixed(3)}`,
    );
    const andOrder = ranksByCount(andCounts, tagCounts);
    const exactOrder = ranksByCount(exactCounts, tagCounts);
    console.log(
        `AND top5: ${andOrder.slice(0, 5).map((i) => `${kits[i]!.id}:${andCounts[i]}`).join("  ")}`,
    );
    console.log(
        `ONLY top5: ${exactOrder.slice(0, 5).map((i) => `${kits[i]!.id}:${exactCounts[i]}`).join("  ")}`,
    );
    console.log("\nkit  arity  AND  exact  extras%  AND-rank  ONLY-rank");
    const andRank = new Map(andOrder.map((i, r) => [i, r + 1]));
    const exactRank = new Map(exactOrder.map((i, r) => [i, r + 1]));
    for (let k = 0; k < kits.length; k++) {
        const kit = kits[k]!;
        const extras = kit.andIds.length - kit.exactIds.length;
        console.log(
            `${kit.id.padEnd(8)} ${String(kit.tags.length).padStart(5)}  ${String(kit.andIds.length).padStart(4)}  ${String(kit.exactIds.length).padStart(5)}  ${((100 * extras) / kit.andIds.length).toFixed(1).padStart(7)}  ${String(andRank.get(k)).padStart(8)}  ${String(exactRank.get(k)).padStart(9)}`,
        );
    }
    console.log("\nnested pairs (parent tags ⊂ child tags):");
    console.log("parent  child   AND p/c   ONLY p/c   AND parent always ≥ child?");
    let andParentWins = 0;
    let onlyChildWins = 0;
    for (const pair of pairs) {
        const pAnd = andCounts[pair.parent]!;
        const cAnd = andCounts[pair.child]!;
        const pOnly = exactCounts[pair.parent]!;
        const cOnly = exactCounts[pair.child]!;
        if (pAnd >= cAnd) {
            andParentWins += 1;
        }
        if (cOnly > pOnly) {
            onlyChildWins += 1;
        }
        console.log(
            `${kits[pair.parent]!.id.padEnd(8)} ${kits[pair.child]!.id.padEnd(8)} ${pAnd}/${cAnd}`.padEnd(28) +
                ` ${pOnly}/${cOnly}`.padEnd(14) +
                ` ${pAnd >= cAnd ? "yes" : "NO"}`,
        );
    }
    console.log(
        `\nAND: parent outranks child in ${andParentWins}/${pairs.length} pairs (by construction, extras of the child count for the parent).`,
    );
    console.log(
        `ONLY: child outranks parent in ${onlyChildWins}/${pairs.length} pairs (specific combo can beat the broad parent).`,
    );
    return { kits, pairs };
};

// ---------------------------------------------------------------------------
// 2. Presence estimators for ONLY truth
// ---------------------------------------------------------------------------

type View = { kind: string; photos: Photo[] };

const buildViews = (
    photos: readonly Photo[],
    kits: readonly Kit[],
    allTags: readonly string[],
    testIds: ReadonlySet<number>,
    seed: number,
): View[] => {
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

const runPresenceSearch = (): void => {
    const { raw, photos, allTags } = loadCorpus(PRESENCE_CORPUS);
    const kits = savedKitsOf(raw, photos);
    const pairs = nestedPairsOf(kits);
    const tagCounts = kits.map((kit) => kit.tags.length);
    const tagIndex = new Map(allTags.map((tag, i) => [tag, i]));
    const groups = duplicateGroupsOf(photos);
    const K = kits.length;

    type Estimator = { name: string; score: (photo: Photo) => Float64Array; soft: boolean };
    const rows = new Map<string, PresenceRow[]>();

    const evaluate = (name: string, views: readonly View[], score: (photo: Photo) => Float64Array, soft: boolean): void => {
        for (const view of views) {
            const truth = kits.map(
                (kit) => view.photos.filter((photo) => isExact(photo.tags, kit.tags)).length / view.photos.length,
            );
            const estimated = new Array<number>(K).fill(0);
            for (const photo of view.photos) {
                const s = score(photo);
                for (let k = 0; k < K; k++) {
                    estimated[k]! += soft ? s[k]! : s[k]! >= 0.5 ? 1 : 0;
                }
            }
            for (let k = 0; k < K; k++) {
                estimated[k]! /= view.photos.length;
            }
            rows.set(name, [...(rows.get(name) ?? []), presenceOf(estimated, truth, tagCounts, pairs)]);
        }
    };

    // Search on seed 42; confirm the shortlist later in the same loop by recording all seeds for a few.
    const seeds = [DEV_SEED, ...CONFIRM_SEEDS];
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
        const kitExactLabels = kits.map((kit) =>
            Uint8Array.from(train, (photo) => (isExact(photo.tags, kit.tags) ? 1 : 0)));
        const kitExactNatural = kits.map((_, k) =>
            trainLogistic(z, kitExactLabels[k]!, whitening, "natural"));
        const views = buildViews(photos, kits, allTags, testIds, seed);

        const tagP = (photo: Photo): number[] =>
            tagBalanced.map((model, t) => sigmoid(logOdds(model, photo) + tagShift[t]!));

        const estimators: Estimator[] = [
            {
                name: "AND product @0.5 (shipped, vs ONLY truth)",
                soft: true,
                score: (photo) => {
                    const p = tagP(photo);
                    return Float64Array.from(kits, (kit) =>
                        kit.tags.reduce((acc, tag) => acc * p[tagIndex.get(tag)!]!, 1));
                },
            },
            {
                name: "AND product @0.5 hardened",
                soft: false,
                score: (photo) => {
                    const p = tagP(photo);
                    return Float64Array.from(kits, (kit) =>
                        kit.tags.reduce((acc, tag) => acc * p[tagIndex.get(tag)!]!, 1));
                },
            },
        ];
        for (const theta of [0.4, 0.5, 0.6]) {
            estimators.push({
                name: `exact-set @${theta}`,
                soft: true,
                score: (photo) => {
                    const p = tagP(photo);
                    const predicted = new Set(allTags.filter((_, t) => p[t]! >= theta));
                    return Float64Array.from(kits, (kit) =>
                        predicted.size === kit.tags.length && kit.tags.every((tag) => predicted.has(tag)) ?
                            1 :
                            0);
                },
            });
        }
        for (const thetaIn of [0.5]) {
            for (const thetaOut of [0.4, 0.5, 0.6]) {
                estimators.push({
                    name: `exclusive-hard in${thetaIn} out${thetaOut}`,
                    soft: true,
                    score: (photo) => {
                        const p = tagP(photo);
                        return Float64Array.from(kits, (kit) => {
                            const kitSet = new Set(kit.tags);
                            const inOk = kit.tags.every((tag) => p[tagIndex.get(tag)!]! >= thetaIn);
                            const outOk = allTags.every((tag) =>
                                kitSet.has(tag) || p[tagIndex.get(tag)!]! < thetaOut);
                            return inOk && outOk ? 1 : 0;
                        });
                    },
                });
            }
        }
        estimators.push({
            name: "exclusive-product (indep. P(set=kit))",
            soft: true,
            score: (photo) => {
                const p = tagP(photo);
                return Float64Array.from(kits, (kit) => {
                    const kitSet = new Set(kit.tags);
                    let value = 1;
                    for (const tag of allTags) {
                        const pt = p[tagIndex.get(tag)!]!;
                        value *= kitSet.has(tag) ? pt : 1 - pt;
                    }
                    return value;
                });
            },
        });
        estimators.push({
            name: "exclusive-product @0.05 hardened",
            soft: true,
            score: (photo) => {
                const p = tagP(photo);
                return Float64Array.from(kits, (kit) => {
                    const kitSet = new Set(kit.tags);
                    let value = 1;
                    for (const tag of allTags) {
                        const pt = p[tagIndex.get(tag)!]!;
                        value *= kitSet.has(tag) ? pt : 1 - pt;
                    }
                    return value >= 0.05 ? 1 : 0;
                });
            },
        });
        estimators.push({
            name: "kit logistic exact (natural)",
            soft: true,
            score: (photo) =>
                Float64Array.from(kitExactNatural, (model) => sigmoid(logOdds(model, photo))),
        });
        estimators.push({
            name: "kit logistic exact @0.5",
            soft: false,
            score: (photo) =>
                Float64Array.from(kitExactNatural, (model) => sigmoid(logOdds(model, photo))),
        });

        for (const estimator of estimators) {
            evaluate(estimator.name, views, estimator.score, estimator.soft);
        }
        console.log(`presence seed=${seed} ${((Date.now() - started) / 1000).toFixed(0)}s views=${views.length}`);
    }

    console.log("\n############ PRESENCE vs ONLY truth (5 seeds, app-like views) ############");
    console.log("parentWins = nested parent estimated > child (AND is ~100% by construction)");
    console.log("child@5 = recall of arity≥2 kits that are truly in the exact top-5");
    const ranked = [...rows.entries()]
        .map(([name, list]) => ({ name, m: averagePresence(list) }))
        .sort((a, b) => b.m.childTop5 - a.m.childTop5 || b.m.spearman - a.m.spearman);
    for (const row of ranked) {
        console.log(`${row.name.padEnd(48)} ${fmtPresence(row.m)}`);
    }
};

// ---------------------------------------------------------------------------
// 3. Ranking retune: extras-vs-exact direction + exclusivity gene + GA
// ---------------------------------------------------------------------------

type KitTerms = {
    kit: Kit;
    testPos: number[];
    testHard: number[];
    testEasy: number[];
    extraMaskById: Set<number>;
    selSim: Float32Array;
    stealNum: Float32Array;
    stealDen: Float32Array;
    hardPartial: Float32Array;
    hardExtra: Float32Array;
    tagMin: Float32Array;
    extraMax: Float32Array;
    sigma: number[];
};

const buildKitTerms = (
    photos: readonly Photo[],
    photoById: ReadonlyMap<number, Photo>,
    kits: readonly Kit[],
    allTags: readonly string[],
    tagIndex: ReadonlyMap<string, number>,
    trainIds: ReadonlySet<number>,
    testIds: ReadonlySet<number>,
    tagLogOdds: Float64Array,
    whitening: { lower: Float64Array },
): KitTerms[] => {
    const trainPhotos = photos.filter((photo) => trainIds.has(photo.id));
    const rivalCentroids = kits
        .map((kit) => {
            const centroid = centroidOf(
                kit.exactIds.filter((id) => trainIds.has(id)),
                photoById,
                SEED_CAP,
            );
            return centroid ? { id: kit.id, tagsKey: comboKey(kit.tags), centroid } : undefined;
        })
        .filter((r): r is { id: string; tagsKey: string; centroid: Float64Array } => Boolean(r));

    const out: KitTerms[] = [];
    for (const kit of kits) {
        const selectedIds = kit.exactIds.filter((id) => trainIds.has(id));
        const partialIds = trainPhotos
            .filter((photo) => !hasAll(photo.tags, kit.tags) && sharesAny(photo.tags, kit.tags))
            .map((photo) => photo.id);
        const extraIds = trainPhotos
            .filter((photo) => hasAll(photo.tags, kit.tags) && !isExact(photo.tags, kit.tags))
            .map((photo) => photo.id);
        const selected = centroidOf(selectedIds, photoById, SEED_CAP);
        const partial = centroidOf(partialIds, photoById);
        const extra = centroidOf(extraIds, photoById);
        const tagIndices = kit.tags.map((tag) => tagIndex.get(tag)!);
        const otherTags = allTags.filter((tag) => !kit.tags.includes(tag));
        if (!selected || selectedIds.length < MIN_TRAIN_POSITIVES || tagIndices.some((t) => t === undefined)) {
            continue;
        }
        const hardPartialDir = partial ?
            choleskySolve(whitening.lower, difference(selected, partial)) :
            new Float64Array(DIM);
        const hardExtraDir = extra ?
            choleskySolve(whitening.lower, difference(selected, extra)) :
            new Float64Array(DIM);
        const rivalIdx: number[] = [];
        const rivalDist: number[] = [];
        rivalCentroids.forEach((rival, r) => {
            if (rival.id === kit.id || rival.tagsKey === comboKey(kit.tags)) {
                return;
            }
            rivalIdx.push(r);
            rivalDist.push(1 - dot(selected, rival.centroid));
        });

        const n = photos.length;
        const selSim = new Float32Array(n);
        const stealNum = new Float32Array(n);
        const stealDen = new Float32Array(n);
        const hardPartial = new Float32Array(n);
        const hardExtra = new Float32Array(n);
        const tagMinA = new Float32Array(n);
        const extraMax = new Float32Array(n);
        for (const photo of photos) {
            const i = photo.index;
            const selectedSimilarity = dot(photo.vector, selected);
            selSim[i] = selectedSimilarity;
            let bestNum = 0;
            let bestDen = 1;
            let bestWeighted = -1;
            for (let r = 0; r < rivalIdx.length; r++) {
                const sim = dot(photo.vector, rivalCentroids[rivalIdx[r]!]!.centroid);
                const gap = Math.max(0, sim - selectedSimilarity);
                const dist = rivalDist[r]!;
                // steal(τ) = gap * dist/(dist+τ); store so steal = num/(den+τ) is wrong.
                // Keep gap and dist: steal = gap * dist/(dist+τ). Max over rivals depends on τ.
                // Store the rival that wins at τ=0.02 as an approximation? Better store all — too big.
                // Precompute steal at a few τ later. For GA, compute max on the fly from a packed list.
                const weighted = gap * dist;
                if (weighted > bestWeighted) {
                    bestWeighted = weighted;
                    bestNum = gap * dist;
                    bestDen = dist;
                }
            }
            stealNum[i] = bestNum;
            stealDen[i] = bestDen;
            hardPartial[i] = dot(photo.vector, hardPartialDir);
            hardExtra[i] = extra ? dot(photo.vector, hardExtraDir) : 0;
            const tagRow = i * allTags.length;
            let tmin = Number.POSITIVE_INFINITY;
            for (const t of tagIndices) {
                tmin = Math.min(tmin, tagLogOdds[tagRow + t]!);
            }
            tagMinA[i] = tmin;
            let xmax = Number.NEGATIVE_INFINITY;
            for (const tag of otherTags) {
                xmax = Math.max(xmax, tagLogOdds[tagRow + tagIndex.get(tag)!]!);
            }
            extraMax[i] = Number.isFinite(xmax) ? xmax : 0;
        }

        const sums = [0, 0, 0, 0, 0];
        const squares = [0, 0, 0, 0, 0];
        for (const photo of trainPhotos) {
            const i = photo.index;
            const steal = stealDen[i]! > 0 ? stealNum[i]! / (stealDen[i]! + 0.02) : 0;
            const t = [
                selSim[i]! - 16 * steal,
                hardPartial[i]!,
                hardExtra[i]!,
                tagMinA[i]!,
                -extraMax[i]!,
            ];
            for (let c = 0; c < 5; c++) {
                sums[c]! += t[c]!;
                squares[c]! += t[c]! * t[c]!;
            }
        }
        const sigma = sums.map((sum, c) => {
            const m = sum / trainPhotos.length;
            return Math.sqrt(Math.max(0, squares[c]! / trainPhotos.length - m * m)) || 1;
        });

        const testPos = kit.exactIds.filter((id) => testIds.has(id));
        const testHard: number[] = [];
        const testEasy: number[] = [];
        const extraMaskById = new Set<number>();
        for (const photo of photos) {
            if (!testIds.has(photo.id) || isExact(photo.tags, kit.tags)) {
                continue;
            }
            if (sharesAny(photo.tags, kit.tags)) {
                testHard.push(photo.id);
                if (hasAll(photo.tags, kit.tags)) {
                    extraMaskById.add(photo.id);
                }
            } else {
                testEasy.push(photo.id);
            }
        }
        if (
            testPos.length < MIN_TEST_POSITIVES ||
            testHard.length < MIN_TEST_HARD ||
            testEasy.length < MIN_TEST_EASY
        ) {
            continue;
        }
        out.push({
            kit,
            testPos,
            testHard,
            testEasy,
            extraMaskById,
            selSim,
            stealNum,
            stealDen,
            hardPartial,
            hardExtra,
            tagMin: tagMinA,
            extraMax,
            sigma,
        });
    }
    return out;
};

const scorePhoto = (terms: KitTerms, photo: Photo, g: Genes): number => {
    const i = photo.index;
    const steal = terms.stealDen[i]! > 0 ? terms.stealNum[i]! / (terms.stealDen[i]! + g.tau) : 0;
    const prod = terms.selSim[i]! - g.lambda * steal;
    return (
        prod / terms.sigma[0]! +
        (g.hPartial * terms.hardPartial[i]!) / terms.sigma[1]! +
        (g.hExtra * terms.hardExtra[i]!) / terms.sigma[2]! +
        (g.tTag * terms.tagMin[i]!) / terms.sigma[3]! +
        (g.xExcl * -terms.extraMax[i]!) / terms.sigma[4]!
    );
};

const evalGenes = (kitTerms: readonly KitTerms[], photoById: ReadonlyMap<number, Photo>, g: Genes): Metrics => {
    const rows: Metrics[] = [];
    for (const terms of kitTerms) {
        const ids = [...terms.testPos, ...terms.testHard, ...terms.testEasy];
        const labels = Uint8Array.from([
            ...terms.testPos.map(() => 0),
            ...terms.testHard.map(() => 1),
            ...terms.testEasy.map(() => 2),
        ]);
        const extraMask = Uint8Array.from(ids, (id) => (terms.extraMaskById.has(id) ? 1 : 0));
        const scores = Float64Array.from(ids, (id) => scorePhoto(terms, photoById.get(id)!, g));
        rows.push(metricsOf(labels, scores, extraMask));
    }
    return averageMetrics(rows);
};

const clampGenes = (g: Genes): Genes => ({
    lambda: Math.min(32, Math.max(0, g.lambda)),
    tau: Math.min(0.24, Math.max(0.005, g.tau)),
    hPartial: Math.min(6, Math.max(0, g.hPartial)),
    hExtra: Math.min(8, Math.max(0, g.hExtra)),
    tTag: Math.min(10, Math.max(0, g.tTag)),
    xExcl: Math.min(8, Math.max(0, g.xExcl)),
});

const runRankingTune = (): void => {
    const { raw, photos, photoById, allTags } = loadCorpus(RANKING_CORPUS);
    const kits = savedKitsOf(raw, photos).filter((kit) => kit.exactIds.length >= MIN_KIT_MEMBERS);
    const tagIndex = new Map(allTags.map((tag, i) => [tag, i]));
    const groups = duplicateGroupsOf(photos);

    console.log("\n############ RANKING ONLY retune (exact members, extras are hard negs) ############");
    console.log(`saved kits with ≥${MIN_KIT_MEMBERS} exact members: ${kits.length}`);

    const [trainIds, testIds] = splitByGroups(photos, groups, DEV_SEED);
    const trainPhotos = photos.filter((photo) => trainIds.has(photo.id));
    const whitening = whiteningOf(trainPhotos);
    const z = trainPhotos.map((photo) =>
        forwardSolve(whitening.lower, difference(photo.vector, whitening.mu)));
    const tagLogOdds = new Float64Array(photos.length * allTags.length);
    allTags.forEach((tag, t) => {
        const labels = Uint8Array.from(trainPhotos, (photo) => (photo.tags.has(tag) ? 1 : 0));
        const model = trainLogistic(z, labels, whitening, "balanced");
        for (const photo of photos) {
            tagLogOdds[photo.index * allTags.length + t] = logOdds(model, photo);
        }
    });
    const kitTerms = buildKitTerms(
        photos,
        photoById,
        kits,
        allTags,
        tagIndex,
        trainIds,
        testIds,
        tagLogOdds,
        whitening,
    );
    console.log(`dev folds=${kitTerms.length} (seed 42)`);

    const baseline = evalGenes(kitTerms, photoById, shippedOnlyGenes());
    console.log(`shipped AND-genes on ONLY task: ${fmtMetrics(baseline)}`);

    // Grid: extra-vs-exact and exclusivity are the new genes.
    const grid: Genes[] = [];
    for (const lambda of [8, 16, 24]) {
        for (const tau of [0.02, 0.06]) {
            for (const hPartial of [0, 1.5, 3]) {
                for (const hExtra of [0, 1.5, 3, 5]) {
                    for (const tTag of [2, 4, 6]) {
                        for (const xExcl of [0, 2, 4]) {
                            grid.push({ lambda, tau, hPartial, hExtra, tTag, xExcl });
                        }
                    }
                }
            }
        }
    }
    let bestGrid = shippedOnlyGenes();
    let bestGridM = baseline;
    let bestGridFit = firstScreen(baseline);
    const started = Date.now();
    for (const g of grid) {
        const m = evalGenes(kitTerms, photoById, g);
        const fit = firstScreen(m);
        if (fit > bestGridFit) {
            bestGrid = g;
            bestGridM = m;
            bestGridFit = fit;
        }
    }
    console.log(
        `grid ${grid.length} cells ${(Date.now() - started) / 1000 | 0}s  best ${geneKey(bestGrid)}  ${fmtMetrics(bestGridM)}  Δ@12=${pct(bestGridM.hardTop12 - baseline.hardTop12)}pp`,
    );

    // GA over the same 6 genes, first-screen fitness, train fold only.
    const runGa = (seed: number): { g: Genes; m: Metrics } => {
        const random = mulberry32(seed);
        const randG = (): Genes =>
            clampGenes({
                lambda: random() * 32,
                tau: 0.005 + random() * 0.235,
                hPartial: random() * 6,
                hExtra: random() * 8,
                tTag: random() * 10,
                xExcl: random() * 8,
            });
        const mix = (a: Genes, b: Genes): Genes =>
            clampGenes({
                lambda: random() < 0.5 ? a.lambda : b.lambda,
                tau: random() < 0.5 ? a.tau : b.tau,
                hPartial: random() < 0.5 ? a.hPartial : b.hPartial,
                hExtra: random() < 0.5 ? a.hExtra : b.hExtra,
                tTag: random() < 0.5 ? a.tTag : b.tTag,
                xExcl: random() < 0.5 ? a.xExcl : b.xExcl,
            });
        const mutate = (g: Genes): Genes => {
            const n = { ...g };
            const keys = ["lambda", "tau", "hPartial", "hExtra", "tTag", "xExcl"] as const;
            for (const key of keys) {
                if (random() < 0.3) {
                    const scale = key === "tau" ? 0.04 : key === "lambda" ? 4 : 1.2;
                    n[key] = n[key] + (random() * 2 - 1) * scale;
                }
            }
            return clampGenes(n);
        };
        const popSize = 28;
        const gens = 20;
        let pop: { g: Genes; m: Metrics; fit: number }[] = [];
        const seedPop = [
            shippedOnlyGenes(),
            bestGrid,
            { lambda: 16, tau: 0.02, hPartial: 0, hExtra: 3, tTag: 4, xExcl: 2 },
            { lambda: 24, tau: 0.02, hPartial: 1.5, hExtra: 4, tTag: 6, xExcl: 4 },
        ];
        for (const g of seedPop) {
            const m = evalGenes(kitTerms, photoById, g);
            pop.push({ g, m, fit: firstScreen(m) });
        }
        while (pop.length < popSize) {
            const g = randG();
            const m = evalGenes(kitTerms, photoById, g);
            pop.push({ g, m, fit: firstScreen(m) });
        }
        pop.sort((a, b) => b.fit - a.fit);
        for (let gen = 0; gen < gens; gen++) {
            const next = pop.slice(0, 2);
            while (next.length < popSize) {
                const a = pop[Math.floor(random() * 8)]!;
                const b = pop[Math.floor(random() * 8)]!;
                const g = mutate(mix(a.g, b.g));
                const m = evalGenes(kitTerms, photoById, g);
                next.push({ g, m, fit: firstScreen(m) });
            }
            pop = next.sort((a, b) => b.fit - a.fit);
        }
        return { g: pop[0]!.g, m: pop[0]!.m };
    };

    const gaA = runGa(11);
    const gaB = runGa(29);
    const gaBest = firstScreen(gaA.m) >= firstScreen(gaB.m) ? gaA : gaB;
    console.log(`GA best ${geneKey(gaBest.g)}  ${fmtMetrics(gaBest.m)}`);

    const candidates: { name: string; g: Genes }[] = [
        { name: "shipped AND-genes", g: shippedOnlyGenes() },
        { name: "grid-best", g: bestGrid },
        { name: "GA-best", g: gaBest.g },
        { name: "extra-only hE3 t4", g: { lambda: 16, tau: 0.02, hPartial: 0, hExtra: 3, tTag: 4, xExcl: 0 } },
        { name: "excl-tag x4", g: { lambda: 16, tau: 0.02, hPartial: 1.5, hExtra: 0, tTag: 4, xExcl: 4 } },
    ];

    console.log("\n--- confirmation (seeds 99/123/2024/7) ---");
    const confirm = new Map<string, Metrics[]>();
    for (const seed of CONFIRM_SEEDS) {
        const startedSeed = Date.now();
        const [cTrain, cTest] = splitByGroups(photos, groups, seed);
        const cTrainPhotos = photos.filter((photo) => cTrain.has(photo.id));
        const cWhitening = whiteningOf(cTrainPhotos);
        const cz = cTrainPhotos.map((photo) =>
            forwardSolve(cWhitening.lower, difference(photo.vector, cWhitening.mu)));
        const cLogOdds = new Float64Array(photos.length * allTags.length);
        allTags.forEach((tag, t) => {
            const labels = Uint8Array.from(cTrainPhotos, (photo) => (photo.tags.has(tag) ? 1 : 0));
            const model = trainLogistic(cz, labels, cWhitening, "balanced");
            for (const photo of photos) {
                cLogOdds[photo.index * allTags.length + t] = logOdds(model, photo);
            }
        });
        const cTerms = buildKitTerms(
            photos,
            photoById,
            kits,
            allTags,
            tagIndex,
            cTrain,
            cTest,
            cLogOdds,
            cWhitening,
        );
        for (const cand of candidates) {
            confirm.set(cand.name, [...(confirm.get(cand.name) ?? []), evalGenes(cTerms, photoById, cand.g)]);
        }
        console.log(`confirm seed=${seed} ${((Date.now() - startedSeed) / 1000).toFixed(0)}s folds=${cTerms.length}`);
    }
    const shippedRows = confirm.get("shipped AND-genes")!;
    for (const cand of candidates) {
        const list = confirm.get(cand.name)!;
        const avg = averageMetrics(list);
        const delta = list.map((row, i) => row.hardTop12 - shippedRows[i]!.hardTop12);
        const [lo, hi] = bootstrapInterval(delta);
        console.log(
            `${cand.name.padEnd(24)} ${fmtMetrics(avg)}  Δ@12=${(mean(delta) * 100).toFixed(1)}pp [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  ${geneKey(cand.g)}`,
        );
    }
};

console.log("ONLY kit likeness: drowning + presence search + ranking GA");
console.log("Task: exact tag-set members. Extras (kit tags + more) are hard negatives.");
runDrowning();
runPresenceSearch();
runRankingTune();
