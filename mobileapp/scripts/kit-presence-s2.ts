/**
 * Kit presence ("kit likeness" list): how well does each per-photo kit score
 * estimate which kits are present in a set of photos, and how much of it?
 *
 * Production today (`rankKitsByBestFitShareEmbedding`): winner-takes-all —
 * every embedded photo counts for the one kit whose nearest CLIP medoid is
 * closest, share = wins / scored. Compared here against soft and calibrated
 * alternatives, on views that mimic the app (whole set, tag-filtered,
 * kit-filtered, contiguous id windows), using the tag labels as truth.
 *
 * Leakage-free: dHash duplicate groups stay on one side of a 60/40 split;
 * medoids, thresholds and detectors come from the training side only and
 * every evaluated view is drawn from the test side.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-presence-s2.ts
 */
import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    kitEmbeddingMinDistance,
    pickKitEmbeddingMedoids,
} from "../src/lib/kit-nearness-sort";
import {
    runStage1ClusteringSync,
    type Stage1Item,
} from "../src/lib/similarity-stage1-core";

const CORPUS_PATH = "C:/Users/Elliot/Downloads/kit-nearness-corpus (3).json";

const DIM = 512;
const MIN_KIT_MEMBERS = 20;
const TRAIN_FRACTION = 0.6;
const DUPLICATE_HAMMING_THRESHOLD = 6;
const DEVELOPMENT_SEED = 42;
const CONFIRMATION_SEEDS = [99, 123, 2024, 7] as const;
const WINDOW_SIZE = 60;
const RANDOM_VIEWS = 30;

/** Shipped pass-5 detector settings (`kit-nearness-margins.ts`). */
const SHRINKAGE = 1;
const LR_L2 = 0.01;
const LR_ITERATIONS = 100;
const LR_LEARNING_RATE = 0.1;
const SOFT_TAUS = [0.02, 0.05, 0.1] as const;

/** Display-failure thresholds: a kit shown ≥ this while truly < GHOST_TRUE is a ghost … */
const GHOST_SHOWN = 0.1;
const GHOST_TRUE = 0.02;
/** … and a kit truly ≥ MISSED_TRUE shown < MISSED_SHOWN is missed. */
const MISSED_TRUE = 0.3;
const MISSED_SHOWN = 0.1;

type SourcePhoto = AnonymisedKitNearnessCorpus["photos"][number];

type Photo = {
    id: number;
    index: number;
    tags: ReadonlySet<string>;
    vector: number[];
    hashes: string[];
};

type Kit = { id: string; tags: string[]; memberIds: Set<number> };

/** kit index → probability-like presence score for one photo. */
type Scorer = {
    name: string;
    /** Sums to 1 over kits by construction (winner-takes-all, softmax). */
    partition: boolean;
    score: (photo: Photo) => Float64Array;
};

type View = { kind: string; photos: Photo[] };

type ViewMetrics = {
    /** Mean |estimate − truth| over kits, in probability units. */
    mae: number;
    /** Same, kits with true prevalence ≥ 10% only (NaN when none). */
    maeMajor: number;
    spearman: number;
    top1: number;
    top3: number;
    ghosts: number;
    missed: number;
};

// ---------------------------------------------------------------------------
// Helpers
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

const mean = (values: readonly number[]): number => {
    const kept = values.filter((value) => Number.isFinite(value));
    return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : Number.NaN;
};

const hasAll = (tags: ReadonlySet<string>, kitTags: readonly string[]): boolean =>
    kitTags.length > 0 && kitTags.every((tag) => tags.has(tag));

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

const pct = (value: number): string => (value * 100).toFixed(1);

