/**
 * Head-to-head: dHash kit nearness vs CLIP cosine on the same folds.
 *
 * Membership task (real kit nearness): hold out exact-tag-set members and
 * rank them above random non-members. Also reports the legacy dHash
 * near-dup-sibling protocol for continuity with GA notes.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-clip-baseline.ts ^
 *     --corpus "C:/Users/Elliot/Downloads/kit-nearness-corpus (1).json"
 */
import { readFileSync } from "node:fs";
import type { PhashEntry } from "../src/lib/crop-match";
import type {
    AnonymisedCorpusPhoto,
    AnonymisedDerivedKit,
    AnonymisedKitNearnessCorpus,
} from "../src/lib/kit-nearness-corpus-export";
import {
    DEFAULT_NEARBY_GENOME,
    buildCorpusEvalContext,
    evaluateNearnessGenome,
} from "../src/lib/kit-nearness-corpus-eval";
import {
    kitNearnessDistance,
    pickKitMedoids,
} from "../src/lib/kit-nearness-sort";

const getFlag = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    return process.argv[index + 1];
};

const corpusPath =
    getFlag("--corpus") ??
    "C:/Users/Elliot/Downloads/kit-nearness-corpus (1).json";

const minCount = Number(getFlag("--min-count") ?? "50");
const maxFolds = Number(getFlag("--max-folds") ?? "12");
const foldSeed = Number(getFlag("--fold-seed") ?? "42");
const seedFraction = 0.6;
const negativePoolSize = 180;

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

const photoHasExactTags = (
    photo: AnonymisedCorpusPhoto,
    kitTags: readonly string[],
): boolean => {
    if (photo.tags.length !== kitTags.length) {
        return false;
    }
    const have = new Set(photo.tags);
    return kitTags.every((t) => have.has(t));
};

const l2Normalize = (v: number[]): number[] => {
    let norm = 0;
    for (const x of v) {
        norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
};

const dot = (a: number[], b: number[]): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        s += a[i]! * b[i]!;
    }
    return s;
};

/** Higher = closer. L2-normalized CLIP → cosine = dot. */
const clipScoreToMedoids = (
    emb: number[],
    medoids: readonly number[][],
): number => {
    let best = Number.NEGATIVE_INFINITY;
    for (const m of medoids) {
        const s = dot(emb, m);
        if (s > best) {
            best = s;
        }
    }
    return best;
};

