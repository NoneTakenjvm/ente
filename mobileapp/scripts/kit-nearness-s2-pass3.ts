/**
 * Pass 3: stability, rival policies, mixed fitness, GA vs grid,
 * Mahalanobis+λ, saved-only, leave-one-kit-out.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass3.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    buildKitEmbeddingCentroid,
    kitEmbeddingDistanceCompetitive,
    pickKitEmbeddingMedoids,
} from "../src/lib/kit-nearness-sort";
import {
    KIT_EMBEDDING_GENE_SPECS,
    type KitEmbeddingNearnessGenome,
} from "../src/lib/kit-nearness-embedding-genome";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";

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
const DIM = 512;

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};
const shuffleInPlace = <T>(items: T[], rng: () => number): void => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
    }
};
const mean = (xs: readonly number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const comboKey = (tags: readonly string[]): string => [...tags].sort().join("|");
const hasAll = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.length > 0 && kit.every((t) => have.has(t));
const sharesAny = (have: ReadonlySet<string>, kit: readonly string[]): boolean =>
    kit.some((t) => have.has(t));
const jaccardNum = (a: ReadonlySet<number>, b: ReadonlySet<number>): number => {
    let inter = 0;
    for (const id of a) {
        if (b.has(id)) {
            inter += 1;
        }
    }
    const u = a.size + b.size - inter;
    return u === 0 ? 0 : inter / u;
};
const tagSubset = (a: readonly string[], b: readonly string[]): boolean => {
    const s = new Set(b);
    return a.length < b.length && a.every((t) => s.has(t));
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
const auc = (pos: readonly number[], neg: readonly number[]): number => {
    if (!pos.length || !neg.length) {
        return 0.5;
    }
    let w = 0;
    let t = 0;
    for (const p of pos) {
        for (const n of neg) {
            if (p > n) {
                w += 1;
            } else if (p === n) {
                t += 1;
            }
        }
    }
    return (w + 0.5 * t) / (pos.length * neg.length);
};
const topK = (
    ranked: readonly number[],
    pos: ReadonlySet<number>,
    k: number,
): number => {
    if (k <= 0) {
        return 0;
    }
    let h = 0;
    for (let i = 0; i < k && i < ranked.length; i++) {
        if (pos.has(ranked[i]!)) {
            h += 1;
        }
    }
    return h / k;
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
};

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnonymisedKitNearnessCorpus;
const embeddings = new Map<number, Float32Array>();
const tagSets = new Map<number, Set<string>>();
for (const p of raw.photos) {
    tagSets.set(p.id, new Set(p.tags));
    if (p.embedding?.length === (raw.embeddingDims ?? DIM)) {
        embeddings.set(p.id, Float32Array.from(l2(p.embedding)));
    }
}
const numberEmb = new Map<number, number[]>();
for (const [id, v] of embeddings) {
    numberEmb.set(id, Array.from(v));
}
const clipIds = [...embeddings.keys()];

const countCombos = (
    photos: AnonymisedKitNearnessCorpus["photos"],
    arity: number,
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
    for (const [k, ids] of counts) {
        if (ids.length < MIN_COUNT) {
            counts.delete(k);
        }
    }
    return counts;
};

const buildKits = (): EvalKit[] => {
    const clipPhotos = raw.photos.filter((p) => embeddings.has(p.id));
    const kits: EvalKit[] = [];
    for (const saved of raw.kits) {
        if (!saved.tags.length) {
            continue;
        }
        const memberIds = clipPhotos
            .filter((p) => hasAll(new Set(p.tags), saved.tags))
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
        const ranked = [...countCombos(clipPhotos, arity).entries()].sort(
            (a, b) => b[1].length - a[1].length,
        );
        let n = 0;
        for (const [key, ids] of ranked) {
            if (n >= MAX_KITS_PER_ARITY) {
                break;
            }
            kits.push({
                id: `and${arity}_${String(n + 1).padStart(2, "0")}`,
                source: "and-combo",
                tags: key.split("|"),
                memberIds: ids,
            });
            n += 1;
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
        if (sets.some((s) => jaccardNum(members, s) >= JACCARD_DEDUP)) {
            continue;
        }
        kept.push(kit);
        sets.push(members);
    }
    return kept;
};

const allKits = buildKits();
const makeFolds = (kits: EvalKit[], seed: number): Fold[] => {
    const rng = mulberry32(seed);
    const folds: Fold[] = [];
    for (const kit of kits) {
        const members = new Set(kit.memberIds);
        const shuffled = [...kit.memberIds];
        shuffleInPlace(shuffled, rng);
        const seedCount = Math.max(
            2,
            Math.min(
                shuffled.length - 2,
                Math.floor(shuffled.length * SEED_FRACTION),
            ),
        );
        const seedIds = shuffled.slice(0, seedCount);
        let hold = shuffled.slice(seedCount);
        if (hold.length < 2) {
            continue;
        }
        shuffleInPlace(hold, rng);
        hold = hold.slice(0, HOLD_CAP);
        const easy: number[] = [];
        const hard: number[] = [];
        const pool = [...clipIds];
        shuffleInPlace(pool, rng);
        for (const id of pool) {
            if (members.has(id)) {
                continue;
            }
            const tags = tagSets.get(id);
            if (!tags || hasAll(tags, kit.tags)) {
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
        folds.push({ kit, seedIds, holdoutIds: hold, easyNeg: easy, hardNeg: hard });
    }
    return folds;
};

type Cache = {
    centroid: number[];
    kmeans2: number[][];
    medoids3: number[][];
    mu: number[];
    invVar: Float32Array;
    medianMahal: number;
};
const kMeans2 = (pts: Float32Array[]): number[][] => {
    if (pts.length < 2) {
        return pts.length ? [l2([...pts[0]!])] : [];
    }
    const c0 = l2([...pts[0]!]);
    let far = 0;
    let farD = -1;
    for (let i = 0; i < pts.length; i++) {
        const d = 1 - dot(pts[i]!, c0);
        if (d > farD) {
            farD = d;
            far = i;
        }
    }
    const centers = [c0, l2([...pts[far]!])];
    for (let iter = 0; iter < 6; iter++) {
        const acc = [new Array(DIM).fill(0), new Array(DIM).fill(0)];
        const n = [0, 0];
        for (const p of pts) {
            const i = 1 - dot(p, centers[0]!) < 1 - dot(p, centers[1]!) ? 0 : 1;
            n[i]! += 1;
            for (let d = 0; d < DIM; d++) {
                acc[i]![d]! += p[d]!;
            }
        }
        for (let i = 0; i < 2; i++) {
            if (!n[i]) {
                continue;
            }
            for (let d = 0; d < DIM; d++) {
                acc[i]![d]! /= n[i]!;
            }
            centers[i] = l2(acc[i]!);
        }
    }
    return centers;
};
const mahalOf = (v: ArrayLike<number>, cache: Cache): number => {
    let s = 0;
    for (let i = 0; i < DIM; i++) {
        const d = v[i]! - cache.mu[i]!;
        s += d * d * cache.invVar[i]!;
    }
    return s;
};
const buildCache = (fold: Fold): Cache => {
    const seedIds = fold.seedIds.slice(0, SEED_CAP);
    const pts: Float32Array[] = [];
    for (const id of seedIds) {
        const v = embeddings.get(id);
        if (v) {
            pts.push(v);
        }
    }
    const centroid =
        buildKitEmbeddingCentroid(seedIds, numberEmb, SEED_CAP) ??
        new Array(DIM).fill(0);
    const mu = centroid;
    const invVar = new Float32Array(DIM);
    if (pts.length > 1) {
        for (let i = 0; i < DIM; i++) {
            let s = 0;
            for (const p of pts) {
                const d = p[i]! - mu[i]!;
                s += d * d;
            }
            invVar[i] = 1 / (s / (pts.length - 1) + 1e-3);
        }
    } else {
        invVar.fill(1);
    }
    const mahals = pts.map((p) => {
        let s = 0;
        for (let i = 0; i < DIM; i++) {
            const d = p[i]! - mu[i]!;
            s += d * d * invVar[i]!;
        }
        return s;
    });
    mahals.sort((a, b) => a - b);
    const medianMahal = mahals[Math.floor(mahals.length / 2)] ?? 1;
    return {
        centroid,
        kmeans2: kMeans2(pts),
        medoids3: pickKitEmbeddingMedoids(seedIds, numberEmb, {
            maxMedoids: 3,
            minSeparation: 0.08,
            maxSeeds: SEED_CAP,
        }).map((m) => [...m.vector]),
        mu,
        invVar,
        medianMahal,
    };
};

type Metrics = { easy: number; hard: number; mix: number; hardTopK: number };
const metricsOf = (
    fold: Fold,
    score: (id: number) => number,
): Metrics => {
    const pos = fold.holdoutIds.map(score);
    const easyS = fold.easyNeg.map(score);
    const hardS = fold.hardNeg.map(score);
    const posSet = new Set(fold.holdoutIds);
    const rankedHard = [...fold.holdoutIds, ...fold.hardNeg]
        .map((id) => ({ id, s: score(id) }))
        .sort((a, b) => b.s - a.s)
        .map((r) => r.id);
    const easy = auc(pos, easyS);
    const hard = auc(pos, hardS);
    return {
        easy,
        hard,
        mix: 0.5 * easy + 0.5 * hard,
        hardTopK: topK(
            rankedHard,
            posSet,
            Math.min(fold.holdoutIds.length, rankedHard.length),
        ),
    };
};
const meanMetrics = (rows: Metrics[]): Metrics => ({
    easy: mean(rows.map((r) => r.easy)),
    hard: mean(rows.map((r) => r.hard)),
    mix: mean(rows.map((r) => r.mix)),
    hardTopK: mean(rows.map((r) => r.hardTopK)),
});

type RivalMode =
    | "jaccard4"
    | "jaccardAll"
    | "clipnn4"
    | "saved4"
    | "savedAll"
    | "subset"
    | "allKits";
const rivalSets = (
    folds: Fold[],
    caches: Map<string, Cache>,
    mode: RivalMode,
    cap?: number,
): Map<string, number[][][]> => {
    const saved = new Set(
        allKits.filter((k) => k.source === "saved").map((k) => k.id),
    );
    const out = new Map<string, number[][][]>();
    for (const fold of folds) {
        const self = caches.get(fold.kit.id)?.centroid;
        type Cand = { id: string; rank: number; proto: number[] };
        const cands: Cand[] = [];
        for (const other of folds) {
            if (other.kit.id === fold.kit.id) {
                continue;
            }
            const proto = caches.get(other.kit.id)?.centroid;
            if (!proto || !self) {
                continue;
            }
            const j = jaccardNum(
                new Set(fold.kit.memberIds),
                new Set(other.kit.memberIds),
            );
            const clipD = 1 - dot(self, proto);
            if (mode === "saved4" || mode === "savedAll") {
                if (!saved.has(other.kit.id)) {
                    continue;
                }
            }
            if (mode === "subset") {
                const sub =
                    tagSubset(fold.kit.tags, other.kit.tags) ||
                    tagSubset(other.kit.tags, fold.kit.tags);
                if (!sub) {
                    continue;
                }
            }
            if (mode === "jaccard4" || mode === "jaccardAll") {
                if (j >= 0.45 || j <= 0) {
                    continue;
                }
            }
            let rank = 0;
            if (mode === "jaccard4" || mode === "jaccardAll") {
                rank = -j;
            } else if (mode === "clipnn4") {
                rank = clipD;
            } else if (mode === "saved4") {
                rank = -j;
            }
            cands.push({ id: other.kit.id, rank, proto });
        }
        cands.sort((a, b) => a.rank - b.rank);
        const limit =
            cap ??
            (mode === "jaccardAll" || mode === "savedAll" || mode === "allKits" ?
                cands.length
            :   4);
        out.set(
            fold.kit.id,
            cands.slice(0, limit).map((c) => [c.proto]),
        );
    }
    return out;
};

const compete = (
    id: number,
    selected: number[][],
    rivals: number[][][],
    lambda: number,
    tau: number,
): number => {
    const d = kitEmbeddingDistanceCompetitive(id, selected, rivals, numberEmb, {
        lambda,
        tau,
    });
    return Number.isFinite(d) ? -d : Number.NEGATIVE_INFINITY;
};

const fmt = (m: Metrics): string =>
    `easy=${(m.easy * 100).toFixed(1)} hard=${(m.hard * 100).toFixed(1)} mix=${(m.mix * 100).toFixed(1)} hardTopK=${(m.hardTopK * 100).toFixed(1)}`;

const logLines: string[] = [];
const note = (s: string) => {
    console.log(s);
    logLines.push(s);
};

const evalFolds = (
    folds: Fold[],
    caches: Map<string, Cache>,
    rivals: Map<string, number[][][]>,
    score: (fold: Fold, cache: Cache, rivals: number[][][], id: number) => number,
): Metrics =>
    meanMetrics(
        folds.map((fold) => {
            const cache = caches.get(fold.kit.id)!;
            const r = rivals.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => score(fold, cache, r, id));
        }),
    );

const kitsAll = allKits;
note(`pass3 kits=${kitsAll.length} saved=${kitsAll.filter((k) => k.source === "saved").length}`);

const foldsA = makeFolds(kitsAll, 42);
const cachesA = new Map<string, Cache>();
for (const f of foldsA) {
    cachesA.set(f.kit.id, buildCache(f));
}
const rivJac = rivalSets(foldsA, cachesA, "jaccard4");
note(`foldsA=${foldsA.length} savedFolds=${foldsA.filter((f) => f.kit.source === "saved").length}`);

note("\n=== 1. Rival policies (centroid λ=8 τ=0.06) ===");
for (const mode of [
    "jaccard4",
    "jaccardAll",
    "clipnn4",
    "saved4",
    "savedAll",
    "subset",
    "allKits",
] as const) {
    const riv = rivalSets(foldsA, cachesA, mode);
    const m = evalFolds(foldsA, cachesA, riv, (_f, c, r, id) =>
        compete(id, [c.centroid], r, 8, 0.06),
    );
    note(
        `  ${mode.padEnd(10)} ${fmt(m)}  meanRivals=${mean([...riv.values()].map((x) => x.length)).toFixed(1)}`,
    );
}
note("  rival-count sweep (jaccard-ranked, λ=8 τ=0.06)");
for (const k of [0, 1, 2, 4, 8, 16]) {
    const riv = rivalSets(foldsA, cachesA, "jaccardAll", k);
    const m = evalFolds(foldsA, cachesA, riv, (_f, c, r, id) =>
        compete(id, [c.centroid], r, 8, 0.06),
    );
    note(`    k=${String(k).padEnd(3)} ${fmt(m)}`);
}

note("\n=== 2. Prototypes × λ=8 (jaccard rivals) ===");
const protoRuns: { name: string; m: Metrics }[] = [];
const runProto = (
    name: string,
    fn: (c: Cache, r: number[][][], id: number) => number,
) => {
    const m = evalFolds(foldsA, cachesA, rivJac, (_f, c, r, id) => fn(c, r, id));
    protoRuns.push({ name, m });
    note(`  ${name.padEnd(28)} ${fmt(m)}`);
};
runProto("cen λ=0", (c, _r, id) => compete(id, [c.centroid], [], 0, 0.12));
runProto("cen λ=8", (c, r, id) => compete(id, [c.centroid], r, 8, 0.06));
runProto("med3 λ=8", (c, r, id) => compete(id, c.medoids3, r, 8, 0.06));
runProto("kmeans2 λ=8", (c, r, id) => compete(id, c.kmeans2, r, 8, 0.06));
runProto("mahal λ=0", (c, _r, id) => {
    const v = embeddings.get(id);
    return v ? -mahalOf(v, c) / c.medianMahal : Number.NEGATIVE_INFINITY;
});
runProto("mahal + rival-steal", (c, r, id) => {
    const v = embeddings.get(id);
    if (!v) {
        return Number.NEGATIVE_INFINITY;
    }
    const mahal = -mahalOf(v, c) / c.medianMahal;
    const steal =
        compete(id, [c.centroid], r, 8, 0.06) -
        compete(id, [c.centroid], [], 0, 0.12);
    return mahal + steal;
});
runProto("cen λ=8 + 0.15 mahal", (c, r, id) => {
    const v = embeddings.get(id);
    if (!v) {
        return Number.NEGATIVE_INFINITY;
    }
    return (
        compete(id, [c.centroid], r, 8, 0.06) +
        0.15 * (-mahalOf(v, c) / c.medianMahal)
    );
});
runProto("cen λ=8 + 0.4 mahal", (c, r, id) => {
    const v = embeddings.get(id);
    if (!v) {
        return Number.NEGATIVE_INFINITY;
    }
    return (
        compete(id, [c.centroid], r, 8, 0.06) +
        0.4 * (-mahalOf(v, c) / c.medianMahal)
    );
});

note("\n=== 2b. λ × τ heatmap (cen, jaccard4) fold A then confirm B ===");
const lambdas = [0, 2, 4, 6, 8, 10, 12, 16];
const taus = [0.02, 0.04, 0.06, 0.08, 0.12, 0.2];
type HeatCell = { l: number; t: number; a: Metrics; b?: Metrics };
const heat: HeatCell[] = [];
for (const l of lambdas) {
    const row: string[] = [`  λ=${String(l).padEnd(3)}`];
    for (const t of taus) {
        const m = evalFolds(foldsA, cachesA, rivJac, (_f, c, r, id) =>
            compete(id, [c.centroid], r, l, t),
        );
        heat.push({ l, t, a: m });
        row.push((m.hard * 100).toFixed(1));
    }
    if (l === lambdas[0]) {
        note(`  ${"".padEnd(8)}${taus.map((t) => `τ${t}`.padStart(7)).join("")}`);
    }
    note(row.map((x, i) => (i === 0 ? x : x.padStart(7))).join(""));
}
heat.sort((x, y) => y.a.hard - x.a.hard);
note(
    `  best-A: λ=${heat[0]!.l} τ=${heat[0]!.t} ${fmt(heat[0]!.a)}`,
);

note("\n=== 3. Seed cap (cen λ=8) ===");
for (const cap of [40, 80, 150, 400]) {
    const m = meanMetrics(
        foldsA.map((fold) => {
            const proto =
                buildKitEmbeddingCentroid(fold.seedIds, numberEmb, cap) ??
                cachesA.get(fold.kit.id)!.centroid;
            const r = rivJac.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => compete(id, [proto], r, 8, 0.06));
        }),
    );
    note(`  cap=${String(cap).padEnd(4)} ${fmt(m)}`);
}

note("\n=== 4. Saved-preset kits only ===");
const savedFolds = foldsA.filter((f) => f.kit.source === "saved");
note(`  n=${savedFolds.length}`);
const evalSaved = (
    name: string,
    fn: (c: Cache, r: number[][][], id: number) => number,
) => {
    const m = meanMetrics(
        savedFolds.map((fold) => {
            const c = cachesA.get(fold.kit.id)!;
            const r = rivJac.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => fn(c, r, id));
        }),
    );
    note(`  ${name.padEnd(22)} ${fmt(m)}`);
};
evalSaved("prod med3 λ=4 τ=0.12", (c, r, id) =>
    compete(id, c.medoids3, r, 4, 0.12),
);
evalSaved("cen λ=4 τ=0.12", (c, r, id) => compete(id, [c.centroid], r, 4, 0.12));
evalSaved("cen λ=8 τ=0.06", (c, r, id) => compete(id, [c.centroid], r, 8, 0.06));
evalSaved("cen λ=8 τ=0.04", (c, r, id) => compete(id, [c.centroid], r, 8, 0.04));
evalSaved("cen λ=10 τ=0.06", (c, r, id) => compete(id, [c.centroid], r, 10, 0.06));
evalSaved("cen λ=12 τ=0.06", (c, r, id) => compete(id, [c.centroid], r, 12, 0.06));
note("  production-like rivals = all other saved kits");
const rivSavedAll = rivalSets(foldsA, cachesA, "savedAll");
const evalSavedProd = (
    name: string,
    fn: (c: Cache, r: number[][][], id: number) => number,
) => {
    const m = meanMetrics(
        savedFolds.map((fold) => {
            const c = cachesA.get(fold.kit.id)!;
            const r = rivSavedAll.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => fn(c, r, id));
        }),
    );
    note(`  ${name.padEnd(22)} ${fmt(m)}`);
};
evalSavedProd("prod med3 λ=4", (c, r, id) => compete(id, c.medoids3, r, 4, 0.12));
evalSavedProd("cen λ=8 τ=0.06", (c, r, id) =>
    compete(id, [c.centroid], r, 8, 0.06),
);
evalSavedProd("cen λ=12 τ=0.06", (c, r, id) =>
    compete(id, [c.centroid], r, 12, 0.06),
);

note("\n=== 5. Multi-seed stability (hard AUC) ===");
const stabGenomes = [
    { n: "prod", l: 4, t: 0.12, med: true },
    { n: "cen4/0.12", l: 4, t: 0.12, med: false },
    { n: "cen6/0.06", l: 6, t: 0.06, med: false },
    { n: "cen8/0.06", l: 8, t: 0.06, med: false },
    { n: "cen8/0.04", l: 8, t: 0.04, med: false },
    { n: "cen10/0.06", l: 10, t: 0.06, med: false },
    { n: "cen12/0.06", l: 12, t: 0.06, med: false },
];
const stabSeeds = [7, 42, 99, 123, 2024];
note(
    `  ${"seed".padEnd(8)}${stabGenomes.map((g) => g.n.padStart(12)).join("")}`,
);
const stabMeans = stabGenomes.map(() => [] as number[]);
for (const seed of stabSeeds) {
    const folds = makeFolds(kitsAll, seed);
    const caches = new Map<string, Cache>();
    for (const f of folds) {
        caches.set(f.kit.id, buildCache(f));
    }
    const riv = rivalSets(folds, caches, "jaccard4");
    const cells: string[] = [];
    stabGenomes.forEach((g, gi) => {
        const m = meanMetrics(
            folds.map((fold) => {
                const c = caches.get(fold.kit.id)!;
                const r = riv.get(fold.kit.id) ?? [];
                const sel = g.med ? c.medoids3 : [c.centroid];
                return metricsOf(fold, (id) => compete(id, sel, r, g.l, g.t));
            }),
        );
        stabMeans[gi]!.push(m.hard);
        cells.push((m.hard * 100).toFixed(1).padStart(12));
    });
    note(`  ${String(seed).padEnd(8)}${cells.join("")}`);
}
note(
    `  ${"mean".padEnd(8)}${stabMeans.map((xs) => ((mean(xs) * 100).toFixed(1)).padStart(12)).join("")}`,
);
note(
    `  ${"min".padEnd(8)}${stabMeans.map((xs) => ((Math.min(...xs) * 100).toFixed(1)).padStart(12)).join("")}`,
);

note("\n=== 6. Leave-one-kit-out default ===");
const loloCands = [
    { n: "cen4/0.12", l: 4, t: 0.12 },
    { n: "cen6/0.06", l: 6, t: 0.06 },
    { n: "cen8/0.06", l: 8, t: 0.06 },
    { n: "cen8/0.04", l: 8, t: 0.04 },
    { n: "cen10/0.06", l: 10, t: 0.06 },
    { n: "cen12/0.06", l: 12, t: 0.06 },
];
const loloPick = new Map<string, number>();
const loloHard: number[] = [];
for (const held of foldsA) {
    let best = loloCands[0]!;
    let bestMean = -1;
    for (const g of loloCands) {
        const others = foldsA.filter((f) => f.kit.id !== held.kit.id);
        const mh = mean(
            others.map((fold) => {
                const c = cachesA.get(fold.kit.id)!;
                const r = rivJac.get(fold.kit.id) ?? [];
                return metricsOf(fold, (id) =>
                    compete(id, [c.centroid], r, g.l, g.t),
                ).hard;
            }),
        );
        if (mh > bestMean) {
            bestMean = mh;
            best = g;
        }
    }
    loloPick.set(best.n, (loloPick.get(best.n) ?? 0) + 1);
    const c = cachesA.get(held.kit.id)!;
    const r = rivJac.get(held.kit.id) ?? [];
    loloHard.push(
        metricsOf(held, (id) => compete(id, [c.centroid], r, best.l, best.t)).hard,
    );
}
note(
    `  picks: ${[...loloPick.entries()].map(([k, v]) => `${k}×${v}`).join("  ")}`,
);
note(`  LOO hard mean=${(mean(loloHard) * 100).toFixed(1)}%`);
const always8 = mean(
    foldsA.map((fold) => {
        const c = cachesA.get(fold.kit.id)!;
        const r = rivJac.get(fold.kit.id) ?? [];
        return metricsOf(fold, (id) =>
            compete(id, [c.centroid], r, 8, 0.06),
        ).hard;
    }),
);
note(`  always cen8/0.06 hard=${(always8 * 100).toFixed(1)}%`);

note("\n=== 7. Global GA (gene bounds, fitness=mean hard) ===");
type GVec = number[];
const clampGene = (values: number[]): GVec =>
    KIT_EMBEDDING_GENE_SPECS.map((spec, i) => {
        let v = values[i] ?? spec.lo;
        v = Math.min(spec.hi, Math.max(spec.lo, v));
        return spec.integer ? Math.round(v) : v;
    });
const genomeFrom = (v: GVec): KitEmbeddingNearnessGenome => ({
    rivalTau: v[0]!,
    rivalLambda: v[1]!,
    maxMedoids: v[2]!,
    minSeparation: v[3]!,
    useCentroid: v[4]!,
});
const scoreVec = (v: GVec, folds: Fold[], caches: Map<string, Cache>, riv: Map<string, number[][][]>): Metrics => {
    const g = genomeFrom(clampGene(v));
    return meanMetrics(
        folds.map((fold) => {
            const c = caches.get(fold.kit.id)!;
            const r = riv.get(fold.kit.id) ?? [];
            const sel =
                g.useCentroid >= 0.5 ? [c.centroid] :
                    pickKitEmbeddingMedoids(fold.seedIds.slice(0, SEED_CAP), numberEmb, {
                        maxMedoids: g.maxMedoids,
                        minSeparation: g.minSeparation,
                        maxSeeds: SEED_CAP,
                    }).map((m) => [...m.vector]);
            return metricsOf(fold, (id) =>
                compete(id, sel.length ? sel : [c.centroid], r, g.rivalLambda, g.rivalTau),
            );
        }),
    );
};
const clampGeneExt = (values: number[]): GVec => {
    const v = clampGene(values);
    v[1] = Math.min(16, Math.max(0, values[1] ?? 0));
    return v;
};
const scoreVecExt = (
    v: GVec,
    folds: Fold[],
    caches: Map<string, Cache>,
    riv: Map<string, number[][][]>,
): Metrics => {
    const g = genomeFrom(clampGene(v));
    g.rivalLambda = Math.min(16, Math.max(0, v[1]!));
    return meanMetrics(
        folds.map((fold) => {
            const c = caches.get(fold.kit.id)!;
            const r = riv.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) =>
                compete(id, [c.centroid], r, g.rivalLambda, g.rivalTau),
            );
        }),
    );
};
const runGa = (
    folds: Fold[],
    caches: Map<string, Cache>,
    riv: Map<string, number[][][]>,
    fitness: (m: Metrics) => number,
    label: string,
    opts?: { extendLambda?: boolean; restarts?: number },
): { g: KitEmbeddingNearnessGenome; m: Metrics } => {
    const extend = opts?.extendLambda === true;
    const clamp = extend ? clampGeneExt : clampGene;
    const restarts = opts?.restarts ?? 2;
    let bestV = clamp([0.06, 8, 3, 0.08, 1]);
    let bestF = -Infinity;
    let bestM: Metrics = { easy: 0, hard: 0, mix: 0, hardTopK: 0 };
    let evals = 0;
    for (let restart = 0; restart < restarts; restart++) {
        const rng = mulberry32(7 + restart * 97);
        const randVec = (): GVec => {
            const specs = KIT_EMBEDDING_GENE_SPECS;
            const raw = specs.map((spec, i) => {
                if (extend && i === 1) {
                    return rng() * 16;
                }
                return spec.lo + rng() * (spec.hi - spec.lo);
            });
            return clamp(raw);
        };
        const popN = 24;
        const gens = 32;
        let pop: GVec[] = [];
        pop.push(clamp([0.06, 8, 3, 0.08, 1]));
        pop.push(clamp([0.12, 4, 3, 0.08, 0]));
        pop.push(clamp([0.12, 4, 3, 0.08, 1]));
        pop.push(clamp([0.04, extend ? 12 : 8, 1, 0.08, 1]));
        while (pop.length < popN) {
            pop.push(randVec());
        }
        const cacheFit = new Map<string, { f: number; m: Metrics }>();
        const evalV = (v: GVec) => {
            const clamped = clamp(v);
            const key = clamped
                .map((x, i) =>
                    i === 2 || i === 4 ? String(x) : x.toFixed(4),
                )
                .join("|");
            const hit = cacheFit.get(key);
            if (hit) {
                return hit;
            }
            const m = extend ?
                scoreVecExt(clamped, folds, caches, riv)
            :   scoreVec(clamped, folds, caches, riv);
            const f = fitness(m);
            const row = { f, m };
            cacheFit.set(key, row);
            return row;
        };
        for (let gen = 0; gen < gens; gen++) {
            const scored = pop.map((v) => ({ v, ...evalV(v) }));
            scored.sort((a, b) => b.f - a.f);
            if (scored[0]!.f > bestF) {
                bestF = scored[0]!.f;
                bestV = scored[0]!.v;
                bestM = scored[0]!.m;
            }
            const next: GVec[] = scored.slice(0, 4).map((s) => s.v);
            while (next.length < popN) {
                const a = scored[Math.floor(rng() * 8)]!.v;
                const b = scored[Math.floor(rng() * 12)]!.v;
                const child = a.map((x, i) => (rng() < 0.5 ? x : b[i]!));
                const mut = child.map((x, i) => {
                    if (rng() > 0.35) {
                        return x;
                    }
                    const hi = extend && i === 1 ? 16 : KIT_EMBEDDING_GENE_SPECS[i]!.hi;
                    const lo = KIT_EMBEDDING_GENE_SPECS[i]!.lo;
                    return x + (rng() * 2 - 1) * (hi - lo) * 0.25;
                });
                next.push(clamp(mut));
            }
            pop = next;
        }
        evals += cacheFit.size;
    }
    const g = genomeFrom(clampGene(bestV));
    if (extend) {
        g.rivalLambda = Math.min(16, Math.max(0, bestV[1]!));
    }
    note(
        `  ${label}  useC=${g.useCentroid} λ=${g.rivalLambda.toFixed(2)} τ=${g.rivalTau.toFixed(3)} k=${g.maxMedoids} sep=${g.minSeparation.toFixed(3)}  ${fmt(bestM)}  evals=${evals}`,
    );
    return { g, m: bestM };
};
runGa(foldsA, cachesA, rivJac, (m) => m.hard, "fit=hard");
runGa(foldsA, cachesA, rivJac, (m) => m.mix, "fit=50/50 mix");
runGa(
    foldsA,
    cachesA,
    rivJac,
    (m) => 0.7 * m.hard + 0.3 * m.easy,
    "fit=0.7hard+0.3easy",
);
runGa(
    foldsA,
    cachesA,
    rivJac,
    (m) => 0.7 * m.hard + 0.3 * m.hardTopK,
    "fit=0.7hard+0.3hardTopK",
);
runGa(
    foldsA,
    cachesA,
    rivJac,
    (m) => m.hard,
    "fit=hard λ≤16",
    { extendLambda: true, restarts: 2 },
);
if (savedFolds.length >= 6) {
    const savedIds = new Set(savedFolds.map((f) => f.kit.id));
    const savedCaches = new Map(
        [...cachesA.entries()].filter(([id]) => savedIds.has(id)),
    );
    const savedRiv = new Map(
        [...rivJac.entries()].filter(([id]) => savedIds.has(id)),
    );
    runGa(savedFolds, savedCaches, savedRiv, (m) => m.hard, "fit=hard saved-only");
}

note("\n=== 8. Per-kit GA vs grid vs λ=8 (train A, test B) ===");
const foldsB = makeFolds(kitsAll, 99);
const cachesB = new Map<string, Cache>();
for (const f of foldsB) {
    cachesB.set(f.kit.id, buildCache(f));
}
const rivB = rivalSets(foldsB, cachesB, "jaccard4");
note("  heatmap top-5 on fold B (confirm, not used for picking)");
for (const cell of heat.slice(0, 5)) {
    const m = evalFolds(foldsB, cachesB, rivB, (_f, c, r, id) =>
        compete(id, [c.centroid], r, cell.l, cell.t),
    );
    cell.b = m;
    note(`    A-best λ=${cell.l} τ=${cell.t}  A ${fmt(cell.a)}  B ${fmt(m)}`);
}
const g8b = evalFolds(foldsB, cachesB, rivB, (_f, c, r, id) =>
    compete(id, [c.centroid], r, 8, 0.06),
);
note(`    A-proposed λ=8 τ=0.06  B ${fmt(g8b)}`);

const grid: { l: number; t: number; c: number }[] = [];
for (const l of [0, 4, 6, 8, 10, 12, 16]) {
    for (const t of [0.04, 0.06, 0.12]) {
        grid.push({ l, t, c: 1 });
    }
}
grid.push({ l: 4, t: 0.12, c: 0 });
grid.push({ l: 8, t: 0.06, c: 0 });
const perKit: {
    id: string;
    def: number;
    grid: number;
    ga: number;
    mixGrid: number;
    gridPick: string;
}[] = [];
const t0 = Date.now();
const scoreAB = (
    fold: Fold,
    caches: Map<string, Cache>,
    riv: Map<string, number[][][]>,
    l: number,
    t: number,
    useC: number,
): Metrics => {
    const c = caches.get(fold.kit.id)!;
    const r = riv.get(fold.kit.id) ?? [];
    const sel = useC >= 0.5 ? [c.centroid] : c.medoids3;
    return metricsOf(fold, (id) => compete(id, sel, r, l, t));
};
for (const foldB of foldsB) {
    const foldA = foldsA.find((f) => f.kit.id === foldB.kit.id);
    if (!foldA) {
        continue;
    }
    let bestG = grid[0]!;
    let bestA = -1;
    let bestMix = grid[0]!;
    let bestMixA = -1;
    for (const g of grid) {
        const m = scoreAB(foldA, cachesA, rivJac, g.l, g.t, g.c);
        if (m.hard > bestA) {
            bestA = m.hard;
            bestG = g;
        }
        if (m.mix > bestMixA) {
            bestMixA = m.mix;
            bestMix = g;
        }
    }
    const rng = mulberry32(foldA.kit.id.length * 17 + 3);
    let gaBest = { l: 8, t: 0.06, c: 1, f: -1 };
    let vecs: GVec[] = [
        clampGene([0.06, 8, 3, 0.08, 1]),
        clampGene([0.12, 4, 3, 0.08, 1]),
        clampGene([0.12, 4, 3, 0.08, 0]),
        clampGeneExt([0.06, 12, 3, 0.08, 1]),
    ];
    while (vecs.length < 16) {
        vecs.push(
            clampGeneExt(
                KIT_EMBEDDING_GENE_SPECS.map((s, i) =>
                    i === 1 ? rng() * 16 : s.lo + rng() * (s.hi - s.lo),
                ),
            ),
        );
    }
    for (let gen = 0; gen < 18; gen++) {
        const scored = vecs.map((v) => {
            const g = genomeFrom(clampGene(v));
            g.rivalLambda = Math.min(16, Math.max(0, v[1]!));
            return {
                v,
                f: scoreAB(
                    foldA,
                    cachesA,
                    rivJac,
                    g.rivalLambda,
                    g.rivalTau,
                    g.useCentroid,
                ).hard,
                g,
            };
        });
        scored.sort((a, b) => b.f - a.f);
        if (scored[0]!.f > gaBest.f) {
            gaBest = {
                l: scored[0]!.g.rivalLambda,
                t: scored[0]!.g.rivalTau,
                c: scored[0]!.g.useCentroid,
                f: scored[0]!.f,
            };
        }
        const next = scored.slice(0, 3).map((s) => s.v);
        while (next.length < 16) {
            const a = scored[Math.floor(rng() * 6)]!.v;
            const b = scored[Math.floor(rng() * 10)]!.v;
            next.push(
                clampGeneExt(
                    a.map((x, i) => {
                        const y = rng() < 0.5 ? x : b[i]!;
                        if (rng() < 0.4) {
                            const hi =
                                i === 1 ? 16 : KIT_EMBEDDING_GENE_SPECS[i]!.hi;
                            const lo = KIT_EMBEDDING_GENE_SPECS[i]!.lo;
                            return y + (rng() * 2 - 1) * (hi - lo) * 0.2;
                        }
                        return y;
                    }),
                ),
            );
        }
        vecs = next;
    }
    const def = scoreAB(foldB, cachesB, rivB, 8, 0.06, 1).hard;
    const gridH = scoreAB(foldB, cachesB, rivB, bestG.l, bestG.t, bestG.c).hard;
    const mixH = scoreAB(foldB, cachesB, rivB, bestMix.l, bestMix.t, bestMix.c)
        .hard;
    const gaH = scoreAB(foldB, cachesB, rivB, gaBest.l, gaBest.t, gaBest.c).hard;
    perKit.push({
        id: foldB.kit.id,
        def,
        grid: gridH,
        ga: gaH,
        mixGrid: mixH,
        gridPick: `c${bestG.c} λ=${bestG.l} τ=${bestG.t}`,
    });
}
note(`  kits=${perKit.length} ${Date.now() - t0}ms`);
note(
    `  vs λ=8 default on B: dense-grid Δ=${(mean(perKit.map((p) => p.grid - p.def)) * 100).toFixed(2)}pp  mix-picked Δ=${(mean(perKit.map((p) => p.mixGrid - p.def)) * 100).toFixed(2)}pp  GA Δ=${(mean(perKit.map((p) => p.ga - p.def)) * 100).toFixed(2)}pp`,
);
note(
    `  grid≥2pp ${perKit.filter((p) => p.grid - p.def >= 0.02).length}  mix≥2pp ${perKit.filter((p) => p.mixGrid - p.def >= 0.02).length}  GA≥2pp ${perKit.filter((p) => p.ga - p.def >= 0.02).length}  grid hurt ${perKit.filter((p) => p.grid - p.def <= -0.02).length}  mix hurt ${perKit.filter((p) => p.mixGrid - p.def <= -0.02).length}  GA hurt ${perKit.filter((p) => p.ga - p.def <= -0.02).length}`,
);
note(
    `  mean hard B  def8=${(mean(perKit.map((p) => p.def)) * 100).toFixed(1)} grid=${(mean(perKit.map((p) => p.grid)) * 100).toFixed(1)} mixPick=${(mean(perKit.map((p) => p.mixGrid)) * 100).toFixed(1)} ga=${(mean(perKit.map((p) => p.ga)) * 100).toFixed(1)}`,
);
const pickCounts = new Map<string, number>();
for (const p of perKit) {
    pickCounts.set(p.gridPick, (pickCounts.get(p.gridPick) ?? 0) + 1);
}
note(
    `  A-picks: ${[...pickCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}×${v}`)
        .join("  ")}`,
);

note("\n=== 9. Two-stage (centroid shortlist, then λ=8) ===");
const fullL8 = evalFolds(foldsA, cachesA, rivJac, (_f, c, r, id) =>
    compete(id, [c.centroid], r, 8, 0.06),
);
for (const k of [20, 40, 80, 160]) {
    const twoStage = meanMetrics(
        foldsA.map((fold) => {
            const c = cachesA.get(fold.kit.id)!;
            const r = rivJac.get(fold.kit.id) ?? [];
            const cands = [...fold.holdoutIds, ...fold.easyNeg, ...fold.hardNeg];
            const cen = cands
                .map((id) => ({
                    id,
                    s: embeddings.get(id) ?
                        dot(embeddings.get(id)!, c.centroid)
                    :   -999,
                }))
                .sort((a, b) => b.s - a.s);
            const top = new Set(cen.slice(0, k).map((x) => x.id));
            return metricsOf(fold, (id) => {
                if (!top.has(id)) {
                    return compete(id, [c.centroid], [], 0, 0.12);
                }
                return compete(id, [c.centroid], r, 8, 0.06);
            });
        }),
    );
    note(`  k=${String(k).padEnd(4)} ${fmt(twoStage)}`);
}
note(`  full λ=8     ${fmt(fullL8)}`);

note("\n=== 10. Arity split (cen λ=8 vs prod, fold A) ===");
for (const arity of [1, 2, 3]) {
    const subset = foldsA.filter((f) => f.kit.tags.length === arity);
    if (!subset.length) {
        continue;
    }
    const prod = meanMetrics(
        subset.map((fold) => {
            const c = cachesA.get(fold.kit.id)!;
            const r = rivJac.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => compete(id, c.medoids3, r, 4, 0.12));
        }),
    );
    const neu = meanMetrics(
        subset.map((fold) => {
            const c = cachesA.get(fold.kit.id)!;
            const r = rivJac.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) =>
                compete(id, [c.centroid], r, 8, 0.06),
            );
        }),
    );
    note(
        `  arity=${arity} n=${subset.length}  prod ${fmt(prod)}  cen8 ${fmt(neu)}`,
    );
}

const stripFrom = (text: string, heading: string): string => {
    const i = text.indexOf(heading);
    return i >= 0 ? text.slice(0, i).trimEnd() : text.trimEnd();
};
let notes = readFileSync(NOTES_PATH, "utf8");
notes = stripFrom(notes, "## Pass 3 plan");
notes = stripFrom(notes, "## Pass 3 results");
notes = notes.replace(
    /- \\[ \\] Pass 3:.*/,
    "- [x] Pass 3: stability, rivals, GA, mixes, LOO, saved-only, λ cap, two-stage",
);
const gridDelta = mean(perKit.map((p) => p.grid - p.def));
const gaDelta = mean(perKit.map((p) => p.ga - p.def));
const mixDelta = mean(perKit.map((p) => p.mixGrid - p.def));
const pass3 = `
## Pass 3 results (${new Date().toISOString().slice(0, 10)})

Script: \`kit-nearness-s2-pass3.ts\`. Same AND kits / hard-neg protocol. Production rival path is **all other saved kits** (\`savedAll\`); Jaccard-4 is the research proxy used in earlier passes.

Unbiased tuner vs new default on fold B: dense-grid Δ=${(gridDelta * 100).toFixed(2)}pp · mix-picked Δ=${(mixDelta * 100).toFixed(2)}pp · GA Δ=${(gaDelta * 100).toFixed(2)}pp. Heatmap A-best λ=${heat[0]!.l} τ=${heat[0]!.t} hard=${(heat[0]!.a.hard * 100).toFixed(1)}%${heat[0]!.b ? ` (B ${(heat[0]!.b.hard * 100).toFixed(1)}%)` : ""}. LOO picks: ${[...loloPick.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}.

\`\`\`
${logLines.join("\n")}
\`\`\`

### Reading (write this in English after staring at the log)

- **Rival policy:** production uses every other saved kit, not a Jaccard-4 shortlist. If \`savedAll\` ≈ Jaccard-4 on hard AUC, the proxy was fair. If CLIP-NN or tag-subset wins, that is what the app should pick.
- **λ>8:** raise the gene cap only if 10/12 beat 8 on *stability min* and on saved-kit / fold B, not just fold A.
- **Mahalanobis+λ:** ship only if it beats plain centroid λ=8 on saved kits by a clear margin. +0.7pp fingerprint without exclusivity was not enough.
- **Global GA:** if it lands on centroid + high λ + low τ, the grid was sufficient and the long in-app GA is waste.
- **Per-kit tuner vs λ=8 default:** mean Δ near 0 plus hurts → drop the deep GA. Keep a tiny holdout grid only if ≥2pp wins outnumber hurts.
- **LOO:** a single genome winning most held-out kits is the automatic default.
- **Two-stage:** if k=20/40 loses hard AUC vs full λ=8, apply the rival penalty to the whole ranking (as production already does).
- **Easy vs hard mix:** if mix-fitness picks a softer λ that loses hard exclusivity, do not use mix as the tuner objective — hard siblings are the job.
`;
writeFileSync(NOTES_PATH, `${notes}\n${pass3}`, "utf8");
console.log(`\nwrote ${NOTES_PATH}`);