/** Average ranks (ties share the mean rank). */
const ranks = (values: readonly number[]): number[] => {
    const order = values.map((value, i) => i).sort((a, b) => values[b]! - values[a]! || a - b);
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

// ---------------------------------------------------------------------------
// Corpus, kits, duplicate groups, split
// ---------------------------------------------------------------------------

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnonymisedKitNearnessCorpus;
const photos: Photo[] = [];
for (const source of raw.photos as SourcePhoto[]) {
    if (source.embedding?.length !== DIM) {
        continue;
    }
    const norm = Math.hypot(...source.embedding) || 1;
    photos.push({
        id: source.id,
        index: photos.length,
        tags: new Set(source.tags),
        vector: source.embedding.map((value) => value / norm),
        hashes: source.hashes,
    });
}
const embeddings = new Map(photos.map((photo) => [photo.id, photo.vector]));
const allTags = [...new Set(photos.flatMap((photo) => [...photo.tags]))].sort();

/** Saved presets with enough members to evaluate (single-tag kits included, as in the app). */
const kits: Kit[] = raw.kits
    .map((saved) => ({
        id: saved.id,
        tags: [...saved.tags].sort(),
        memberIds: new Set(
            photos.filter((photo) => hasAll(photo.tags, saved.tags)).map((photo) => photo.id),
        ),
    }))
    .filter((kit) => kit.tags.length > 0 && kit.memberIds.size >= MIN_KIT_MEMBERS)
    .sort((a, b) => a.id.localeCompare(b.id));
const K = kits.length;

const duplicateGroups = ((): number[][] => {
    const hashedItems: Stage1Item[] = photos
        .filter((photo) => photo.hashes.length > 0)
        .map((photo) => ({ fileId: photo.id, hashes: photo.hashes }));
    const grouped = new Set<number>();
    const groups: number[][] = [];
    for (const cluster of runStage1ClusteringSync(hashedItems, DUPLICATE_HAMMING_THRESHOLD)) {
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

const splitByGroups = (seed: number): [Set<number>, Set<number>] => {
    const groups = duplicateGroups.map((group) => [...group]);
    shuffleInPlace(groups, mulberry32(seed));
    const target = Math.floor(photos.length * TRAIN_FRACTION);
    const train = new Set<number>();
    const test = new Set<number>();
    for (const group of groups) {
        group.forEach((id) => (train.size < target ? train : test).add(id));
    }
    return [train, test];
};

// ---------------------------------------------------------------------------
// Whitening + logistic regression (single rows; mirrors the shipped trainer)
// ---------------------------------------------------------------------------

type Whitening = { mu: Float64Array; lower: Float64Array };

const cholesky = (matrix: Float64Array): Float64Array => {
    const lower = new Float64Array(DIM * DIM);
    for (let i = 0; i < DIM; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = matrix[i * DIM + j]!;
            for (let k = 0; k < j; k++) {
                sum -= lower[i * DIM + k]! * lower[j * DIM + k]!;
            }
            lower[i * DIM + j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / lower[j * DIM + j]!;
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

const whiteningOf = (rows: readonly Photo[]): Whitening => {
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

const whitenRows = (rows: readonly Photo[], whitening: Whitening): Float64Array[] =>
    rows.map((photo) => {
        const centred = new Float64Array(DIM);
        for (let i = 0; i < DIM; i++) {
            centred[i] = photo.vector[i]! - whitening.mu[i]!;
        }
        return forwardSolve(whitening.lower, centred);
    });

/** Log-odds(x) = x·weights + offset in original coordinates. */
type LogisticModel = { weights: Float64Array; offset: number };

/**
 * Whitened logistic regression, Adam, L2. `balanced` reweights classes to
 * 50/50 as the shipped trainer does; `natural` keeps the training prior, which
 * is what a prevalence estimate needs.
 */
const trainLogistic = (
    z: readonly Float64Array[],
    labels: Uint8Array,
    whitening: Whitening,
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
            const g = ((labels[i] ? positiveWeight : negativeWeight) * (sigmoid(logit) - labels[i]!)) / n;
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
            const step = (LR_LEARNING_RATE * (m[d]! / correction1)) / (Math.sqrt(v[d]! / correction2) + 1e-8);
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

/** 1-D logistic on a scalar feature (distance), natural prior, Newton steps. */
const trainScalarLogistic = (
    features: readonly number[],
    labels: Uint8Array,
): { slope: number; intercept: number } => {
    const featureMean = mean(features);
    const featureStd = Math.sqrt(mean(features.map((f) => (f - featureMean) ** 2))) || 1;
    const x = features.map((f) => (f - featureMean) / featureStd);
    let a = 0;
    let b = 0;
    for (let iteration = 0; iteration < 25; iteration++) {
        let g0 = 0;
        let g1 = 0;
        let h00 = 1e-6;
        let h01 = 0;
        let h11 = 1e-6;
        for (let i = 0; i < x.length; i++) {
            const p = sigmoid(a * x[i]! + b);
            const r = p - labels[i]!;
            const wgt = p * (1 - p);
            g0 += r * x[i]!;
            g1 += r;
            h00 += wgt * x[i]! * x[i]!;
            h01 += wgt * x[i]!;
            h11 += wgt;
        }
        const det = h00 * h11 - h01 * h01 || 1e-9;
        a -= (h11 * g0 - h01 * g1) / det;
        b -= (h00 * g1 - h01 * g0) / det;
    }
    return { slope: a / featureStd, intercept: b - (a * featureMean) / featureStd };
};

// ---------------------------------------------------------------------------
// Train-side models → per-photo kit scorers
// ---------------------------------------------------------------------------

const buildScorers = (trainIds: ReadonlySet<number>): Scorer[] => {
    const train = photos.filter((photo) => trainIds.has(photo.id));
    const kitLabels = kits.map((kit) => Uint8Array.from(train, (photo) => (kit.memberIds.has(photo.id) ? 1 : 0)));

    // Production medoids from training members only.
    const medoidsByKit = kits.map((kit) =>
        pickKitEmbeddingMedoids(
            train.filter((photo) => kit.memberIds.has(photo.id)).map((photo) => photo.id),
            embeddings,
        ).map((medoid) => medoid.vector),
    );
    const distances = (photo: Photo): Float64Array =>
        Float64Array.from(medoidsByKit, (medoids) => kitEmbeddingMinDistance(photo.id, medoids, embeddings));

    const winnerTakesAll: Scorer = {
        name: "production (nearest medoid)",
        partition: true,
        score: (photo) => {
            const d = distances(photo);
            const out = new Float64Array(K);
            let best = -1;
            for (let k = 0; k < K; k++) {
                if (Number.isFinite(d[k]!) && (best < 0 || d[k]! < d[best]!)) {
                    best = k;
                }
            }
            if (best >= 0) {
                out[best] = 1;
            }
            return out;
        },
    };

    const softmax = (tau: number): Scorer => ({
        name: `softmax τ=${tau}`,
        partition: true,
        score: (photo) => {
            const d = distances(photo);
            const out = new Float64Array(K);
            let total = 0;
            for (let k = 0; k < K; k++) {
                out[k] = Number.isFinite(d[k]!) ? Math.exp(-d[k]! / tau) : 0;
                total += out[k]!;
            }
            return total > 0 ? out.map((value) => value / total) : out;
        },
    });

    // Per-kit calibrated distance: 1-D logistic on the medoid distance.
    const distanceModels = kits.map((_, k) =>
        trainScalarLogistic(
            train.map((photo) => kitEmbeddingMinDistance(photo.id, medoidsByKit[k]!, embeddings)),
            kitLabels[k]!,
        ),
    );
    const distanceLogistic: Scorer = {
        name: "distance logistic",
        partition: false,
        score: (photo) => {
            const d = distances(photo);
            return Float64Array.from(distanceModels, (model, k) =>
                Number.isFinite(d[k]!) ? sigmoid(model.slope * d[k]! + model.intercept) : 0,
            );
        },
    };

    // Whitened detectors: per tag (shipped, balanced, prior-corrected; and natural) and per kit.
    const whitening = whiteningOf(train);
    const z = whitenRows(train, whitening);
    const tagIndex = new Map(allTags.map((tag, t) => [tag, t]));
    const tagLabels = allTags.map((tag) => Uint8Array.from(train, (photo) => (photo.tags.has(tag) ? 1 : 0)));
    const priorShift = (labels: Uint8Array): number => {
        let positives = 0;
        for (const label of labels) {
            positives += label;
        }
        return Math.log(Math.max(positives, 1) / Math.max(labels.length - positives, 1));
    };
    const tagBalanced = allTags.map((_, t) => trainLogistic(z, tagLabels[t]!, whitening, "balanced"));
    const tagShift = allTags.map((_, t) => priorShift(tagLabels[t]!));
    const tagNatural = allTags.map((_, t) => trainLogistic(z, tagLabels[t]!, whitening, "natural"));
    const kitNatural = kits.map((_, k) => trainLogistic(z, kitLabels[k]!, whitening, "natural"));
    const kitBalanced = kits.map((_, k) => trainLogistic(z, kitLabels[k]!, whitening, "balanced"));
    const kitShift = kits.map((_, k) => priorShift(kitLabels[k]!));

    const tagProbabilities = (photo: Photo, models: LogisticModel[], shifts: number[]): number[] =>
        models.map((model, t) => sigmoid(logOdds(model, photo) + shifts[t]!));
    const combineTags = (
        name: string,
        models: LogisticModel[],
        shifts: number[],
        combine: (values: number[]) => number,
    ): Scorer => ({
        name,
        partition: false,
        score: (photo) => {
            const p = tagProbabilities(photo, models, shifts);
            return Float64Array.from(kits, (kit) => combine(kit.tags.map((tag) => p[tagIndex.get(tag)!]!)));
        },
    });
    const product = (values: number[]): number => values.reduce((a, b) => a * b, 1);
    const minimum = (values: number[]): number => Math.min(...values);
    const zeroShift = allTags.map(() => 0);

    const kitDetector = (name: string, models: LogisticModel[], shifts: number[]): Scorer => ({
        name,
        partition: false,
        score: (photo) => Float64Array.from(models, (model, k) => sigmoid(logOdds(model, photo) + shifts[k]!)),
    });

    const hardened = (base: Scorer): Scorer => ({
        name: `${base.name} @0.5`,
        partition: false,
        score: (photo) => base.score(photo).map((p) => (p >= 0.5 ? 1 : 0)),
    });

    const tagProductShipped = combineTags("tag product (shipped, prior-corrected)", tagBalanced, tagShift, product);
    const kitNaturalScorer = kitDetector("kit logistic (natural)", kitNatural, kits.map(() => 0));
    return [
        winnerTakesAll,
        ...SOFT_TAUS.map(softmax),
        distanceLogistic,
        hardened(distanceLogistic),
        combineTags("tag product (shipped, uncorrected)", tagBalanced, zeroShift, product),
        tagProductShipped,
        combineTags("tag min (shipped, prior-corrected)", tagBalanced, tagShift, minimum),
        combineTags("tag product (natural)", tagNatural, zeroShift, product),
        hardened(tagProductShipped),
        kitNaturalScorer,
        kitDetector("kit logistic (balanced, corrected)", kitBalanced, kitShift),
        hardened(kitNaturalScorer),
    ];
};

// ---------------------------------------------------------------------------
// Views and metrics
// ---------------------------------------------------------------------------

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
        const subset = test.filter((photo) => kit.memberIds.has(photo.id));
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

const truePrevalence = (view: View): number[] =>
    kits.map((kit) => view.photos.filter((photo) => kit.memberIds.has(photo.id)).length / view.photos.length);

/** Partition truth: each photo's membership mass split equally over its kits. */
const truePartition = (view: View): number[] => {
    const mass = new Array<number>(K).fill(0);
    for (const photo of view.photos) {
        const members: number[] = kits.map((kit) => (kit.memberIds.has(photo.id) ? 1 : 0));
        const count = members.reduce((a, b) => a + b, 0);
        if (count > 0) {
            members.forEach((member, k) => {
                mass[k]! += member / count;
            });
        }
    }
    const total = mass.reduce((a, b) => a + b, 0);
    return total > 0 ? mass.map((value) => value / total) : mass;
};

const estimate = (scorer: Scorer, view: View): number[] => {
    const sums = new Float64Array(K);
    for (const photo of view.photos) {
        const scores = scorer.score(photo);
        for (let k = 0; k < K; k++) {
            sums[k]! += scores[k]!;
        }
    }
    return [...sums].map((value) => value / view.photos.length);
};

const normalise = (values: readonly number[]): number[] => {
    const total = values.reduce((a, b) => a + b, 0);
    return total > 0 ? values.map((value) => value / total) : [...values];
};

const compare = (estimated: readonly number[], truth: readonly number[]): ViewMetrics => {
    const errors = truth.map((t, k) => Math.abs(estimated[k]! - t));
    const major = truth.map((t, k) => (t >= 0.1 ? errors[k]! : Number.NaN));
    const trueOrder = [...truth.keys()].sort((a, b) => truth[b]! - truth[a]! || kits[b]!.tags.length - kits[a]!.tags.length);
    const estimatedOrder = [...estimated.keys()].sort((a, b) => estimated[b]! - estimated[a]! || kits[b]!.tags.length - kits[a]!.tags.length);
    const maxTruth = truth[trueOrder[0]!]!;
    const top1 = maxTruth > 0 ? (truth[estimatedOrder[0]!]! >= 0.9 * maxTruth ? 1 : 0) : Number.NaN;
    const trueTop3 = new Set(trueOrder.slice(0, 3).filter((k) => truth[k]! > 0));
    const top3 = trueTop3.size ? estimatedOrder.slice(0, 3).filter((k) => trueTop3.has(k)).length / trueTop3.size : Number.NaN;
    let ghosts = 0;
    let missed = 0;
    for (let k = 0; k < K; k++) {
        if (truth[k]! < GHOST_TRUE && estimated[k]! >= GHOST_SHOWN) {
            ghosts += 1;
        }
        if (truth[k]! >= MISSED_TRUE && estimated[k]! < MISSED_SHOWN) {
            missed += 1;
        }
    }
    return { mae: mean(errors), maeMajor: mean(major), spearman: spearman(estimated, truth), top1, top3, ghosts, missed };
};

const averageMetrics = (list: readonly ViewMetrics[]): ViewMetrics => ({
    mae: mean(list.map((m) => m.mae)),
    maeMajor: mean(list.map((m) => m.maeMajor)),
    spearman: mean(list.map((m) => m.spearman)),
    top1: mean(list.map((m) => m.top1)),
    top3: mean(list.map((m) => m.top3)),
    ghosts: mean(list.map((m) => m.ghosts)),
    missed: mean(list.map((m) => m.missed)),
});

const fmt = (m: ViewMetrics): string =>
    `MAE=${pct(m.mae).padStart(5)}pp major=${pct(m.maeMajor).padStart(5)}pp ρ=${m.spearman.toFixed(2)} top1=${pct(m.top1).padStart(5)} top3=${pct(m.top3).padStart(5)} ghosts=${m.ghosts.toFixed(2)} missed=${m.missed.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();
const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(0)}s`;

console.log(
    `kit presence: photos=${photos.length} tags=${allTags.length} kits=${K} (${kits.map((kit) => `${kit.id}:${kit.tags.length}t/${kit.memberIds.size}`).join(" ")})`,
);

type SeedResult = Map<string, Map<string, ViewMetrics[]>>; // scorer → view kind → per-view metrics
const runSeed = (seed: number): { prevalence: SeedResult; partition: SeedResult; scorers: Scorer[] } => {
    const [train, test] = splitByGroups(seed);
    const scorers = buildScorers(train);
    const views = buildViews(test, seed);
    const prevalence: SeedResult = new Map();
    const partition: SeedResult = new Map();
    for (const scorer of scorers) {
        const byKindPrevalence = new Map<string, ViewMetrics[]>();
        const byKindPartition = new Map<string, ViewMetrics[]>();
        for (const view of views) {
            const estimated = estimate(scorer, view);
            const push = (store: Map<string, ViewMetrics[]>, metrics: ViewMetrics): void => {
                store.set(view.kind, [...(store.get(view.kind) ?? []), metrics]);
                store.set("ALL", [...(store.get("ALL") ?? []), metrics]);
            };
            push(byKindPrevalence, compare(estimated, truePrevalence(view)));
            push(byKindPartition, compare(normalise(estimated), truePartition(view)));
        }
        prevalence.set(scorer.name, byKindPrevalence);
        partition.set(scorer.name, byKindPartition);
    }
    console.log(`seed ${seed}: train=${train.size} test=${test.size} views=${views.length} (${elapsed()})`);
    return { prevalence, partition, scorers };
};

const dev = runSeed(DEVELOPMENT_SEED);
const kinds = ["ALL", "all", "tag", "kit", "window", "random"];

const printTable = (title: string, result: SeedResult, scorers: readonly Scorer[], kind: string): void => {
    console.log(`\n=== ${title} — views: ${kind} ===`);
    for (const scorer of scorers) {
        console.log(`  ${scorer.name.padEnd(40)} ${fmt(averageMetrics(result.get(scorer.name)!.get(kind) ?? []))}`);
    }
};

console.log("\n############ PREVALENCE semantics: estimate vs fraction of photos that carry all of the kit's tags ############");
for (const kind of kinds) {
    printTable("prevalence (seed 42)", dev.prevalence, dev.scorers, kind);
}
console.log("\n############ PARTITION semantics: normalised estimate vs membership mass split evenly over a photo's kits ############");
for (const kind of ["ALL", "tag", "window"]) {
    printTable("partition (seed 42)", dev.partition, dev.scorers, kind);
}

// One worked example: the largest tag-filtered view, top kits by truth vs two estimators.
{
    const [train, test] = splitByGroups(DEVELOPMENT_SEED);
    const scorers = buildScorers(train);
    const byName = new Map(scorers.map((scorer) => [scorer.name, scorer]));
    const views = buildViews(test, DEVELOPMENT_SEED).filter((view) => view.kind === "tag");
    const view = views.sort((a, b) => b.photos.length - a.photos.length)[0]!;
    const truth = truePrevalence(view);
    const production = estimate(byName.get("production (nearest medoid)")!, view);
    const kitLogistic = estimate(byName.get("kit logistic (natural)")!, view);
    const tagProduct = estimate(byName.get("tag product (shipped, prior-corrected)")!, view);
    console.log(`\n=== example: largest tag-filtered test view (${view.photos.length} photos), kits by true prevalence ===`);
    console.log(`  kit       tags                     truth  production  kitLogistic  tagProduct`);
    [...truth.keys()]
        .sort((a, b) => truth[b]! - truth[a]!)
        .slice(0, 12)
        .forEach((k) => {
            console.log(
                `  ${kits[k]!.id.padEnd(9)} ${kits[k]!.tags.join(",").padEnd(24)} ${pct(truth[k]!).padStart(5)}  ${pct(production[k]!).padStart(10)}  ${pct(kitLogistic[k]!).padStart(11)}  ${pct(tagProduct[k]!).padStart(10)}`,
            );
        });
}

// Confirmation: pooled over seeds, ALL views, both semantics.
const pooledPrevalence = new Map<string, ViewMetrics[]>();
const pooledPartition = new Map<string, ViewMetrics[]>();
const pool = (target: Map<string, ViewMetrics[]>, result: SeedResult): void => {
    for (const [name, byKind] of result) {
        target.set(name, [...(target.get(name) ?? []), averageMetrics(byKind.get("ALL")!)]);
    }
};
pool(pooledPrevalence, dev.prevalence);
pool(pooledPartition, dev.partition);
for (const seed of CONFIRMATION_SEEDS) {
    const result = runSeed(seed);
    pool(pooledPrevalence, result.prevalence);
    pool(pooledPartition, result.partition);
}
console.log(`\n=== mean over seeds ${[DEVELOPMENT_SEED, ...CONFIRMATION_SEEDS].join("/")} — prevalence semantics, all views ===`);
for (const scorer of dev.scorers) {
    console.log(`  ${scorer.name.padEnd(40)} ${fmt(averageMetrics(pooledPrevalence.get(scorer.name)!))}`);
}
console.log(`\n=== mean over seeds — partition semantics, all views ===`);
for (const scorer of dev.scorers) {
    console.log(`  ${scorer.name.padEnd(40)} ${fmt(averageMetrics(pooledPartition.get(scorer.name)!))}`);
}
console.log(`\ntotal ${elapsed()}`);