/** Farthest-first medoids in embedding space (cosine distance = 1 - dot). */
const pickClipMedoids = (
    seedIds: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    maxMedoids: number,
): number[][] => {
    const vectors: number[][] = [];
    for (const id of seedIds) {
        const e = embeddings.get(id);
        if (e) {
            vectors.push(e);
        }
    }
    if (!vectors.length) {
        return [];
    }
    const medoids: number[][] = [vectors[0]!];
    while (medoids.length < maxMedoids && medoids.length < vectors.length) {
        let bestIdx = -1;
        let bestDist = -1;
        for (let i = 0; i < vectors.length; i++) {
            const v = vectors[i]!;
            let minD = Number.POSITIVE_INFINITY;
            for (const m of medoids) {
                const d = 1 - dot(v, m);
                if (d < minD) {
                    minD = d;
                }
            }
            if (minD > bestDist) {
                bestDist = minD;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) {
            break;
        }
        medoids.push(vectors[bestIdx]!);
    }
    return medoids;
};

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
    const total = positiveScores.length * negativeScores.length;
    return (wins + 0.5 * ties) / total;
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

type MembershipFold = {
    kitId: string;
    seedIds: number[];
    holdoutIds: number[];
    meanPairwiseCosine: number;
};

const meanPairwiseCosine = (
    ids: readonly number[],
    embeddings: ReadonlyMap<number, number[]>,
    sampleCap: number = 40,
): number => {
    const vecs: number[][] = [];
    for (const id of ids) {
        const e = embeddings.get(id);
        if (e) {
            vecs.push(e);
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
            sum += dot(vecs[i]!, vecs[j]!);
            n += 1;
        }
    }
    return n === 0 ? 0 : sum / n;
};

const raw = JSON.parse(
    readFileSync(corpusPath, "utf8"),
) as AnonymisedKitNearnessCorpus;

const embeddings = new Map<number, number[]>();
const phashEntries = new Map<number, PhashEntry>();
for (const photo of raw.photos) {
    const embedding = photo.embedding;
    if (embedding?.length === raw.embeddingDims) {
        embeddings.set(photo.id, l2Normalize(embedding));
    }
    if (photo.hashes.length) {
        const entry: PhashEntry = { hashes: [...photo.hashes] };
        if (photo.color) {
            entry.color = photo.color;
        }
        phashEntries.set(photo.id, entry);
    }
}

console.log(
    `corpus v${raw.version} model=${raw.embeddingModelId ?? "?"} dims=${raw.embeddingDims ?? "?"}`,
);
console.log(
    `photos=${raw.photos.length} withCLIP=${embeddings.size} kits=${raw.kits.length} derivedKits=${raw.derivedKits.length}`,
);

const random = mulberry32(foldSeed);
const membershipFolds: MembershipFold[] = [];

for (const kit of raw.derivedKits as AnonymisedDerivedKit[]) {
    if (kit.count < minCount || kit.tags.length < 2) {
        continue;
    }
    const members = raw.photos
        .filter(
            (p) =>
                photoHasExactTags(p, kit.tags) &&
                embeddings.has(p.id) &&
                phashEntries.has(p.id),
        )
        .map((p) => p.id);
    if (members.length < minCount) {
        continue;
    }
    const shuffled = [...members];
    shuffleInPlace(shuffled, random);
    const seedCount = Math.max(
        2,
        Math.min(
            members.length - 2,
            Math.floor(members.length * seedFraction),
        ),
    );
    const seedIds = shuffled.slice(0, seedCount);
    const holdoutIds = shuffled.slice(seedCount);
    if (holdoutIds.length < 2 || seedIds.length < 2) {
        continue;
    }
    membershipFolds.push({
        kitId: kit.id,
        seedIds,
        holdoutIds,
        meanPairwiseCosine: meanPairwiseCosine(members, embeddings),
    });
}

membershipFolds.sort(
    (a, b) => b.holdoutIds.length - a.holdoutIds.length,
);
const folds = membershipFolds.slice(0, maxFolds);

const memberIdSet = new Set<number>();
for (const fold of folds) {
    for (const id of fold.seedIds) {
        memberIdSet.add(id);
    }
    for (const id of fold.holdoutIds) {
        memberIdSet.add(id);
    }
}
const negativePool = raw.photos
    .map((p) => p.id)
    .filter(
        (id) =>
            !memberIdSet.has(id) &&
            embeddings.has(id) &&
            phashEntries.has(id),
    );
shuffleInPlace(negativePool, random);
const negatives = negativePool.slice(0, negativePoolSize);

console.log(
    `\nMembership folds=${folds.length} (minCount=${minCount}) negatives=${negatives.length}`,
);
for (const fold of folds) {
    console.log(
        `  ${fold.kitId} meanCos=${fold.meanPairwiseCosine.toFixed(3)} seeds=${fold.seedIds.length} hold=${fold.holdoutIds.length}`,
    );
}

type MethodScores = { auc: number; topK: number };

const scoreMethod = (
    name: string,
    scoreFn: (id: number, fold: MembershipFold) => number,
): MethodScores => {
    const aucs: number[] = [];
    const topKs: number[] = [];
    for (const fold of folds) {
        const posScores = fold.holdoutIds.map((id) => scoreFn(id, fold));
        const negScores = negatives.map((id) => scoreFn(id, fold));
        aucs.push(mannWhitneyAuc(posScores, negScores));

        const candidates = [...fold.holdoutIds, ...negatives];
        const ranked = candidates
            .map((id) => ({ id, score: scoreFn(id, fold) }))
            .sort((a, b) => b.score - a.score)
            .map((r) => r.id);
        const k = Math.min(fold.holdoutIds.length, ranked.length);
        topKs.push(
            topKHitRate(ranked, new Set(fold.holdoutIds), k),
        );
    }
    const mean = (xs: number[]) =>
        xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const result = { auc: mean(aucs), topK: mean(topKs) };
    console.log(
        `${name}: auc=${result.auc.toFixed(3)} topK=${result.topK.toFixed(3)}  (pairwise-rank≈${(result.auc * 100).toFixed(0)}%  top-slots≈${(result.topK * 100).toFixed(0)}%)`,
    );
    return result;
};

console.log("\n=== Membership ranking (holdout kit members vs random) ===");

const clipMedoidsByFold = new Map<string, number[][]>();
const clipCentroidByFold = new Map<string, number[]>();
for (const fold of folds) {
    clipMedoidsByFold.set(
        fold.kitId,
        pickClipMedoids(fold.seedIds, embeddings, 6),
    );
    const acc = new Array(512).fill(0) as number[];
    let n = 0;
    for (const id of fold.seedIds) {
        const e = embeddings.get(id);
        if (!e) {
            continue;
        }
        for (let i = 0; i < 512; i++) {
            acc[i]! += e[i]!;
        }
        n += 1;
    }
    if (n > 0) {
        clipCentroidByFold.set(fold.kitId, l2Normalize(acc));
    }
}

const clip = scoreMethod("CLIP cosine→centroid", (id, fold) => {
    const emb = embeddings.get(id);
    const centroid = clipCentroidByFold.get(fold.kitId);
    if (!emb || !centroid) {
        return Number.NEGATIVE_INFINITY;
    }
    return dot(emb, centroid);
});

scoreMethod("CLIP cosine→medoids(6)", (id, fold) => {
    const emb = embeddings.get(id);
    const medoids = clipMedoidsByFold.get(fold.kitId);
    if (!emb || !medoids?.length) {
        return Number.NEGATIVE_INFINITY;
    }
    return clipScoreToMedoids(emb, medoids);
});

const dhashMedoidsByFold = new Map<
    string,
    ReturnType<typeof pickKitMedoids>
>();
for (const fold of folds) {
    dhashMedoidsByFold.set(
        fold.kitId,
        pickKitMedoids(fold.seedIds, phashEntries, {
            maxMedoids: DEFAULT_NEARBY_GENOME.maxMedoids,
            minSeparation: DEFAULT_NEARBY_GENOME.minSeparation,
        }),
    );
}

const dhash = scoreMethod("dHash prod hybrid (negated dist)", (id, fold) => {
    const medoids = dhashMedoidsByFold.get(fold.kitId);
    if (!medoids?.length) {
        return Number.NEGATIVE_INFINITY;
    }
    const dist = kitNearnessDistance(
        id,
        medoids,
        phashEntries,
        DEFAULT_NEARBY_GENOME.colorRadius,
        DEFAULT_NEARBY_GENOME.colorBonus,
        DEFAULT_NEARBY_GENOME.structureGate,
    );
    return Number.isFinite(dist) ? -dist : Number.NEGATIVE_INFINITY;
});

console.log(
    `\nΔ CLIP−dHash: auc=${(clip.auc - dhash.auc).toFixed(3)} topK=${(clip.topK - dhash.topK).toFixed(3)}`,
);

console.log(
    "\n=== Legacy dHash near-dup sibling protocol (GA continuity) ===",
);
const legacyCtx = buildCorpusEvalContext(raw, {
    minCount,
    maxFolds,
    foldSeed,
    negativePoolSize,
    visualPositiveThreshold: 14,
    minVisualPositives: 3,
    maxSeedsPerFold: 60,
    maxVisualPositivesPerFold: 32,
});
console.log(
    `legacy folds=${legacyCtx.folds.length} negatives=${legacyCtx.negativePool.length}`,
);
if (legacyCtx.folds.length) {
    const legacy = evaluateNearnessGenome(legacyCtx, DEFAULT_NEARBY_GENOME);
    console.log(
        `dHash legacy fitness=${legacy.fitness.toFixed(4)} auc=${legacy.holdoutAuc.toFixed(3)} topK=${legacy.holdoutTopK.toFixed(3)} excl=${legacy.exclAuc.toFixed(3)}`,
    );
}
