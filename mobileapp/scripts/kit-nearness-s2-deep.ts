/**
 * Deep S2 kit-nearness experiments: fingerprints, hard negatives,
 * stratified default menu, unbiased per-kit search.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-deep.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    buildKitEmbeddingCentroid,
    kitEmbeddingDistanceCompetitive,
    kitEmbeddingMinDistance,
    pickKitEmbeddingMedoids,
} from "../src/lib/kit-nearness-sort";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import { KIT_EMBEDDING_DIMS } from "../src/lib/kit-embedding";
import { hammingDistancePacked, parseDHashHex } from "../src/lib/phash";

const CORPUS_PATH =
    "C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json";
const NOTES_PATH =
    "C:/Users/Elliot/Documents/Development/cursor-workspace/ente/mobileapp/scripts/kit-nearness-s2-research.md";

const MIN_COUNT = 20;
const JACCARD_DEDUP = 0.85;
const MAX_KITS_PER_ARITY = 24;
const SEED_FRACTION = 0.6;
const NEG_N = 180;
const HOLD_CAP = 80;
const SEED_CAP = 80;
const FOLD_SEED_A = 42;
const FOLD_SEED_B = 99;
const DIM = 512;

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

const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const comboKey = (tags: readonly string[]): string =>
    [...tags].sort().join("|");

const hasAllTags = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.length > 0 && kit.every((tag) => have.has(tag));

const sharesAny = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.some((tag) => have.has(tag));

const jaccard = (a: ReadonlySet<number>, b: ReadonlySet<number>): number => {
    let inter = 0;
    for (const id of a) {
        if (b.has(id)) {
            inter += 1;
        }
    }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
};

const mannWhitneyAuc = (
    pos: readonly number[],
    neg: readonly number[],
): number => {
    if (!pos.length || !neg.length) {
        return 0.5;
    }
    let wins = 0;
    let ties = 0;
    for (const p of pos) {
        for (const n of neg) {
            if (p > n) {
                wins += 1;
            } else if (p === n) {
                ties += 1;
            }
        }
    }
    return (wins + 0.5 * ties) / (pos.length * neg.length);
};

const topKHitRate = (
    ranked: readonly number[],
    positive: ReadonlySet<number>,
    k: number,
): number => {
    if (k <= 0) {
        return 0;
    }
    let hits = 0;
    for (let i = 0; i < k && i < ranked.length; i++) {
        if (positive.has(ranked[i]!)) {
            hits += 1;
        }
    }
    return hits / k;
};

const l2 = (v: number[]): number[] => {
    let n = 0;
    for (const x of v) {
        n += x * x;
    }
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
};

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        s += a[i]! * b[i]!;
    }
    return s;
};

type EvalKit = {
    id: string;
    source: "saved" | "and-combo";
    tags: string[];
    memberIds: number[];
};

type Fold = {
    kit: EvalKit;
    seedIds: number[];
    holdoutIds: number[];
    easyNeg: number[];
    hardNeg: number[];
    meanPairwiseCosine: number;
};

const countCombos = (
    photos: AnonymisedKitNearnessCorpus["photos"],
    arity: number,
    minCount: number,
): Map<string, number[]> => {
    const counts = new Map<string, number[]>();
    for (const photo of photos) {
        const tags = [...new Set(photo.tags)].sort();
        if (tags.length < arity) {
            continue;
        }
        const pick = (start: number, chosen: string[]): void => {
            if (chosen.length === arity) {
                const key = comboKey(chosen);
                const ids = counts.get(key);
                if (ids) {
                    ids.push(photo.id);
                } else {
                    counts.set(key, [photo.id]);
                }
                return;
            }
            const need = arity - chosen.length;
            for (let i = start; i <= tags.length - need; i++) {
                chosen.push(tags[i]!);
                pick(i + 1, chosen);
                chosen.pop();
            }
        };
        pick(0, []);
    }
    for (const [key, ids] of counts) {
        if (ids.length < minCount) {
            counts.delete(key);
        }
    }
    return counts;
};

const buildEvalKits = (
    corpus: AnonymisedKitNearnessCorpus,
    clipIds: ReadonlySet<number>,
): EvalKit[] => {
    const clipPhotos = corpus.photos.filter((p) => clipIds.has(p.id));
    const kits: EvalKit[] = [];
    for (const saved of corpus.kits) {
        if (!saved.tags.length) {
            continue;
        }
        const memberIds = clipPhotos
            .filter((p) => hasAllTags(new Set(p.tags), saved.tags))
            .map((p) => p.id);
        if (memberIds.length >= MIN_COUNT) {
            kits.push({
                id: saved.id,
                source: "saved",
                tags: [...saved.tags].sort(),
                memberIds,
            });
        }
    }
    for (const arity of [1, 2, 3]) {
        const combos = countCombos(clipPhotos, arity, MIN_COUNT);
        const ranked = [...combos.entries()].sort(
            (a, b) => b[1].length - a[1].length,
        );
        let taken = 0;
        for (const [key, ids] of ranked) {
            if (taken >= MAX_KITS_PER_ARITY) {
                break;
            }
            kits.push({
                id: `and${arity}_${String(taken + 1).padStart(2, "0")}`,
                source: "and-combo",
                tags: key.split("|"),
                memberIds: ids,
            });
            taken += 1;
        }
    }
    const unique = new Map<string, EvalKit>();
    for (const kit of kits) {
        const key = comboKey(kit.tags);
        const prev = unique.get(key);
        if (!prev || kit.memberIds.length > prev.memberIds.length) {
            unique.set(key, kit);
        }
    }
    const sorted = [...unique.values()].sort(
        (a, b) =>
            b.tags.length - a.tags.length ||
            b.memberIds.length - a.memberIds.length,
    );
    const kept: EvalKit[] = [];
    const sets: Set<number>[] = [];
    for (const kit of sorted) {
        const members = new Set(kit.memberIds);
        if (sets.some((s) => jaccard(members, s) >= JACCARD_DEDUP)) {
            continue;
        }
        kept.push(kit);
        sets.push(members);
    }
    return kept;
};

const meanPairwiseCosine = (
    ids: readonly number[],
    embeddings: ReadonlyMap<number, Float32Array>,
): number => {
    const vecs: Float32Array[] = [];
    for (const id of ids) {
        const v = embeddings.get(id);
        if (v) {
            vecs.push(v);
        }
        if (vecs.length >= 32) {
            break;
        }
    }
    if (vecs.length < 2) {
        return 0;
    }
    let sum = 0;
    let n = 0;
    for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
            sum += dot(vecs[i]!, vecs[j]!);
            n += 1;
        }
    }
    return n === 0 ? 0 : sum / n;
};

const makeFolds = (
    kits: readonly EvalKit[],
    clipIds: readonly number[],
    tagSets: ReadonlyMap<number, Set<string>>,
    embeddings: ReadonlyMap<number, Float32Array>,
    foldSeed: number,
): Fold[] => {
    const random = mulberry32(foldSeed);
    const folds: Fold[] = [];
    for (const kit of kits) {
        if (kit.memberIds.length < MIN_COUNT) {
            continue;
        }
        const members = new Set(kit.memberIds);
        const shuffled = [...kit.memberIds];
        shuffleInPlace(shuffled, random);
        const seedCount = Math.max(
            2,
            Math.min(
                shuffled.length - 2,
                Math.floor(shuffled.length * SEED_FRACTION),
            ),
        );
        const seedIds = shuffled.slice(0, seedCount);
        let holdoutIds = shuffled.slice(seedCount);
        if (holdoutIds.length < 2) {
            continue;
        }
        shuffleInPlace(holdoutIds, random);
        holdoutIds = holdoutIds.slice(0, HOLD_CAP);
        const easy: number[] = [];
        const hard: number[] = [];
        const pool = [...clipIds];
        shuffleInPlace(pool, random);
        for (const id of pool) {
            if (members.has(id)) {
                continue;
            }
            const tags = tagSets.get(id);
            if (!tags) {
                continue;
            }
            if (hasAllTags(tags, kit.tags)) {
                continue;
            }
            if (sharesAny(tags, kit.tags)) {
                if (hard.length < NEG_N) {
                    hard.push(id);
                }
            } else if (easy.length < NEG_N) {
                easy.push(id);
            }
            if (easy.length >= NEG_N && hard.length >= NEG_N) {
                break;
            }
        }
        if (easy.length < 24 || hard.length < 16) {
            continue;
        }
        folds.push({
            kit,
            seedIds,
            holdoutIds,
            easyNeg: easy,
            hardNeg: hard,
            meanPairwiseCosine: meanPairwiseCosine(kit.memberIds, embeddings),
        });
    }
    return folds;
};

const kMeans = (points: Float32Array[], k: number): number[][] => {
    if (!points.length) {
        return [];
    }
    const kk = Math.min(k, points.length);
    const centers: number[][] = [l2([...points[0]!])];
    while (centers.length < kk) {
        let best = -1;
        let bestI = 0;
        for (let i = 0; i < points.length; i++) {
            const p = points[i]!;
            let minD = Infinity;
            for (const c of centers) {
                const d = 1 - dot(p, c);
                if (d < minD) {
                    minD = d;
                }
            }
            if (minD > best) {
                best = minD;
                bestI = i;
            }
        }
        centers.push(l2([...points[bestI]!]));
    }
    for (let iter = 0; iter < 8; iter++) {
        const acc = centers.map(() => new Array(DIM).fill(0) as number[]);
        const counts = centers.map(() => 0);
        for (const p of points) {
            let bi = 0;
            let bd = Infinity;
            for (let c = 0; c < centers.length; c++) {
                const d = 1 - dot(p, centers[c]!);
                if (d < bd) {
                    bd = d;
                    bi = c;
                }
            }
            counts[bi]! += 1;
            const a = acc[bi]!;
            for (let i = 0; i < DIM; i++) {
                a[i]! += p[i]!;
            }
        }
        for (let c = 0; c < centers.length; c++) {
            if (counts[c]! === 0) {
                continue;
            }
            const a = acc[c]!;
            const n = counts[c]!;
            for (let i = 0; i < DIM; i++) {
                a[i]! /= n;
            }
            centers[c] = l2(a);
        }
    }
    return centers;
};

type ScorePair = { easy: number; hard: number; topKEasy: number };

const scoreFold = (
    fold: Fold,
    scoreFn: (id: number) => number,
): ScorePair => {
    const pos = fold.holdoutIds.map(scoreFn);
    const easy = fold.easyNeg.map(scoreFn);
    const hard = fold.hardNeg.map(scoreFn);
    const posSet = new Set(fold.holdoutIds);
    const rank = (neg: number[]) => {
        const cands = [...fold.holdoutIds, ...neg];
        const ranked = cands
            .map((id) => ({ id, s: scoreFn(id) }))
            .sort((a, b) => b.s - a.s)
            .map((r) => r.id);
        return topKHitRate(ranked, posSet, Math.min(fold.holdoutIds.length, ranked.length));
    };
    return {
        easy: mannWhitneyAuc(pos, easy),
        hard: mannWhitneyAuc(pos, hard),
        topKEasy: rank(fold.easyNeg),
    };
};

const summarize = (
    name: string,
    folds: readonly Fold[],
    scoreFn: (fold: Fold, id: number) => number,
): { name: string; easy: number; hard: number; topK: number } => {
    const rows = folds.map((fold) => scoreFold(fold, (id) => scoreFn(fold, id)));
    const out = {
        name,
        easy: mean(rows.map((r) => r.easy)),
        hard: mean(rows.map((r) => r.hard)),
        topK: mean(rows.map((r) => r.topKEasy)),
    };
    console.log(
        `${name.padEnd(42)} easy=${out.easy.toFixed(3)} hard=${out.hard.toFixed(3)} topK=${out.topK.toFixed(3)}`,
    );
    return out;
};

const stratumOf = (fold: Fold): string => {
    const size =
        fold.kit.memberIds.length < 120 ?
            "small" :
            fold.kit.memberIds.length < 800 ?
                "mid" :
                "large";
    const coh = fold.meanPairwiseCosine >= 0.73 ? "tight" : "loose";
    const arity =
        fold.kit.tags.length === 1 ?
            "a1" :
            fold.kit.tags.length === 2 ?
                "a2" :
                "a3p";
    return `${size}|${coh}|${arity}`;
};

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnonymisedKitNearnessCorpus;
const embeddings = new Map<number, Float32Array>();
const tagSets = new Map<number, Set<string>>();
const primaryHash = new Map<number, ReturnType<typeof parseDHashHex>>();
for (const photo of raw.photos) {
    tagSets.set(photo.id, new Set(photo.tags));
    if (photo.embedding?.length === (raw.embeddingDims ?? DIM)) {
        embeddings.set(photo.id, Float32Array.from(l2(photo.embedding)));
    }
    if (photo.hashes[0]) {
        primaryHash.set(photo.id, parseDHashHex(photo.hashes[0]));
    }
}
const clipIds = [...embeddings.keys()];
const kits = buildEvalKits(raw, new Set(clipIds));
const foldsA = makeFolds(kits, clipIds, tagSets, embeddings, FOLD_SEED_A);
const foldsB = makeFolds(kits, clipIds, tagSets, embeddings, FOLD_SEED_B);
console.log(
    `kits=${kits.length} foldsA=${foldsA.length} foldsB=${foldsB.length} clip=${embeddings.size}`,
);

type ProtoCache = {
    centroid: number[] | undefined;
    core: number[] | undefined;
    kmeans2: number[][];
    kmeans3: number[][];
    medoids1: number[][];
    medoids3: number[][];
    medoids5: number[][];
    seedVecs: Float32Array[];
    seedIds: number[];
    mu: number[];
    invVar: Float32Array;
    seedHash?: ReturnType<typeof parseDHashHex>;
};

const asNumberMap = (
    src: ReadonlyMap<number, Float32Array>,
): Map<number, number[]> => {
    const out = new Map<number, number[]>();
    for (const [id, v] of src) {
        out.set(id, Array.from(v));
    }
    return out;
};
const numberEmb = asNumberMap(embeddings);

const buildCache = (fold: Fold): ProtoCache => {
    const seedIds = fold.seedIds.slice(0, SEED_CAP);
    const seedVecs: Float32Array[] = [];
    for (const id of seedIds) {
        const v = embeddings.get(id);
        if (v) {
            seedVecs.push(v);
        }
    }
    const centroid = buildKitEmbeddingCentroid(seedIds, numberEmb, SEED_CAP);
    let core: number[] | undefined;
    if (centroid) {
        const scored = seedIds
            .map((id) => {
                const v = embeddings.get(id);
                return v ? { id, d: 1 - dot(centroid, v) } : undefined;
            })
            .filter((r): r is { id: number; d: number } => r !== undefined)
            .sort((a, b) => a.d - b.d);
        const keep = Math.max(4, Math.floor(scored.length * 0.6));
        core = buildKitEmbeddingCentroid(
            scored.slice(0, keep).map((r) => r.id),
            numberEmb,
            SEED_CAP,
        );
    }
    const mu = centroid ?? new Array(DIM).fill(0);
    const invVar = new Float32Array(DIM);
    if (seedVecs.length > 1) {
        for (let i = 0; i < DIM; i++) {
            let s = 0;
            for (const v of seedVecs) {
                const d = v[i]! - mu[i]!;
                s += d * d;
            }
            const v = s / (seedVecs.length - 1);
            invVar[i] = 1 / (v + 1e-3);
        }
    } else {
        invVar.fill(1);
    }
    const medoids = (k: number, sep: number) =>
        pickKitEmbeddingMedoids(seedIds, numberEmb, {
            maxMedoids: k,
            minSeparation: sep,
            maxSeeds: SEED_CAP,
        }).map((m) => m.vector as number[]);
    let seedHash = primaryHash.get(seedIds[0]!);
    for (const id of seedIds) {
        const h = primaryHash.get(id);
        if (h) {
            seedHash = h;
            break;
        }
    }
    return {
        centroid,
        core,
        kmeans2: kMeans(seedVecs, 2),
        kmeans3: kMeans(seedVecs, 3),
        medoids1: medoids(1, 0.08),
        medoids3: medoids(3, 0.08),
        medoids5: medoids(5, 0.08),
        seedVecs,
        seedIds,
        mu,
        invVar,
        seedHash,
    };
};

const cachesA = new Map<string, ProtoCache>();
for (const fold of foldsA) {
    cachesA.set(fold.kit.id, buildCache(fold));
}

const minDistTo = (
    id: number,
    centers: readonly (readonly number[])[],
): number => {
    const d = kitEmbeddingMinDistance(id, centers, numberEmb);
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
};

const meanTopK = (id: number, cache: ProtoCache, k: number): number => {
    const probe = embeddings.get(id);
    if (!probe || !cache.seedVecs.length) {
        return Number.NEGATIVE_INFINITY;
    }
    const dots: number[] = [];
    for (const s of cache.seedVecs) {
        dots.push(dot(probe, s));
    }
    dots.sort((a, b) => b - a);
    const take = Math.min(k, dots.length);
    let s = 0;
    for (let i = 0; i < take; i++) {
        s += dots[i]!;
    }
    return s / take;
};

const mahalanobis = (id: number, cache: ProtoCache): number => {
    const probe = embeddings.get(id);
    if (!probe) {
        return Number.NEGATIVE_INFINITY;
    }
    let s = 0;
    for (let i = 0; i < DIM; i++) {
        const d = probe[i]! - cache.mu[i]!;
        s += d * d * cache.invVar[i]!;
    }
    return -s;
};

const dHashToSeed = (id: number, cache: ProtoCache): number => {
    const a = primaryHash.get(id);
    if (!a || !cache.seedHash) {
        return 32;
    }
    return hammingDistancePacked(a, cache.seedHash);
};

console.log("\n=== Deep fingerprints (easy = 0 shared tags, hard = some tags) ===");
const fp: { name: string; easy: number; hard: number; topK: number }[] = [];
const runFp = (
    name: string,
    fn: (fold: Fold, id: number, cache: ProtoCache) => number,
) => {
    fp.push(
        summarize(name, foldsA, (fold, id) => {
            const cache = cachesA.get(fold.kit.id);
            if (!cache) {
                return Number.NEGATIVE_INFINITY;
            }
            return fn(fold, id, cache);
        }),
    );
};

runFp("CLIP centroid", (_f, id, c) =>
    c.centroid ? dot(embeddings.get(id) ?? [], c.centroid) : Number.NEGATIVE_INFINITY,
);
runFp("CLIP core-60% centroid", (_f, id, c) =>
    c.core ? dot(embeddings.get(id) ?? [], c.core) : Number.NEGATIVE_INFINITY,
);
runFp("CLIP k-means k=2 min-dist", (_f, id, c) => minDistTo(id, c.kmeans2));
runFp("CLIP k-means k=3 min-dist", (_f, id, c) => minDistTo(id, c.kmeans3));
runFp("CLIP densest medoid k=1", (_f, id, c) => minDistTo(id, c.medoids1));
runFp("CLIP densest medoids k=3", (_f, id, c) => minDistTo(id, c.medoids3));
runFp("CLIP densest medoids k=5", (_f, id, c) => minDistTo(id, c.medoids5));
runFp("CLIP mean top-1 (NN)", (_f, id, c) => meanTopK(id, c, 1));
runFp("CLIP mean top-3", (_f, id, c) => meanTopK(id, c, 3));
runFp("CLIP mean top-8", (_f, id, c) => meanTopK(id, c, 8));
runFp("CLIP mean top-20", (_f, id, c) => meanTopK(id, c, 20));
runFp("CLIP mean all seeds", (_f, id, c) => meanTopK(id, c, 999));
runFp("CLIP diag-Mahalanobis", (_f, id, c) => mahalanobis(id, c));
runFp("hybrid: centroid + 0.08*top3", (_f, id, c) => {
    const cen = c.centroid ?
        dot(embeddings.get(id) ?? [], c.centroid) :
        Number.NEGATIVE_INFINITY;
    return cen + 0.08 * meanTopK(id, c, 3);
});
runFp("hybrid: max(centroid, top1)", (_f, id, c) => {
    const cen = c.centroid ?
        dot(embeddings.get(id) ?? [], c.centroid) :
        Number.NEGATIVE_INFINITY;
    return Math.max(cen, meanTopK(id, c, 1));
});
runFp("gate: NN if top1>0.86 else centroid", (_f, id, c) => {
    const nn = meanTopK(id, c, 1);
    if (nn > 0.86) {
        return nn + 0.05;
    }
    return c.centroid ?
        dot(embeddings.get(id) ?? [], c.centroid) :
        Number.NEGATIVE_INFINITY;
});
runFp("centroid + dHash bonus gate6", (_f, id, c) => {
    const cen = c.centroid ?
        dot(embeddings.get(id) ?? [], c.centroid) :
        Number.NEGATIVE_INFINITY;
    const h = dHashToSeed(id, c);
    return cen + (h < 6 ? 0.04 * (6 - h) / 6 : 0);
});
runFp("centroid + dHash bonus gate14", (_f, id, c) => {
    const cen = c.centroid ?
        dot(embeddings.get(id) ?? [], c.centroid) :
        Number.NEGATIVE_INFINITY;
    const h = dHashToSeed(id, c);
    return cen + (h < 14 ? 0.03 * (14 - h) / 14 : 0);
});

fp.sort((a, b) => b.hard - a.hard || b.easy - a.easy);
console.log("\nRanked by HARD AUC:");
for (const row of fp) {
    console.log(
        `  ${row.name.padEnd(42)} easy=${(row.easy * 100).toFixed(1)} hard=${(row.hard * 100).toFixed(1)} topK=${(row.topK * 100).toFixed(1)}`,
    );
}

type Genome = {
    name: string;
    useCentroid: boolean;
    k: number;
    sep: number;
    lambda: number;
    tau: number;
    knnK?: number;
};

const applyGenome = (
    id: number,
    fold: Fold,
    cache: ProtoCache,
    rivals: number[][][],
    g: Genome,
): number => {
    let selected: number[][] = [];
    if (g.knnK) {
        return meanTopK(id, cache, g.knnK);
    }
    if (g.useCentroid) {
        if (cache.centroid) {
            selected = [cache.centroid];
        }
    } else if (g.k <= 1) {
        selected = cache.medoids1;
    } else if (g.k <= 3) {
        selected = cache.medoids3;
    } else {
        selected = cache.medoids5;
    }
    const d = kitEmbeddingDistanceCompetitive(
        id,
        selected,
        rivals,
        numberEmb,
        { lambda: g.lambda, tau: g.tau },
    );
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
};

const rivalMap = (folds: readonly Fold[], caches: Map<string, ProtoCache>) => {
    const out = new Map<string, number[][][]>();
    for (const fold of folds) {
        const rivals: number[][][] = [];
        for (const other of folds) {
            if (other.kit.id === fold.kit.id) {
                continue;
            }
            if (
                jaccard(new Set(fold.kit.memberIds), new Set(other.kit.memberIds)) >=
                0.45
            ) {
                continue;
            }
            const c = caches.get(other.kit.id)?.centroid;
            if (c) {
                rivals.push([c]);
            }
            if (rivals.length >= 4) {
                break;
            }
        }
        out.set(fold.kit.id, rivals);
    }
    return out;
};

const rivalsA = rivalMap(foldsA, cachesA);

console.log("\n=== Genome menu grid (centroid/medoids/knn × λ × τ) ===");
const genomes: Genome[] = [];
for (const lambda of [0, 2, 4, 6, 8]) {
    for (const tau of [0.06, 0.12, 0.24]) {
        genomes.push({
            name: `cen λ=${lambda} τ=${tau}`,
            useCentroid: true,
            k: 0,
            sep: 0,
            lambda,
            tau,
        });
    }
}
for (const k of [1, 3, 5]) {
    for (const lambda of [0, 4, 8]) {
        genomes.push({
            name: `med k=${k} λ=${lambda}`,
            useCentroid: false,
            k,
            sep: 0.08,
            lambda,
            tau: 0.12,
        });
    }
}
for (const knnK of [3, 8]) {
    genomes.push({
        name: `knn${knnK} λ=0`,
        useCentroid: true,
        k: 0,
        sep: 0,
        lambda: 0,
        tau: 0.12,
        knnK,
    });
}

type GRow = {
    g: Genome;
    easy: number;
    hard: number;
    topK: number;
    byStratum: Map<string, number>;
};
const gRows: GRow[] = [];
for (const g of genomes) {
    const per = foldsA.map((fold) => {
        const cache = cachesA.get(fold.kit.id)!;
        const rivals = rivalsA.get(fold.kit.id) ?? [];
        return {
            fold,
            pair: scoreFold(fold, (id) => applyGenome(id, fold, cache, rivals, g)),
        };
    });
    const byStratum = new Map<string, number[]>();
    for (const row of per) {
        const key = stratumOf(row.fold);
        const list = byStratum.get(key) ?? [];
        list.push(row.pair.hard);
        byStratum.set(key, list);
    }
    const out: GRow = {
        g,
        easy: mean(per.map((p) => p.pair.easy)),
        hard: mean(per.map((p) => p.pair.hard)),
        topK: mean(per.map((p) => p.pair.topKEasy)),
        byStratum: new Map(
            [...byStratum.entries()].map(([k, v]) => [k, mean(v)]),
        ),
    };
    gRows.push(out);
    console.log(
        `${g.name.padEnd(24)} easy=${out.easy.toFixed(3)} hard=${out.hard.toFixed(3)} topK=${out.topK.toFixed(3)}`,
    );
}

gRows.sort((a, b) => b.hard - a.hard || b.easy - a.easy);
console.log("\nTop genomes by HARD AUC:");
for (const row of gRows.slice(0, 12)) {
    console.log(
        `  ${row.g.name.padEnd(24)} easy=${(row.easy * 100).toFixed(1)} hard=${(row.hard * 100).toFixed(1)}`,
    );
}

const strata = [...new Set(foldsA.map(stratumOf))].sort();
console.log("\n=== Stratified menu (best HARD genome per bucket) ===");
const menu = new Map<string, GRow>();
for (const s of strata) {
    const n = foldsA.filter((f) => stratumOf(f) === s).length;
    let best: GRow | undefined;
    for (const row of gRows) {
        const v = row.byStratum.get(s);
        if (v === undefined) {
            continue;
        }
        if (!best || v > (best.byStratum.get(s) ?? -1)) {
            best = row;
        }
    }
    if (best) {
        menu.set(s, best);
        console.log(
            `  ${s.padEnd(22)} n=${n}  ${best.g.name}  hard=${((best.byStratum.get(s) ?? 0) * 100).toFixed(1)}%`,
        );
    }
}

const globalBest = gRows[0]!;
const globalDefaultName = "cen λ=4 τ=0.12";
const globalDefault =
    gRows.find((r) => r.g.name === globalDefaultName) ?? globalBest;
const currentProd =
    gRows.find((r) => r.g.name === "med k=3 λ=4") ?? gRows[gRows.length - 1]!;

console.log("\n=== Unbiased per-kit tuner (grid on fold A, test fold B) ===");
const cachesB = new Map<string, ProtoCache>();
for (const fold of foldsB) {
    cachesB.set(fold.kit.id, buildCache(fold));
}
const rivalsB = rivalMap(foldsB, cachesB);

const tunerGenomes = gRows
    .filter((r) => !r.g.knnK)
    .slice()
    .sort((a, b) => b.hard - a.hard)
    .slice(0, 24)
    .map((r) => r.g);
if (!tunerGenomes.some((g) => g.name === currentProd.g.name)) {
    tunerGenomes.push(currentProd.g);
}
if (!tunerGenomes.some((g) => g.name === globalDefault.g.name)) {
    tunerGenomes.push(globalDefault.g);
}

type TuneRow = {
    id: string;
    stratum: string;
    n: number;
    defaultHard: number;
    tunedHard: number;
    oracleHard: number;
    picked: string;
    lift: number;
};
const tuneRows: TuneRow[] = [];
const t0 = Date.now();
for (const foldB of foldsB) {
    const foldA = foldsA.find((f) => f.kit.id === foldB.kit.id);
    if (!foldA) {
        continue;
    }
    const cacheA = cachesA.get(foldA.kit.id)!;
    const cacheB = cachesB.get(foldB.kit.id)!;
    const rA = rivalsA.get(foldA.kit.id) ?? [];
    const rB = rivalsB.get(foldB.kit.id) ?? [];
    let bestG = globalDefault.g;
    let bestA = -Infinity;
    for (const g of tunerGenomes) {
        const hard = scoreFold(foldA, (id) =>
            applyGenome(id, foldA, cacheA, rA, g),
        ).hard;
        if (hard > bestA) {
            bestA = hard;
            bestG = g;
        }
    }
    const defaultHard = scoreFold(foldB, (id) =>
        applyGenome(id, foldB, cacheB, rB, globalDefault.g),
    ).hard;
    const tunedHard = scoreFold(foldB, (id) =>
        applyGenome(id, foldB, cacheB, rB, bestG),
    ).hard;
    let oracle = defaultHard;
    let oracleG = globalDefault.g;
    for (const g of tunerGenomes) {
        const hard = scoreFold(foldB, (id) =>
            applyGenome(id, foldB, cacheB, rB, g),
        ).hard;
        if (hard > oracle) {
            oracle = hard;
            oracleG = g;
        }
    }
    tuneRows.push({
        id: foldB.kit.id,
        stratum: stratumOf(foldB),
        n: foldB.kit.memberIds.length,
        defaultHard,
        tunedHard,
        oracleHard: oracle,
        picked: bestG.name,
        lift: tunedHard - defaultHard,
    });
    void oracleG;
}
const tuneMs = Date.now() - t0;
const kept = tuneRows.filter((r) => r.lift >= 0.02);
const hurt = tuneRows.filter((r) => r.lift <= -0.02);
console.log(
    `kits=${tuneRows.length}  mean default hard=${mean(tuneRows.map((r) => r.defaultHard)).toFixed(3)}  mean tuned=${mean(tuneRows.map((r) => r.tunedHard)).toFixed(3)}  mean oracle=${mean(tuneRows.map((r) => r.oracleHard)).toFixed(3)}`,
);
console.log(
    `unbiased lift mean=${(mean(tuneRows.map((r) => r.lift)) * 100).toFixed(2)}pp  ≥2pp keep=${kept.length}  ≤-2pp hurt=${hurt.length}  grid ${tuneMs}ms`,
);
console.log(
    `oracle gap (overfit upper bound) mean=${(
        (mean(tuneRows.map((r) => r.oracleHard)) -
            mean(tuneRows.map((r) => r.defaultHard))) *
        100
    ).toFixed(2)}pp`,
);

const menuOnB = foldsB.map((fold) => {
    const s = stratumOf(fold);
    const g = menu.get(s)?.g ?? globalDefault.g;
    const cache = cachesB.get(fold.kit.id)!;
    const rivals = rivalsB.get(fold.kit.id) ?? [];
    return scoreFold(fold, (id) => applyGenome(id, fold, cache, rivals, g)).hard;
});
const defaultOnB = foldsB.map((fold) => {
    const cache = cachesB.get(fold.kit.id)!;
    const rivals = rivalsB.get(fold.kit.id) ?? [];
    return scoreFold(fold, (id) =>
        applyGenome(id, fold, cache, rivals, globalDefault.g),
    ).hard;
});
const prodOnB = foldsB.map((fold) => {
    const cache = cachesB.get(fold.kit.id)!;
    const rivals = rivalsB.get(fold.kit.id) ?? [];
    return scoreFold(fold, (id) =>
        applyGenome(id, fold, cache, rivals, currentProd.g),
    ).hard;
});
console.log(
    `\nHeld-out fold B: prod med λ4 hard=${mean(prodOnB).toFixed(3)}  global ${globalDefault.g.name} hard=${mean(defaultOnB).toFixed(3)}  stratified menu hard=${mean(menuOnB).toFixed(3)}`,
);

const scoreGenomeOnB = (g: Genome): number =>
    mean(
        foldsB.map((fold) => {
            const cache = cachesB.get(fold.kit.id)!;
            const rivals = rivalsB.get(fold.kit.id) ?? [];
            return scoreFold(fold, (id) =>
                applyGenome(id, fold, cache, rivals, g),
            ).hard;
        }),
    );

const g8 = gRows.find((r) => r.g.name === "cen λ=8 τ=0.06")?.g;
const g6 = gRows.find((r) => r.g.name === "cen λ=6 τ=0.06")?.g;
const b8 = g8 ? scoreGenomeOnB(g8) : 0;
const b6 = g6 ? scoreGenomeOnB(g6) : 0;
console.log(
    `fold B cen λ=8 τ=0.06 hard=${b8.toFixed(3)}  cen λ=6 τ=0.06 hard=${b6.toFixed(3)}`,
);

const fpTable = [...fp]
    .sort((a, b) => b.hard - a.hard)
    .map(
        (r) =>
            `| ${r.name} | ${(r.easy * 100).toFixed(1)}% | ${(r.hard * 100).toFixed(1)}% | ${(r.topK * 100).toFixed(1)}% |`,
    )
    .join("\n");
const gTable = gRows
    .slice(0, 15)
    .map(
        (r) =>
            `| ${r.g.name} | ${(r.easy * 100).toFixed(1)}% | ${(r.hard * 100).toFixed(1)}% | ${(r.topK * 100).toFixed(1)}% |`,
    )
    .join("\n");
const menuTable = [...menu.entries()]
    .map(
        ([s, row]) =>
            `| ${s} | ${foldsA.filter((f) => stratumOf(f) === s).length} | ${row.g.name} | ${((row.byStratum.get(s) ?? 0) * 100).toFixed(1)}% |`,
    )
    .join("\n");
const tuneTable = [...tuneRows]
    .sort((a, b) => b.lift - a.lift)
    .map(
        (r) =>
            `  ${r.id} ${r.stratum} n=${r.n} def=${r.defaultHard.toFixed(3)} tuned=${r.tunedHard.toFixed(3)} Δ=${(r.lift * 100).toFixed(1)}pp pick=${r.picked} oracle=${r.oracleHard.toFixed(3)}`,
    )
    .join("\n");

const prev = readFileSync(NOTES_PATH, "utf8").replace(
    /\n## Status[\s\S]*$/,
    "",
);
const deep = `
## Deep pass (${new Date().toISOString().slice(0, 10)})

Honest recap of the first pass: it was **one global default tweak** (\`useCentroid=1\`), not a menu, and it did **not** touch the per-kit tuner. This pass adds hard negatives, more fingerprints, a stratified menu, and an unbiased tuner simulation.

Hard negatives = CLIP photos that share **some but not all** kit tags (sibling kits). Easy = share none. Holdouts capped at ${HOLD_CAP} for comparability.

### Fingerprints (fold A)

| Method | easy AUC | **hard AUC** | top-K (easy) |
|---|---|---|---|
${fpTable}

### Genome grid (fold A)

| Genome | easy | hard | top-K |
|---|---|---|---|
${gTable}

Current-prod-shaped \`med k=3 λ=4\`: easy ${(currentProd.easy * 100).toFixed(1)}% hard ${(currentProd.hard * 100).toFixed(1)}%
Global candidate \`${globalDefault.g.name}\`: easy ${(globalDefault.easy * 100).toFixed(1)}% hard ${(globalDefault.hard * 100).toFixed(1)}%
Best-on-A \`${globalBest.g.name}\`: easy ${(globalBest.easy * 100).toFixed(1)}% hard ${(globalBest.hard * 100).toFixed(1)}%

### Automatic menu (best hard genome per size×coherence×arity)

| Bucket | kits | genome | hard AUC on A |
|---|---|---|---|
${menuTable}

Held-out **fold B** (new split):
- prod med λ4: ${(mean(prodOnB) * 100).toFixed(1)}%
- global cen λ=4 τ=0.12: ${(mean(defaultOnB) * 100).toFixed(1)}%
- cen λ=6 τ=0.06: ${(b6 * 100).toFixed(1)}%
- cen λ=8 τ=0.06: ${(b8 * 100).toFixed(1)}%
- stratified menu: ${(mean(menuOnB) * 100).toFixed(1)}%

Arity-1 kits dropped from this pass (no partial-tag hard negatives possible). 29/35 kits remain.

### Per-kit tuner (grid on A, test B) — ${tuneRows.length} kits, ${tuneMs}ms

Mean unbiased Δ vs global default: **${(mean(tuneRows.map((r) => r.lift)) * 100).toFixed(2)}pp** hard AUC
Keep (≥2pp): ${kept.length}  Hurt (≤-2pp): ${hurt.length}
Oracle (best genome *on B*, overfit ceiling): +${((mean(tuneRows.map((r) => r.oracleHard)) - mean(tuneRows.map((r) => r.defaultHard))) * 100).toFixed(2)}pp

${tuneTable}

## Status

- [x] Inspect corpus
- [x] AND combo eval kits
- [x] First-pass fingerprints (too shallow)
- [x] Deep fingerprints + hard negatives
- [x] Stratified default menu + held-out check
- [x] Unbiased per-kit tuner vs that menu's global default
- [ ] Implement only what survives fold B
`;

writeFileSync(NOTES_PATH, `${prev.trimEnd()}\n${deep}`, "utf8");
console.log(`\nwrote ${NOTES_PATH}`);
