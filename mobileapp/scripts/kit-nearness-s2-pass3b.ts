/**
 * Pass 3b: retune λ/τ on the production rival set (all other saved kits).
 * Jaccard-4 understated exclusivity; do not pick a default from that proxy.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass3b.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    buildKitEmbeddingCentroid,
    kitEmbeddingDistanceCompetitive,
} from "../src/lib/kit-nearness-sort";
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
const l2 = (v: number[]): number[] => {
    let n = 0;
    for (const x of v) {
        n += x * x;
    }
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
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
type Metrics = { easy: number; hard: number; mix: number; hardTopK: number };

const raw = JSON.parse(
    readFileSync(CORPUS_PATH, "utf8"),
) as AnonymisedKitNearnessCorpus;
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
        folds.push({
            kit,
            seedIds,
            holdoutIds: hold,
            easyNeg: easy,
            hardNeg: hard,
        });
    }
    return folds;
};

const metricsOf = (fold: Fold, score: (id: number) => number): Metrics => {
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
const fmt = (m: Metrics): string =>
    `easy=${(m.easy * 100).toFixed(1)} hard=${(m.hard * 100).toFixed(1)} mix=${(m.mix * 100).toFixed(1)} hardTopK=${(m.hardTopK * 100).toFixed(1)}`;

const centroids = (folds: Fold[]): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    for (const fold of folds) {
        out.set(
            fold.kit.id,
            buildKitEmbeddingCentroid(fold.seedIds, numberEmb, SEED_CAP) ??
                new Array(DIM).fill(0),
        );
    }
    return out;
};
const savedRivalMap = (
    folds: Fold[],
    cents: Map<string, number[]>,
): Map<string, number[][][]> => {
    const savedIds = new Set(
        folds.filter((f) => f.kit.source === "saved").map((f) => f.kit.id),
    );
    const out = new Map<string, number[][][]>();
    for (const fold of folds) {
        const rivals: number[][][] = [];
        for (const other of folds) {
            if (other.kit.id === fold.kit.id || !savedIds.has(other.kit.id)) {
                continue;
            }
            const proto = cents.get(other.kit.id);
            if (proto) {
                rivals.push([proto]);
            }
        }
        out.set(fold.kit.id, rivals);
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
const evalGroup = (
    folds: Fold[],
    cents: Map<string, number[]>,
    riv: Map<string, number[][][]>,
    lambda: number,
    tau: number,
): Metrics =>
    meanMetrics(
        folds.map((fold) => {
            const c = cents.get(fold.kit.id)!;
            const r = riv.get(fold.kit.id) ?? [];
            return metricsOf(fold, (id) => compete(id, [c], r, lambda, tau));
        }),
    );

const logLines: string[] = [];
const note = (s: string) => {
    console.log(s);
    logLines.push(s);
};

const foldsA = makeFolds(allKits, 42);
const centsA = centroids(foldsA);
const rivA = savedRivalMap(foldsA, centsA);
const savedA = foldsA.filter((f) => f.kit.source === "saved");
note(
    `pass3b folds=${foldsA.length} saved=${savedA.length} meanRivals=${mean([...rivA.values()].map((r) => r.length)).toFixed(1)}`,
);

const lambdas = [0, 4, 8, 12, 16, 20, 24];
const taus = [0.02, 0.04, 0.06, 0.12, 0.2];
type Cell = { l: number; t: number; all: Metrics; saved: Metrics };
const heat: Cell[] = [];
note("\n=== savedAll heatmap hard (all eval kits) ===");
note(`  ${"".padEnd(8)}${taus.map((t) => `τ${t}`.padStart(7)).join("")}`);
for (const l of lambdas) {
    const row: string[] = [`  λ=${String(l).padEnd(3)}`];
    for (const t of taus) {
        const all = evalGroup(foldsA, centsA, rivA, l, t);
        const saved = evalGroup(savedA, centsA, rivA, l, t);
        heat.push({ l, t, all, saved });
        row.push((all.hard * 100).toFixed(1));
    }
    note(row.map((x, i) => (i === 0 ? x : x.padStart(7))).join(""));
}
note("\n=== savedAll heatmap hard (saved presets only) ===");
note(`  ${"".padEnd(8)}${taus.map((t) => `τ${t}`.padStart(7)).join("")}`);
for (const l of lambdas) {
    const row: string[] = [`  λ=${String(l).padEnd(3)}`];
    for (const t of taus) {
        const cell = heat.find((c) => c.l === l && c.t === t)!;
        row.push((cell.saved.hard * 100).toFixed(1));
    }
    note(row.map((x, i) => (i === 0 ? x : x.padStart(7))).join(""));
}
note("\n=== savedAll heatmap easy (all kits) — watch for collapse ===");
note(`  ${"".padEnd(8)}${taus.map((t) => `τ${t}`.padStart(7)).join("")}`);
for (const l of lambdas) {
    const row: string[] = [`  λ=${String(l).padEnd(3)}`];
    for (const t of taus) {
        const cell = heat.find((c) => c.l === l && c.t === t)!;
        row.push((cell.all.easy * 100).toFixed(1));
    }
    note(row.map((x, i) => (i === 0 ? x : x.padStart(7))).join(""));
}
const byHard = [...heat].sort((a, b) => b.all.hard - a.all.hard);
const bySaved = [...heat].sort((a, b) => b.saved.hard - a.saved.hard);
const byMix = [...heat].sort((a, b) => b.all.mix - a.all.mix);
note(
    `  best-all-hard  λ=${byHard[0]!.l} τ=${byHard[0]!.t} ${fmt(byHard[0]!.all)}`,
);
note(
    `  best-saved-hard λ=${bySaved[0]!.l} τ=${bySaved[0]!.t} ${fmt(bySaved[0]!.saved)}`,
);
note(
    `  best-all-mix   λ=${byMix[0]!.l} τ=${byMix[0]!.t} ${fmt(byMix[0]!.all)}`,
);

const foldsB = makeFolds(allKits, 99);
const centsB = centroids(foldsB);
const rivB = savedRivalMap(foldsB, centsB);
const savedB = foldsB.filter((f) => f.kit.source === "saved");
note("\n=== confirm top cells + proposed on fold B ===");
const confirm = [
    { l: 8, t: 0.06 },
    { l: 8, t: 0.02 },
    { l: 12, t: 0.06 },
    { l: 16, t: 0.06 },
    { l: 16, t: 0.02 },
    { l: 24, t: 0.02 },
    { l: byHard[0]!.l, t: byHard[0]!.t },
    { l: bySaved[0]!.l, t: bySaved[0]!.t },
    { l: byMix[0]!.l, t: byMix[0]!.t },
];
const seen = new Set<string>();
for (const g of confirm) {
    const key = `${g.l}/${g.t}`;
    if (seen.has(key)) {
        continue;
    }
    seen.add(key);
    const a = evalGroup(foldsA, centsA, rivA, g.l, g.t);
    const b = evalGroup(foldsB, centsB, rivB, g.l, g.t);
    const sb = evalGroup(savedB, centsB, rivB, g.l, g.t);
    note(
        `  λ=${g.l} τ=${g.t}  A ${fmt(a)}  B ${fmt(b)}  B-saved ${fmt(sb)}`,
    );
}

note("\n=== stability (savedAll, hard AUC, all kits) ===");
const stab = [
    { n: "λ0", l: 0, t: 0.12 },
    { n: "8/0.06", l: 8, t: 0.06 },
    { n: "8/0.02", l: 8, t: 0.02 },
    { n: "12/0.06", l: 12, t: 0.06 },
    { n: "16/0.06", l: 16, t: 0.06 },
    { n: "16/0.02", l: 16, t: 0.02 },
    { n: "24/0.02", l: 24, t: 0.02 },
];
note(`  ${"seed".padEnd(8)}${stab.map((g) => g.n.padStart(10)).join("")}`);
const stabH = stab.map(() => [] as number[]);
const stabE = stab.map(() => [] as number[]);
for (const seed of [7, 42, 99, 123, 2024]) {
    const folds = makeFolds(allKits, seed);
    const cents = centroids(folds);
    const riv = savedRivalMap(folds, cents);
    const cells: string[] = [];
    stab.forEach((g, i) => {
        const m = evalGroup(folds, cents, riv, g.l, g.t);
        stabH[i]!.push(m.hard);
        stabE[i]!.push(m.easy);
        cells.push((m.hard * 100).toFixed(1).padStart(10));
    });
    note(`  ${String(seed).padEnd(8)}${cells.join("")}`);
}
note(
    `  ${"meanH".padEnd(8)}${stabH.map((xs) => (mean(xs) * 100).toFixed(1).padStart(10)).join("")}`,
);
note(
    `  ${"minH".padEnd(8)}${stabH.map((xs) => (Math.min(...xs) * 100).toFixed(1).padStart(10)).join("")}`,
);
note(
    `  ${"meanE".padEnd(8)}${stabE.map((xs) => (mean(xs) * 100).toFixed(1).padStart(10)).join("")}`,
);

note("\n=== per-kit tuner vs production-like defaults (train A / test B, savedAll) ===");
const grid: { l: number; t: number }[] = [];
for (const l of [0, 8, 12, 16, 24]) {
    for (const t of [0.02, 0.06, 0.12]) {
        grid.push({ l, t });
    }
}
const defaults = [
    { n: "λ8/0.06", l: 8, t: 0.06 },
    { n: "λ16/0.06", l: 16, t: 0.06 },
    { n: "λ16/0.02", l: 16, t: 0.02 },
];
const scoreFold = (
    fold: Fold,
    cents: Map<string, number[]>,
    riv: Map<string, number[][][]>,
    l: number,
    t: number,
): Metrics => {
    const c = cents.get(fold.kit.id)!;
    const r = riv.get(fold.kit.id) ?? [];
    return metricsOf(fold, (id) => compete(id, [c], r, l, t));
};
for (const def of defaults) {
    const rows: { d: number; g: number; mix: number }[] = [];
    const picks = new Map<string, number>();
    for (const foldB of foldsB) {
        const foldA = foldsA.find((f) => f.kit.id === foldB.kit.id);
        if (!foldA) {
            continue;
        }
        let best = grid[0]!;
        let bestH = -1;
        let bestMixG = grid[0]!;
        let bestMix = -1;
        for (const g of grid) {
            const m = scoreFold(foldA, centsA, rivA, g.l, g.t);
            if (m.hard > bestH) {
                bestH = m.hard;
                best = g;
            }
            if (m.mix > bestMix) {
                bestMix = m.mix;
                bestMixG = g;
            }
        }
        const key = `λ${best.l}/τ${best.t}`;
        picks.set(key, (picks.get(key) ?? 0) + 1);
        rows.push({
            d: scoreFold(foldB, centsB, rivB, def.l, def.t).hard,
            g: scoreFold(foldB, centsB, rivB, best.l, best.t).hard,
            mix: scoreFold(foldB, centsB, rivB, bestMixG.l, bestMixG.t).hard,
        });
    }
    note(
        `  default ${def.n}: meanB=${(mean(rows.map((r) => r.d)) * 100).toFixed(1)}  hard-grid Δ=${(mean(rows.map((r) => r.g - r.d)) * 100).toFixed(2)}pp  mix-grid Δ=${(mean(rows.map((r) => r.mix - r.d)) * 100).toFixed(2)}pp  ≥2pp ${rows.filter((r) => r.g - r.d >= 0.02).length}  hurt ${rows.filter((r) => r.g - r.d <= -0.02).length}`,
    );
    note(
        `    A-picks: ${[...picks.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}×${v}`)
            .join("  ")}`,
    );
}

const notes = readFileSync(NOTES_PATH, "utf8");
const cut = notes.indexOf("## Pass 3b");
const base = (cut >= 0 ? notes.slice(0, cut) : notes).trimEnd();
const body = `
## Pass 3b — production rivals (\`savedAll\`) (${new Date().toISOString().slice(0, 10)})

Jaccard-4 was the wrong proxy. The app already uses **every other saved kit** as a rival. This retune is the one that matters for the default genome.

\`\`\`
${logLines.join("\n")}
\`\`\`
`;
writeFileSync(NOTES_PATH, `${base}\n${body}`, "utf8");
console.log(`\nwrote ${NOTES_PATH}`);
