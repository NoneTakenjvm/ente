/**
 * Offline S2 kit-nearness research: build AND-combo eval kits, bake-off
 * fingerprints, then probe default genomes.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-research.ts
 *
 * Corpus is read from Downloads; never copied into the repo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_KIT_EMBEDDING_GENOME } from "../src/lib/kit-nearness-embedding-genome";
import {
    buildKitEmbeddingCentroid,
    kitEmbeddingDistanceCompetitive,
    kitEmbeddingMinDistance,
    kitNearnessDistance,
    pickKitEmbeddingMedoids,
    pickKitMedoids,
} from "../src/lib/kit-nearness-sort";
import type { PhashEntry } from "../src/lib/crop-match";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import { KIT_EMBEDDING_DIMS } from "../src/lib/kit-embedding";

const CORPUS_PATH =
    "C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json";
const NOTES_PATH =
    "C:/Users/Elliot/Documents/Development/cursor-workspace/ente/mobileapp/scripts/kit-nearness-s2-research.md";

const MIN_COUNT = 20;
const JACCARD_DEDUP = 0.85;
const MAX_KITS_PER_ARITY = 24;
const SEED_FRACTION = 0.6;
const NEGATIVE_POOL = 180;
const FOLD_SEED = 42;
const MAX_SEEDS = 150;

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

const comboKey = (tags: readonly string[]): string =>
    [...tags].sort().join("|");

const hasAllTags = (
    photoTags: readonly string[],
    kitTags: readonly string[],
): boolean => {
    if (kitTags.length === 0) {
        return false;
    }
    const have = new Set(photoTags);
    return kitTags.every((tag) => have.has(tag));
};

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

const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const mannWhitneyAuc = (
    positiveScores: readonly number[],
    negativeScores: readonly number[],
): number => {
    if (!positiveScores.length || !negativeScores.length) {
        return 0.5;
    }
    let wins = 0;
    let ties = 0;
    for (const p of positiveScores) {
        for (const n of negativeScores) {
            if (p > n) {
                wins += 1;
            } else if (p === n) {
                ties += 1;
            }
        }
    }
    return (wins + 0.5 * ties) / (positiveScores.length * negativeScores.length);
};

const topKHitRate = (
    rankedIds: readonly number[],
    positiveSet: ReadonlySet<number>,
    k: number,
): number => {
    if (k <= 0) {
        return 0;
    }
    let hits = 0;
    for (let i = 0; i < k && i < rankedIds.length; i++) {
        if (positiveSet.has(rankedIds[i]!)) {
            hits += 1;
        }
    }
    return hits / k;
};

const l2Normalize = (vector: number[]): number[] => {
    let norm = 0;
    for (const value of vector) {
        norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    return vector.map((value) => value / norm);
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
    negativeIds: number[];
    meanPairwiseCosine: number;
};

const meanPairwiseCosine = (
    ids: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    sampleCap: number = 36,
): number => {
    const vecs: number[][] = [];
    for (const id of ids) {
        const vector = embeddings.get(id);
        if (vector) {
            vecs.push(vector);
        }
        if (vecs.length >= sampleCap) {
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
            let dot = 0;
            const a = vecs[i]!;
            const b = vecs[j]!;
            for (let k = 0; k < a.length; k++) {
                dot += a[k]! * b[k]!;
            }
            sum += dot;
            n += 1;
        }
    }
    return n === 0 ? 0 : sum / n;
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

const dedupKits = (kits: EvalKit[]): EvalKit[] => {
    const sorted = [...kits].sort(
        (a, b) =>
            b.tags.length - a.tags.length ||
            b.memberIds.length - a.memberIds.length,
    );
    const kept: EvalKit[] = [];
    const sets: Set<number>[] = [];
    for (const kit of sorted) {
        const members = new Set(kit.memberIds);
        let dup = false;
        for (const existing of sets) {
            if (jaccard(members, existing) >= JACCARD_DEDUP) {
                dup = true;
                break;
            }
        }
        if (dup) {
            continue;
        }
        kept.push(kit);
        sets.push(members);
    }
    return kept;
};

const buildEvalKits = (
    corpus: AnonymisedKitNearnessCorpus,
    clipIds: ReadonlySet<number>,
    minCount: number,
): EvalKit[] => {
    const clipPhotos = corpus.photos.filter((photo) => clipIds.has(photo.id));
    const kits: EvalKit[] = [];

    for (const saved of corpus.kits) {
        if (saved.tags.length < 1) {
            continue;
        }
        const memberIds = clipPhotos
            .filter((photo) => hasAllTags(photo.tags, saved.tags))
            .map((photo) => photo.id);
        if (memberIds.length >= minCount) {
            kits.push({
                id: saved.id,
                source: "saved",
                tags: [...saved.tags].sort(),
                memberIds,
            });
        }
    }

    for (const arity of [1, 2, 3]) {
        const combos = countCombos(clipPhotos, arity, minCount);
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
        const existing = unique.get(key);
        if (!existing || kit.memberIds.length > existing.memberIds.length) {
            unique.set(key, kit);
        }
    }
    return dedupKits([...unique.values()]);
};

type MethodResult = {
    name: string;
    auc: number;
    topK: number;
    kitAuc: { id: string; auc: number; topK: number; n: number }[];
};

type ScoreFn = (id: number, fold: Fold) => number;

const scoreMethod = (
    name: string,
    folds: readonly Fold[],
    scoreFn: ScoreFn,
): MethodResult => {
    const kitAuc: MethodResult["kitAuc"] = [];
    for (const fold of folds) {
        const posScores = fold.holdoutIds.map((id) => scoreFn(id, fold));
        const negScores = fold.negativeIds.map((id) => scoreFn(id, fold));
        const auc = mannWhitneyAuc(posScores, negScores);
        const candidates = [...fold.holdoutIds, ...fold.negativeIds];
        const ranked = candidates
            .map((id) => ({ id, score: scoreFn(id, fold) }))
            .sort((a, b) => b.score - a.score)
            .map((row) => row.id);
        const k = Math.min(fold.holdoutIds.length, ranked.length);
        const topK = topKHitRate(ranked, new Set(fold.holdoutIds), k);
        kitAuc.push({
            id: fold.kit.id,
            auc,
            topK,
            n: fold.holdoutIds.length,
        });
    }
    return {
        name,
        auc: mean(kitAuc.map((row) => row.auc)),
        topK: mean(kitAuc.map((row) => row.topK)),
        kitAuc,
    };
};

const trimmedCentroid = (
    seedIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    dropFrac: number,
): number[] | undefined => {
    const first = buildKitEmbeddingCentroid(seedIds, embeddings, MAX_SEEDS);
    if (!first) {
        return undefined;
    }
    const scored = seedIds
        .map((id) => {
            const vector = embeddings.get(id);
            if (!vector) {
                return undefined;
            }
            let dot = 0;
            for (let i = 0; i < first.length; i++) {
                dot += first[i]! * vector[i]!;
            }
            return { id, dist: 1 - dot };
        })
        .filter((row): row is { id: number; dist: number } => row !== undefined)
        .sort((a, b) => a.dist - b.dist);
    const keep = Math.max(
        2,
        Math.floor(scored.length * (1 - dropFrac)),
    );
    return buildKitEmbeddingCentroid(
        scored.slice(0, keep).map((row) => row.id),
        embeddings,
        MAX_SEEDS,
    );
};

const softmaxCentroid = (
    seedIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    temperature: number,
): number[] | undefined => {
    const first = buildKitEmbeddingCentroid(seedIds, embeddings, MAX_SEEDS);
    if (!first) {
        return undefined;
    }
    const rows: { id: number; weight: number }[] = [];
    let maxDot = Number.NEGATIVE_INFINITY;
    for (const id of seedIds.slice(0, MAX_SEEDS)) {
        const vector = embeddings.get(id);
        if (!vector) {
            continue;
        }
        let dot = 0;
        for (let i = 0; i < first.length; i++) {
            dot += first[i]! * vector[i]!;
        }
        maxDot = Math.max(maxDot, dot);
        rows.push({ id, weight: dot });
    }
    if (!rows.length) {
        return first;
    }
    let sumW = 0;
    const acc = new Array(first.length).fill(0) as number[];
    for (const row of rows) {
        const w = Math.exp(temperature * (row.weight - maxDot));
        const vector = embeddings.get(row.id);
        if (!vector) {
            continue;
        }
        sumW += w;
        for (let i = 0; i < acc.length; i++) {
            acc[i]! += w * vector[i]!;
        }
    }
    if (sumW <= 0) {
        return first;
    }
    for (let i = 0; i < acc.length; i++) {
        acc[i]! /= sumW;
    }
    return l2Normalize(acc);
};

const densityScore = (
    id: number,
    seedIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    radius: number,
): number => {
    const probe = embeddings.get(id);
    if (!probe) {
        return Number.NEGATIVE_INFINITY;
    }
    let hits = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (const seedId of seedIds.slice(0, MAX_SEEDS)) {
        const seed = embeddings.get(seedId);
        if (!seed) {
            continue;
        }
        let dot = 0;
        for (let i = 0; i < probe.length; i++) {
            dot += probe[i]! * seed[i]!;
        }
        if (dot > best) {
            best = dot;
        }
        if (1 - dot <= radius) {
            hits += 1;
        }
    }
    return hits + 0.01 * best;
};

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnonymisedKitNearnessCorpus;

const embeddings = new Map<number, number[]>();
const phash = new Map<number, PhashEntry>();
let clipMissing = 0;
for (const photo of raw.photos) {
    if (photo.embedding?.length === (raw.embeddingDims ?? KIT_EMBEDDING_DIMS)) {
        embeddings.set(photo.id, l2Normalize(photo.embedding));
    } else {
        clipMissing += 1;
    }
    if (photo.hashes.length) {
        const entry: PhashEntry = { hashes: [...photo.hashes] };
        if (photo.color) {
            entry.color = photo.color;
        }
        phash.set(photo.id, entry);
    }
}

const clipIds = new Set(embeddings.keys());
const tagCounts = new Map<string, number>();
let tagSum = 0;
for (const photo of raw.photos) {
    if (!clipIds.has(photo.id)) {
        continue;
    }
    tagSum += photo.tags.length;
    for (const tag of photo.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
}

console.log(
    `model=${raw.embeddingModelId ?? "?"} dims=${raw.embeddingDims ?? "?"} v${raw.version}`,
);
console.log(
    `photos=${raw.photos.length} clip=${embeddings.size} noClip=${clipMissing} hashed=${phash.size} savedKits=${raw.kits.length} derivedExact=${raw.derivedKits.length}`,
);
console.log(
    `distinctTags=${tagCounts.size} meanTagsPerClipPhoto=${(
        tagSum / Math.max(1, embeddings.size)
    ).toFixed(2)}`,
);

const kits = buildEvalKits(raw, clipIds, MIN_COUNT);
const byArity = new Map<number, number>();
for (const kit of kits) {
    byArity.set(kit.tags.length, (byArity.get(kit.tags.length) ?? 0) + 1);
}
console.log(
    `\nevalKits=${kits.length} (minCount=${MIN_COUNT}, Jaccard dedup ${JACCARD_DEDUP})`,
);
console.log(
    `  arity ${[...byArity.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `${k}:${v}`)
        .join("  ")}  saved=${kits.filter((k) => k.source === "saved").length}`,
);

const random = mulberry32(FOLD_SEED);
const folds: Fold[] = [];
let negativeSizes = 0;
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
    const holdoutIds = shuffled.slice(seedCount);
    if (holdoutIds.length < 2) {
        continue;
    }
    const pool = [...clipIds].filter((id) => !members.has(id));
    shuffleInPlace(pool, random);
    const negativeIds = pool.slice(0, NEGATIVE_POOL);
    if (negativeIds.length < 16) {
        continue;
    }
    negativeSizes += negativeIds.length;
    folds.push({
        kit,
        seedIds,
        holdoutIds,
        negativeIds,
        meanPairwiseCosine: meanPairwiseCosine(kit.memberIds, embeddings),
    });
}
console.log(
    `folds=${folds.length} meanNegatives=${(
        negativeSizes / Math.max(1, folds.length)
    ).toFixed(0)}`,
);

const clipCentroid = new Map<string, number[]>();
const clipTrimmed = new Map<string, number[]>();
const clipMedoidsProd = new Map<string, number[][]>();
const clipMedoidsK3 = new Map<string, number[][]>();
const clipSoftmax = new Map<string, number[]>();
const rivalSetsByFold = new Map<string, number[][][]>();
const dhashMedoids = new Map<string, ReturnType<typeof pickKitMedoids>>();

for (const fold of folds) {
    const key = fold.kit.id;
    const centroid = buildKitEmbeddingCentroid(
        fold.seedIds,
        embeddings,
        MAX_SEEDS,
    );
    if (centroid) {
        clipCentroid.set(key, centroid);
    }
    const trimmed = trimmedCentroid(fold.seedIds, embeddings, 0.2);
    if (trimmed) {
        clipTrimmed.set(key, trimmed);
    }
    clipMedoidsProd.set(
        key,
        pickKitEmbeddingMedoids(fold.seedIds, embeddings, {
            maxMedoids: DEFAULT_KIT_EMBEDDING_GENOME.maxMedoids,
            minSeparation: DEFAULT_KIT_EMBEDDING_GENOME.minSeparation,
        }).map((medoid) => [...medoid.vector]),
    );
    clipMedoidsK3.set(
        key,
        pickKitEmbeddingMedoids(fold.seedIds, embeddings, {
            maxMedoids: 3,
            minSeparation: 0.08,
        }).map((medoid) => [...medoid.vector]),
    );
    if (fold.seedIds.some((id) => phash.has(id))) {
        dhashMedoids.set(
            key,
            pickKitMedoids(fold.seedIds, phash, {
                maxMedoids: 2,
                minSeparation: 10,
            }),
        );
    }
    const softmax = softmaxCentroid(fold.seedIds, embeddings, 12);
    if (softmax) {
        clipSoftmax.set(key, softmax);
    }
}

const cosineTo = (id: number, proto: number[] | undefined): number => {
    const vector = embeddings.get(id);
    if (!proto || !vector) {
        return Number.NEGATIVE_INFINITY;
    }
    let dot = 0;
    for (let i = 0; i < proto.length; i++) {
        dot += proto[i]! * vector[i]!;
    }
    return dot;
};

for (const fold of folds) {
    const rivals: number[][][] = [];
    for (const other of folds) {
        if (other.kit.id === fold.kit.id) {
            continue;
        }
        const overlap = jaccard(
            new Set(fold.kit.memberIds),
            new Set(other.kit.memberIds),
        );
        if (overlap >= 0.45) {
            continue;
        }
        const proto = clipCentroid.get(other.kit.id);
        if (proto) {
            rivals.push([proto]);
        }
        if (rivals.length >= 4) {
            break;
        }
    }
    rivalSetsByFold.set(fold.kit.id, rivals);
}

const methods: MethodResult[] = [];
const run = (name: string, scoreFn: ScoreFn): MethodResult => {
    const result = scoreMethod(name, folds, scoreFn);
    methods.push(result);
    console.log(
        `${name.padEnd(36)} auc=${result.auc.toFixed(3)} topK=${result.topK.toFixed(3)}`,
    );
    return result;
};

console.log("\n=== Fingerprint bake-off (AND membership) ===");

run("CLIP centroid", (id, fold) => cosineTo(id, clipCentroid.get(fold.kit.id)));

run("CLIP trimmed-centroid drop20%", (id, fold) =>
    cosineTo(id, clipTrimmed.get(fold.kit.id)),
);

run("CLIP softmax-centroid T=12", (id, fold) =>
    cosineTo(id, clipSoftmax.get(fold.kit.id)),
);

run("CLIP prod medoids (k≤5 densest)", (id, fold) => {
    const medoids = clipMedoidsProd.get(fold.kit.id) ?? [];
    const d = kitEmbeddingMinDistance(id, medoids, embeddings);
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
});

run("CLIP medoids k=3 sep=0.08", (id, fold) => {
    const medoids = clipMedoidsK3.get(fold.kit.id) ?? [];
    const d = kitEmbeddingMinDistance(id, medoids, embeddings);
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
});

run("CLIP density r=0.12", (id, fold) =>
    densityScore(id, fold.seedIds, embeddings, 0.12),
);

run("CLIP max-to-any-seed (ceiling)", (id, fold) => {
    const probe = embeddings.get(id);
    if (!probe) {
        return Number.NEGATIVE_INFINITY;
    }
    let best = Number.NEGATIVE_INFINITY;
    for (const seedId of fold.seedIds.slice(0, MAX_SEEDS)) {
        const seed = embeddings.get(seedId);
        if (!seed) {
            continue;
        }
        let dot = 0;
        for (let i = 0; i < probe.length; i++) {
            dot += probe[i]! * seed[i]!;
        }
        if (dot > best) {
            best = dot;
        }
    }
    return best;
});

run("dHash hybrid (prod knobs)", (id, fold) => {
    const medoids = dhashMedoids.get(fold.kit.id);
    if (!medoids?.length) {
        return Number.NEGATIVE_INFINITY;
    }
    const dist = kitNearnessDistance(id, medoids, phash, 8, 1.35, 22);
    return Number.isFinite(dist) ? -dist : Number.NEGATIVE_INFINITY;
});

run("CLIP centroid + dHash/80", (id, fold) => {
    const dot = cosineTo(id, clipCentroid.get(fold.kit.id));
    if (dot === Number.NEGATIVE_INFINITY) {
        return dot;
    }
    const medoids = dhashMedoids.get(fold.kit.id);
    if (!medoids?.length) {
        return dot;
    }
    const dist = kitNearnessDistance(id, medoids, phash, 8, 1.35, 22);
    const dHashTerm = Number.isFinite(dist) ? dist / 80 : 0.5;
    return dot - 0.15 * dHashTerm;
});

run("CLIP centroid, dHash-rerank top", (id, fold) => {
    const dot = cosineTo(id, clipCentroid.get(fold.kit.id));
    const medoids = dhashMedoids.get(fold.kit.id);
    if (!medoids?.length || dot < 0.72) {
        return dot;
    }
    const dist = kitNearnessDistance(id, medoids, phash, 8, 1.35, 22);
    if (!Number.isFinite(dist)) {
        return dot;
    }
    return dot + Math.max(0, (14 - dist) / 140);
});

run("CLIP centroid + rival λ=2", (id, fold) => {
    const proto = clipCentroid.get(fold.kit.id);
    const rivals = rivalSetsByFold.get(fold.kit.id) ?? [];
    if (!proto) {
        return Number.NEGATIVE_INFINITY;
    }
    const d = kitEmbeddingDistanceCompetitive(
        id,
        [proto],
        rivals,
        embeddings,
        { lambda: 2, tau: 0.12 },
    );
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
});

run("CLIP centroid + rival λ=0 (ablation)", (id, fold) => {
    const proto = clipCentroid.get(fold.kit.id);
    if (!proto) {
        return Number.NEGATIVE_INFINITY;
    }
    const d = kitEmbeddingDistanceCompetitive(
        id,
        [proto],
        rivalSetsByFold.get(fold.kit.id) ?? [],
        embeddings,
        { lambda: 0, tau: 0.12 },
    );
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
});

methods.sort((a, b) => b.auc - a.auc || b.topK - a.topK);
console.log("\nRanked by AUC:");
for (const method of methods) {
    console.log(
        `  ${method.name.padEnd(36)} auc=${method.auc.toFixed(3)} topK=${method.topK.toFixed(3)}`,
    );
}

const byArityAuc = (method: MethodResult): string => {
    const buckets = new Map<number, number[]>();
    for (const fold of folds) {
        const row = method.kitAuc.find((k) => k.id === fold.kit.id);
        if (!row) {
            continue;
        }
        const list = buckets.get(fold.kit.tags.length) ?? [];
        list.push(row.auc);
        buckets.set(fold.kit.tags.length, list);
    }
    return [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([arity, aucs]) => `a${arity}:${(mean(aucs) * 100).toFixed(0)}%`)
        .join(" ");
};

const centroid = methods.find((m) => m.name === "CLIP centroid");
const medoids = methods.find((m) => m.name.startsWith("CLIP prod medoids"));
let centroidWins = 0;
let medoidWins = 0;
let ties = 0;
if (centroid && medoids) {
    for (const row of centroid.kitAuc) {
        const other = medoids.kitAuc.find((k) => k.id === row.id);
        if (!other) {
            continue;
        }
        const delta = row.auc - other.auc;
        if (delta >= 0.02) {
            centroidWins += 1;
        } else if (delta <= -0.02) {
            medoidWins += 1;
        } else {
            ties += 1;
        }
    }
    console.log(
        `\nCentroid vs prod medoids per kit: centroid+2pp=${centroidWins} medoids+2pp=${medoidWins} tie=${ties}`,
    );
    console.log(`  centroid by arity  ${byArityAuc(centroid)}`);
    console.log(`  medoids by arity   ${byArityAuc(medoids)}`);
}

console.log("\n=== Default genome grid (CLIP only) ===");
const genomeRuns: MethodResult[] = [];
for (const lambda of [0, 2, 4, 8]) {
    const name = `centroid λ=${lambda}`;
    const result = scoreMethod(name, folds, (id, fold) => {
        const proto = clipCentroid.get(fold.kit.id);
        if (!proto) {
            return Number.NEGATIVE_INFINITY;
        }
        const d = kitEmbeddingDistanceCompetitive(
            id,
            [proto],
            rivalSetsByFold.get(fold.kit.id) ?? [],
            embeddings,
            { lambda, tau: 0.12 },
        );
        return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
    });
    genomeRuns.push(result);
    console.log(
        `${name.padEnd(24)} auc=${result.auc.toFixed(3)} topK=${result.topK.toFixed(3)}`,
    );
}
for (const tau of [0.04, 0.12, 0.24]) {
    const name = `centroid λ=2 τ=${tau}`;
    const result = scoreMethod(name, folds, (id, fold) => {
        const proto = clipCentroid.get(fold.kit.id);
        if (!proto) {
            return Number.NEGATIVE_INFINITY;
        }
        const d = kitEmbeddingDistanceCompetitive(
            id,
            [proto],
            rivalSetsByFold.get(fold.kit.id) ?? [],
            embeddings,
            { lambda: 2, tau },
        );
        return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
    });
    genomeRuns.push(result);
    console.log(
        `${name.padEnd(24)} auc=${result.auc.toFixed(3)} topK=${result.topK.toFixed(3)}`,
    );
}

const prodMedoidsLambda4 = scoreMethod(
    "prod medoids λ=4 (current default shape)",
    folds,
    (id, fold) => {
        const medoids = clipMedoidsProd.get(fold.kit.id) ?? [];
        const d = kitEmbeddingDistanceCompetitive(
            id,
            medoids,
            rivalSetsByFold.get(fold.kit.id) ?? [],
            embeddings,
            { lambda: 4, tau: 0.12 },
        );
        return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
    },
);
genomeRuns.push(prodMedoidsLambda4);
console.log(
    `${prodMedoidsLambda4.name.padEnd(24)} auc=${prodMedoidsLambda4.auc.toFixed(3)} topK=${prodMedoidsLambda4.topK.toFixed(3)}`,
);

let newDefaultWins = 0;
let oldDefaultWins = 0;
let defaultTies = 0;
const centroidL4 = genomeRuns.find((r) => r.name === "centroid λ=4");
if (centroidL4) {
    for (const row of centroidL4.kitAuc) {
        const other = prodMedoidsLambda4.kitAuc.find((k) => k.id === row.id);
        if (!other) {
            continue;
        }
        const delta = row.auc - other.auc;
        if (delta >= 0.02) {
            newDefaultWins += 1;
        } else if (delta <= -0.02) {
            oldDefaultWins += 1;
        } else {
            defaultTies += 1;
        }
    }
    console.log(
        `\nFair default: centroid λ=4 vs medoids λ=4 → centroid+2pp=${newDefaultWins} medoids+2pp=${oldDefaultWins} tie=${defaultTies}`,
    );
}

const best = methods[0]!;
const worstKits = [...best.kitAuc].sort((a, b) => a.auc - b.auc).slice(0, 8);
const bestKits = [...best.kitAuc].sort((a, b) => b.auc - a.auc).slice(0, 5);

const kitLines = folds
    .map((fold) => {
        const row = best.kitAuc.find((k) => k.id === fold.kit.id);
        return `  ${fold.kit.id} arity=${fold.kit.tags.length} n=${fold.kit.memberIds.length} hold=${fold.holdoutIds.length} meanCos=${fold.meanPairwiseCosine.toFixed(3)} auc=${(row?.auc ?? 0).toFixed(3)} src=${fold.kit.source}`;
    })
    .join("\n");

const methodTable = methods
    .map(
        (method) =>
            `| ${method.name} | ${(method.auc * 100).toFixed(1)}% | ${(method.topK * 100).toFixed(1)}% |`,
    )
    .join("\n");

const genomeTable = [...genomeRuns]
    .sort((a, b) => b.auc - a.auc)
    .map(
        (row) =>
            `| ${row.name} | ${(row.auc * 100).toFixed(1)}% | ${(row.topK * 100).toFixed(1)}% |`,
    )
    .join("\n");

const notes = `# Kit nearness — MobileCLIP-S2 research log

Living notes. Corpus is anonymised (\`t_\` / \`k_\` / \`d_\` ids only). Never paste
embeddings, hashes, or real names.

**Goal:** (1b) fingerprints → (1a) global default genome → (2) per-kit tuner.

**Corpus:** \`C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json\` (offline, not in git)

## Protocol

Production membership = **AND** (photo has every kit tag). Eval kits = real tag
combinations with CLIP coverage ≥ ${MIN_COUNT}, Jaccard ≥ ${JACCARD_DEDUP} keeps the
more specific combo. Per-kit negatives = 180 CLIP photos that are **not members
of that kit** (shared-pool negatives were invalid — discarded).

Membership task: 60/40 seed/holdout. Metrics: AUC and top-K (K = holdout size).

## Corpus (${new Date().toISOString().slice(0, 10)})

v${raw.version} \`${raw.embeddingModelId ?? "?"}\` dim ${raw.embeddingDims ?? "?"}
photos=${raw.photos.length} CLIP=${embeddings.size} hashed=${phash.size}
savedKits=${raw.kits.length} exactDerived=${raw.derivedKits.length}
distinctTags=${tagCounts.size} meanTags/photo=${(tagSum / Math.max(1, embeddings.size)).toFixed(2)}

Eval kits=${kits.length} folds=${folds.length}
arity: ${[...byArity.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(", ")}
saved among eval=${kits.filter((k) => k.source === "saved").length}

Per-kit (best fingerprint: ${best.name}):
${kitLines}

## Fingerprint bake-off (per-kit negatives)

| Method | AUC | top-K |
|---|---|---|
${methodTable}

Centroid vs prod medoids (no rival): **+2pp kits** centroid=${centroidWins} medoids=${medoidWins} tie=${ties}
Fair default **centroid λ=4 vs current medoids λ=4**: centroid+2pp=${newDefaultWins} medoids+2pp=${oldDefaultWins} tie=${defaultTies}

## Recommendation (worth implementing)

1. **Fingerprints:** keep **CLIP-S2 only** for kit membership ranking. dHash/color add ~0 AUC. Drop them from the CLIP nearness path (leave dHash for dedup).
2. **Automatic menu:** set \`DEFAULT_KIT_EMBEDDING_GENOME.useCentroid = 1\`. Plain mean of seed embeddings beats densest medoids on 19/35 kits (5 kits prefer medoids). Current default is medoids (\`useCentroid: 0\`).
3. **Rival λ=4** is already production; keep it. Higher λ still climbs on this 9-tag co-occurrence library — treat λ=8 as suspicious until per-kit tuner is re-measured (exclusivity can look like quality here).
4. **Do not bake** trimmed/softmax/density/max-to-seed — all worse than the mean.

Not yet: per-kit GA rewrite. If the menu is centroid+λ=4, the existing tuner still searches \`useCentroid\` and can keep medoids for the 5 kits that want them.

Hardest under ${best.name}: ${worstKits.map((k) => `${k.id} ${(k.auc * 100).toFixed(0)}%`).join(", ")}
Easiest: ${bestKits.map((k) => `${k.id} ${(k.auc * 100).toFixed(0)}%`).join(", ")}

## Default genome grid (centroid + rival)

| Genome | AUC | top-K |
|---|---|---|
${genomeTable}

## Status

- [x] Inspect corpus (S2, full CLIP coverage)
- [x] Build AND combo eval kits (min ${MIN_COUNT}, Jaccard dedup)
- [x] Fingerprint bake-off with honest per-kit negatives
- [x] Default rival-λ grid
- [ ] Per-kit tuner vs new defaults (if centroid wins, tuner genes may be flat)
- [ ] Implement if the lift is real and simple
`;

writeFileSync(NOTES_PATH, notes, "utf8");
console.log(`\nwrote ${NOTES_PATH}`);

