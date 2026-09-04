/**
 * Curated ranking harness for kit nearness (large pool + FP stress).
 *
 * Builds a Picsum library + near-duplicate transforms. Positives = transforms of
 * kit seeds. Hard negatives include other families' originals *and* their mild
 * transforms (palette/structure distractors). Also runs contaminated-kit cases.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-validate.ts
 */
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhashEntry } from "../src/lib/crop-match";
import { colorHashFromImageData } from "../src/lib/crop-match";
import {
    KIT_COLOR_BONUS,
    KIT_COLOR_RADIUS,
    KIT_COLOR_STRUCTURE_GATE,
    KIT_RIVAL_LAMBDA,
    KIT_RIVAL_TAU,
    kitDistance,
    kitNearnessDistance,
    kitNearnessDistanceCompetitive,
    pickKitMedoids,
    sortFilesByKitNearness,
    sortFilesByKitNearnessCompetitive,
    type KitMedoid,
} from "../src/lib/kit-nearness-sort";
import { computeDHashFromImageData } from "../src/lib/phash";
import type { EnteFile } from "ente-media/file";

const outDir = join(process.cwd(), ".spike-out");
mkdirSync(outDir, { recursive: true });

/** Expanded Picsum pool for ranking + FP stress. */
const PICSUM_SEEDS = [
    237, 1084, 1025, 429, 522, 765, 903, 1134, 48, 201, 338, 433, 548, 1100,
    823, 996, 15, 29, 55, 76, 89, 111, 145, 167, 188, 212, 249, 274, 301, 325,
    360, 392, 12, 21, 33, 41, 64, 70, 83, 97, 106, 119, 133, 152, 160, 175,
    193, 204, 219, 231, 255, 268, 283, 297, 310, 333, 347, 355, 371, 385,
    401, 417, 441, 456, 470, 489, 505, 519, 534, 551, 569, 580, 595, 610,
];

/** Mild transforms of other families used as hard distractors. */
const DISTRACTOR_LABELS = new Set([
    "center-60",
    "bright",
    "dark",
    "wide-70",
]);

type IndexedPhoto = {
    id: number;
    label: string;
    family: number;
    role: "original" | "positive";
    entry: PhashEntry;
};

const downloadPhoto = (seed: number): Buffer => {
    const tmp = join(outDir, `_kit-dl-${seed}.jpg`);
    if (!existsSync(tmp)) {
        execFileSync(
            "curl",
            [
                "-sS",
                "-L",
                "-o",
                tmp,
                `https://picsum.photos/seed/${seed}/640/480.jpg`,
            ],
            { stdio: "pipe" },
        );
    }
    return readFileSync(tmp);
};

const hashVariantFromImage = (
    img: Image,
    width: number,
    height: number,
    rotationDegrees: number,
    mirror: boolean,
): string => {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.translate(width / 2, height / 2);
    ctx.rotate((rotationDegrees * Math.PI) / 180);
    if (mirror) {
        ctx.scale(-1, 1);
    }
    ctx.drawImage(img, -width / 2, -height / 2);
    const imageData = ctx.getImageData(0, 0, width, height);
    return computeDHashFromImageData(imageData.data, width, height);
};

const phashFromDrawable = async (
    source: Buffer | Image,
    draw: (
        img: Image,
        ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
        w: number,
        h: number,
    ) => void,
    width: number,
    height: number,
): Promise<PhashEntry> => {
    const img = Buffer.isBuffer(source) ? await loadImage(source) : source;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    draw(img, ctx, width, height);
    const upright = ctx.getImageData(0, 0, width, height);
    const color = colorHashFromImageData(upright.data, width, height);
    const hashes: string[] = [];
    const variantSource = await loadImage(canvas.toBuffer("image/jpeg"));
    for (const rotation of [0, 90, 180, 270]) {
        for (const mirror of [false, true]) {
            hashes.push(
                hashVariantFromImage(
                    variantSource,
                    width,
                    height,
                    rotation,
                    mirror,
                ),
            );
        }
    }
    return { hashes, color };
};

const fullFrame = async (bytes: Buffer): Promise<PhashEntry> => {
    const img = await loadImage(bytes);
    return phashFromDrawable(
        img,
        (src, ctx, width, height) => {
            ctx.drawImage(src, 0, 0, width, height);
        },
        320,
        240,
    );
};

const cropFrame = async (
    bytes: Buffer,
    fx: number,
    fy: number,
    fw: number,
    fh: number,
): Promise<PhashEntry> => {
    const img = await loadImage(bytes);
    const sw = img.width;
    const sh = img.height;
    return phashFromDrawable(
        img,
        (src, ctx, width, height) => {
            ctx.drawImage(
                src,
                Math.floor(sw * fx),
                Math.floor(sh * fy),
                Math.floor(sw * fw),
                Math.floor(sh * fh),
                0,
                0,
                width,
                height,
            );
        },
        320,
        240,
    );
};

const shadeFrame = async (
    bytes: Buffer,
    gain: number,
    bias: number,
): Promise<PhashEntry> => {
    const img = await loadImage(bytes);
    const w = 320;
    const h = 240;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.max(0, Math.min(255, data[i]! * gain + bias));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! * gain + bias));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! * gain + bias));
    }
    ctx.putImageData(imageData, 0, 0);
    return fullFrame(canvas.toBuffer("image/jpeg"));
};

const asFile = (id: number): EnteFile => ({ id } as EnteFile);

type RankCase = {
    name: string;
    seedIds: number[];
    positiveIds: number[];
    negativeIds: number[];
};

type CaseMetrics = {
    name: string;
    auc: number;
    precisionAt10: number;
    precisionAt25: number;
    /** Fraction of top-10 non-seed slots that are negatives (FP pressure). */
    fpAt10: number;
    meanPositiveRank: number;
    meanPositiveDist: number;
    meanNegativeDist: number;
    medoidCount: number;
};

const aucFromScores = (
    positiveScores: number[],
    negativeScores: number[],
): number => {
    if (!positiveScores.length || !negativeScores.length) {
        return 0;
    }
    let wins = 0;
    for (const p of positiveScores) {
        for (const n of negativeScores) {
            if (p < n) {
                wins += 1;
            } else if (p === n) {
                wins += 0.5;
            }
        }
    }
    return wins / (positiveScores.length * negativeScores.length);
};

type ScoreParams = {
    bonus: number;
    radius: number;
    gate: number;
};

const evaluateCase = (
    testCase: RankCase,
    entries: Map<number, PhashEntry>,
    params: ScoreParams,
): CaseMetrics => {
    const refs = pickKitMedoids(testCase.seedIds, entries);
    const candidateIds = [
        ...new Set([
            ...testCase.seedIds,
            ...testCase.positiveIds,
            ...testCase.negativeIds,
        ]),
    ];
    const files = candidateIds.map(asFile);
    const ordered = sortFilesByKitNearness(
        files,
        refs,
        entries,
        params.bonus,
        params.radius,
        params.gate,
    );
    const rankById = new Map<number, number>();
    ordered.forEach((file, index) => rankById.set(file.id, index));

    const positiveSet = new Set(testCase.positiveIds);
    const negativeSet = new Set(testCase.negativeIds);

    const posScores = testCase.positiveIds.map((id) =>
        kitNearnessDistance(
            id,
            refs,
            entries,
            params.bonus,
            params.radius,
            params.gate,
        ),
    );
    const negScores = testCase.negativeIds.map((id) =>
        kitNearnessDistance(
            id,
            refs,
            entries,
            params.bonus,
            params.radius,
            params.gate,
        ),
    );

    const nonSeedOrdered = ordered.filter(
        (f) => !testCase.seedIds.includes(f.id),
    );
    const top10 = nonSeedOrdered.slice(0, 10);
    const p10denom = Math.min(10, nonSeedOrdered.length);
    const p25denom = Math.min(25, nonSeedOrdered.length);
    const p10hits = top10.filter((f) => positiveSet.has(f.id)).length;
    const p25hits = nonSeedOrdered
        .slice(0, 25)
        .filter((f) => positiveSet.has(f.id)).length;
    const fp10 = top10.filter((f) => negativeSet.has(f.id)).length;

    const mean = (xs: number[]): number =>
        xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

    const posRanks = testCase.positiveIds.map(
        (id) => rankById.get(id) ?? Number.POSITIVE_INFINITY,
    );

    return {
        name: testCase.name,
        auc: aucFromScores(posScores, negScores),
        precisionAt10: p10denom ? p10hits / p10denom : 0,
        precisionAt25: p25denom ? p25hits / p25denom : 0,
        fpAt10: p10denom ? fp10 / p10denom : 0,
        meanPositiveRank: mean(posRanks),
        meanPositiveDist: mean(posScores),
        meanNegativeDist: mean(negScores),
        medoidCount: refs.length,
    };
};

const meanMetric = (rows: CaseMetrics[], key: keyof CaseMetrics): number => {
    const values = rows.map((row) => Number(row[key]));
    return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
};

const main = async (): Promise<void> => {
    console.log(`Downloading / hashing ${PICSUM_SEEDS.length} Picsum photos…`);
    const photos: IndexedPhoto[] = [];
    let nextId = 1;
    const originals: IndexedPhoto[] = [];

    for (const seed of PICSUM_SEEDS) {
        const bytes = downloadPhoto(seed);
        const entry = await fullFrame(bytes);
        const photo: IndexedPhoto = {
            id: nextId++,
            label: `orig-${seed}`,
            family: seed,
            role: "original",
            entry,
        };
        originals.push(photo);
        photos.push(photo);

        const transforms: Array<[string, () => Promise<PhashEntry>]> = [
            [
                "rot90",
                async () => {
                    const img = await loadImage(bytes);
                    const w = 320;
                    const h = 240;
                    const canvas = createCanvas(w, h);
                    const ctx = canvas.getContext("2d");
                    ctx.translate(w / 2, h / 2);
                    ctx.rotate(Math.PI / 2);
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    return fullFrame(canvas.toBuffer("image/jpeg"));
                },
            ],
            [
                "mirror",
                async () => {
                    const img = await loadImage(bytes);
                    const w = 320;
                    const h = 240;
                    const canvas = createCanvas(w, h);
                    const ctx = canvas.getContext("2d");
                    ctx.translate(w, 0);
                    ctx.scale(-1, 1);
                    ctx.drawImage(img, 0, 0, w, h);
                    return fullFrame(canvas.toBuffer("image/jpeg"));
                },
            ],
            ["center-60", () => cropFrame(bytes, 0.2, 0.2, 0.6, 0.6)],
            ["tl-50", () => cropFrame(bytes, 0.05, 0.05, 0.5, 0.5)],
            ["br-50", () => cropFrame(bytes, 0.45, 0.45, 0.5, 0.5)],
            ["wide-70", () => cropFrame(bytes, 0.1, 0.2, 0.8, 0.55)],
            ["bright", () => shadeFrame(bytes, 1.25, 20)],
            ["dark", () => shadeFrame(bytes, 0.7, -15)],
            ["contrast", () => shadeFrame(bytes, 1.4, -25)],
            [
                "bright-crop",
                async () => {
                    const img = await loadImage(bytes);
                    const sw = img.width;
                    const sh = img.height;
                    const w = 320;
                    const h = 240;
                    const canvas = createCanvas(w, h);
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(
                        img,
                        Math.floor(sw * 0.2),
                        Math.floor(sh * 0.2),
                        Math.floor(sw * 0.6),
                        Math.floor(sh * 0.6),
                        0,
                        0,
                        w,
                        h,
                    );
                    const imageData = ctx.getImageData(0, 0, w, h);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        data[i] = Math.max(
                            0,
                            Math.min(255, data[i]! * 1.15 + 18),
                        );
                        data[i + 1] = Math.max(
                            0,
                            Math.min(255, data[i + 1]! * 1.15 + 18),
                        );
                        data[i + 2] = Math.max(
                            0,
                            Math.min(255, data[i + 2]! * 1.15 + 18),
                        );
                    }
                    ctx.putImageData(imageData, 0, 0);
                    return fullFrame(canvas.toBuffer("image/jpeg"));
                },
            ],
        ];

        for (const [label, build] of transforms) {
            photos.push({
                id: nextId++,
                label: `${seed}-${label}`,
                family: seed,
                role: "positive",
                entry: await build(),
            });
        }
    }

    const entries = new Map<number, PhashEntry>();
    for (const photo of photos) {
        entries.set(photo.id, photo.entry);
    }

    const byFamily = new Map<number, IndexedPhoto[]>();
    for (const photo of photos) {
        const list = byFamily.get(photo.family) ?? [];
        list.push(photo);
        byFamily.set(photo.family, list);
    }

    const hardNegativesFor = (seedFamilies: Set<number>): number[] => {
        const ids: number[] = [];
        for (const photo of photos) {
            if (seedFamilies.has(photo.family)) {
                continue;
            }
            if (photo.role === "original") {
                ids.push(photo.id);
                continue;
            }
            for (const transform of DISTRACTOR_LABELS) {
                if (photo.label.endsWith(`-${transform}`)) {
                    ids.push(photo.id);
                    break;
                }
            }
        }
        return ids;
    };

    const cases: RankCase[] = [];

    // A) Single-seed with hard FP pool (other originals + mild transforms).
    for (const original of originals) {
        const family = byFamily.get(original.family) ?? [];
        const positives = family
            .filter((p) => p.role === "positive")
            .map((p) => p.id);
        cases.push({
            name: `single-${original.family}`,
            seedIds: [original.id],
            positiveIds: positives,
            negativeIds: hardNegativesFor(new Set([original.family])),
        });
    }

    // B) Bimodal kits.
    for (let i = 0; i < originals.length - 1; i += 2) {
        const a = originals[i]!;
        const b = originals[i + 1]!;
        const positives = [
            ...(byFamily.get(a.family) ?? []).filter((p) => p.role === "positive"),
            ...(byFamily.get(b.family) ?? []).filter((p) => p.role === "positive"),
        ].map((p) => p.id);
        cases.push({
            name: `bimodal-${a.family}+${b.family}`,
            seedIds: [a.id, b.id],
            positiveIds: positives,
            negativeIds: hardNegativesFor(new Set([a.family, b.family])),
        });
    }

    // C) Crowded 4-seed kits.
    for (let i = 0; i + 3 < originals.length; i += 4) {
        const seeds = originals.slice(i, i + 4);
        const seedFamilies = new Set(seeds.map((s) => s.family));
        const positives = photos
            .filter(
                (p) => p.role === "positive" && seedFamilies.has(p.family),
            )
            .map((p) => p.id);
        cases.push({
            name: `crowd-${seeds.map((s) => s.family).join("+")}`,
            seedIds: seeds.map((s) => s.id),
            positiveIds: positives,
            negativeIds: hardNegativesFor(seedFamilies),
        });
    }

    // D) Contaminated kit: 3 good seeds + 1 wrong original as seed.
    // Positives = transforms of the 3 good families only; the contaminant
    // should not pull its own family into the top ranks as "positives".
    for (let i = 0; i + 3 < originals.length; i += 5) {
        const good = originals.slice(i, i + 3);
        const bad = originals[i + 3]!;
        const goodFamilies = new Set(good.map((s) => s.family));
        const positives = photos
            .filter((p) => p.role === "positive" && goodFamilies.has(p.family))
            .map((p) => p.id);
        // Negatives: everything else including the contaminant's family.
        const negatives = hardNegativesFor(goodFamilies).filter(
            (id) => id !== bad.id,
        );
        // Also treat contaminant's transforms as negatives (FP if they float up).
        for (const p of byFamily.get(bad.family) ?? []) {
            if (p.role === "positive") {
                negatives.push(p.id);
            }
        }
        cases.push({
            name: `contam-${good.map((s) => s.family).join("+")}+bad${bad.family}`,
            seedIds: [...good.map((s) => s.id), bad.id],
            positiveIds: positives,
            negativeIds: [...new Set(negatives)],
        });
    }

    console.log(
        `Library: ${photos.length} indexed (${originals.length} originals + transforms)`,
    );
    console.log(`Cases: ${cases.length}`);

    const defaultParams: ScoreParams = {
        bonus: KIT_COLOR_BONUS,
        radius: KIT_COLOR_RADIUS,
        gate: KIT_COLOR_STRUCTURE_GATE,
    };

    // Finer bonus×radius sweep at the stable gate.
    const gates = [20, 22];
    const bonuses = [0.5, 0.75, 1.0, 1.15, 1.35];
    const radii = [8, 10, 12];
    console.log("\n=== gate×bonus×radius sweep (ALL cases) ===");
    let best = { ...defaultParams, auc: -1, p10: -1, fp10: 1 };
    for (const gate of gates) {
        for (const radius of radii) {
            for (const bonus of bonuses) {
                const params = { bonus, radius, gate };
                const rows = cases.map((c) => evaluateCase(c, entries, params));
                const auc = meanMetric(rows, "auc");
                const p10 = meanMetric(rows, "precisionAt10");
                const fp10 = meanMetric(rows, "fpAt10");
                const marker =
                    bonus === KIT_COLOR_BONUS &&
                    radius === KIT_COLOR_RADIUS &&
                    gate === KIT_COLOR_STRUCTURE_GATE ?
                        " ← default" :
                        "";
                // Score: AUC primary, FP@10 heavily penalized, P@10 tiebreak.
                const composite = auc - 0.35 * fp10 + 0.1 * p10;
                const bestComposite =
                    best.auc - 0.35 * best.fp10 + 0.1 * best.p10;
                console.log(
                    `  g=${gate} b=${bonus.toFixed(2)} r=${String(radius).padStart(2)}  AUC=${auc.toFixed(3)}  P@10=${p10.toFixed(3)}  FP@10=${fp10.toFixed(3)}  score=${composite.toFixed(3)}${marker}`,
                );
                if (composite > bestComposite) {
                    best = { ...params, auc, p10, fp10 };
                }
            }
        }
    }
    console.log(
        `best: gate=${best.gate} bonus=${best.bonus} radius=${best.radius} (AUC=${best.auc.toFixed(3)} P@10=${best.p10.toFixed(3)} FP@10=${best.fp10.toFixed(3)})`,
    );

    const defaultRows = cases.map((c) =>
        evaluateCase(c, entries, defaultParams),
    );
    const defaultComposite =
        meanMetric(defaultRows, "auc") -
        0.35 * meanMetric(defaultRows, "fpAt10") +
        0.1 * meanMetric(defaultRows, "precisionAt10");
    const bestComposite = best.auc - 0.35 * best.fp10 + 0.1 * best.p10;
    const active: ScoreParams =
        bestComposite > defaultComposite + 0.005 ?
            { bonus: best.bonus, radius: best.radius, gate: best.gate } :
            defaultParams;
    console.log(
        `reporting with gate=${active.gate} bonus=${active.bonus} radius=${active.radius}`,
    );

    const results = cases.map((c) => evaluateCase(c, entries, active));
    const singles = results.filter((r) => r.name.startsWith("single-"));
    const bimodals = results.filter((r) => r.name.startsWith("bimodal-"));
    const crowds = results.filter((r) => r.name.startsWith("crowd-"));
    const contams = results.filter((r) => r.name.startsWith("contam-"));

    const report = (label: string, rows: CaseMetrics[]): void => {
        if (!rows.length) {
            return;
        }
        console.log(
            `\n=== ${label} @ g=${active.gate} b=${active.bonus} (n=${rows.length}) ===`,
        );
        console.log(
            `AUC=${meanMetric(rows, "auc").toFixed(3)}  P@10=${meanMetric(rows, "precisionAt10").toFixed(3)}  P@25=${meanMetric(rows, "precisionAt25").toFixed(3)}  FP@10=${meanMetric(rows, "fpAt10").toFixed(3)}`,
        );
        console.log(
            `meanPosRank=${meanMetric(rows, "meanPositiveRank").toFixed(1)}  posDist=${meanMetric(rows, "meanPositiveDist").toFixed(1)}  negDist=${meanMetric(rows, "meanNegativeDist").toFixed(1)}`,
        );
        const worst = [...rows].sort((a, b) => a.auc - b.auc).slice(0, 5);
        console.log("worst AUC:");
        for (const row of worst) {
            console.log(
                `  ${row.name}: AUC=${row.auc.toFixed(3)} P@10=${row.precisionAt10.toFixed(2)} FP@10=${row.fpAt10.toFixed(2)}`,
            );
        }
    };

    report("single-seed", singles);
    report("bimodal", bimodals);
    report("crowd-4", crowds);
    report("contaminated", contams);
    report("ALL", results);

    const transformLabels = [
        "rot90",
        "mirror",
        "center-60",
        "tl-50",
        "br-50",
        "wide-70",
        "bright",
        "dark",
        "contrast",
        "bright-crop",
    ];
    console.log(
        `\n=== per-transform mean distance (single-seed, g=${active.gate} b=${active.bonus}) ===`,
    );
    for (const label of transformLabels) {
        const dists: number[] = [];
        for (const original of originals) {
            const medoids: KitMedoid[] = pickKitMedoids([original.id], entries);
            const twin = photos.find(
                (p) => p.family === original.family && p.label.endsWith(label),
            );
            if (!twin) {
                continue;
            }
            dists.push(
                kitNearnessDistance(
                    twin.id,
                    medoids,
                    entries,
                    active.bonus,
                    active.radius,
                    active.gate,
                ),
            );
        }
        const avg =
            dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
        console.log(`  ${label.padEnd(12)} dist=${avg.toFixed(1)}`);
    }

    // Emit chosen knobs for the agent to bake in if different from defaults.
    console.log(
        `\nCHOSEN_KNOBS gate=${active.gate} bonus=${active.bonus} radius=${active.radius}`,
    );

    // --- Competitive exclusive-affinity section ---
    type CompCase = {
        name: string;
        selectedSeeds: number[];
        rivalSeedGroups: number[][];
        positiveIds: number[];
        rivalPositiveIds: number[];
    };

    const compCases: CompCase[] = [];
    for (let i = 0; i + 1 < originals.length; i += 3) {
        const a = originals[i]!;
        const b = originals[i + 1]!;
        const aPos = (byFamily.get(a.family) ?? [])
            .filter((p) => p.role === "positive")
            .map((p) => p.id);
        const bPos = (byFamily.get(b.family) ?? [])
            .filter((p) => p.role === "positive")
            .map((p) => p.id);
        compCases.push({
            name: `excl-${a.family}-vs-${b.family}`,
            selectedSeeds: [a.id],
            rivalSeedGroups: [[b.id]],
            positiveIds: aPos,
            rivalPositiveIds: bPos,
        });
    }
    for (let i = 0; i < originals.length; i += 4) {
        const a = originals[i]!;
        const nearTwin = photos.find(
            (p) =>
                p.family === a.family &&
                (p.label.endsWith("-bright") || p.label.endsWith("-mirror")),
        );
        if (!nearTwin) {
            continue;
        }
        const aPos = (byFamily.get(a.family) ?? [])
            .filter((p) => p.role === "positive" && p.id !== nearTwin.id)
            .map((p) => p.id);
        const distant = originals[(i + 2) % originals.length]!;
        const distantPos = (byFamily.get(distant.family) ?? [])
            .filter((p) => p.role === "positive")
            .map((p) => p.id);
        compCases.push({
            name: `soft-${a.family}~twin`,
            selectedSeeds: [a.id],
            rivalSeedGroups: [[nearTwin.id]],
            positiveIds: aPos,
            rivalPositiveIds: distantPos,
        });
    }

    type CompMetrics = {
        name: string;
        kitDelta: number;
        plainAuc: number;
        compAuc: number;
        rivalLift: number;
    };

    const evalComp = (
        testCase: CompCase,
        lambda: number,
        tau: number,
    ): CompMetrics => {
        const selected = pickKitMedoids(testCase.selectedSeeds, entries);
        const rivals = testCase.rivalSeedGroups.map((ids) =>
            pickKitMedoids(ids, entries),
        );
        const delta =
            rivals[0]?.length ?
                kitDistance(selected, rivals[0]!) :
                Number.POSITIVE_INFINITY;
        const opts = { lambda, tau };
        const mean = (xs: number[]): number =>
            xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
        const aucPair = (pos: number[], neg: number[]): number => {
            if (!pos.length || !neg.length) {
                return 0;
            }
            let wins = 0;
            for (const p of pos) {
                for (const n of neg) {
                    if (p < n) {
                        wins += 1;
                    } else if (p === n) {
                        wins += 0.5;
                    }
                }
            }
            return wins / (pos.length * neg.length);
        };
        const plainPos = testCase.positiveIds.map((id) =>
            kitNearnessDistance(id, selected, entries),
        );
        const plainRival = testCase.rivalPositiveIds.map((id) =>
            kitNearnessDistance(id, selected, entries),
        );
        const compPos = testCase.positiveIds.map((id) =>
            kitNearnessDistanceCompetitive(
                id,
                selected,
                rivals,
                entries,
                opts,
            ),
        );
        const compRival = testCase.rivalPositiveIds.map((id) =>
            kitNearnessDistanceCompetitive(
                id,
                selected,
                rivals,
                entries,
                opts,
            ),
        );
        return {
            name: testCase.name,
            kitDelta: delta,
            plainAuc: aucPair(plainPos, plainRival),
            compAuc: aucPair(compPos, compRival),
            rivalLift: mean(compRival) - mean(plainRival),
        };
    };

    console.log(
        `\n=== competitive λ×τ sweep (${compCases.length} cases) ===`,
    );
    const lambdas = [0.5, 1.0, 1.5, 2.0];
    const taus = [4, 8, 12, 16];
    let bestComp = {
        lambda: KIT_RIVAL_LAMBDA,
        tau: KIT_RIVAL_TAU,
        score: -Infinity,
        exclAuc: 0,
        softLift: 0,
    };
    for (const tau of taus) {
        for (const lambda of lambdas) {
            const rows = compCases.map((c) => evalComp(c, lambda, tau));
            const excl = rows.filter((r) => r.name.startsWith("excl-"));
            const soft = rows.filter((r) => r.name.startsWith("soft-"));
            const exclAuc =
                excl.reduce((a, r) => a + r.compAuc, 0) /
                Math.max(1, excl.length);
            const exclLift =
                excl.reduce((a, r) => a + r.rivalLift, 0) /
                Math.max(1, excl.length);
            const softLift =
                soft.reduce((a, r) => a + r.rivalLift, 0) /
                Math.max(1, soft.length);
            const score = exclAuc + 0.02 * exclLift - 0.05 * Math.max(0, softLift);
            const marker =
                lambda === KIT_RIVAL_LAMBDA && tau === KIT_RIVAL_TAU ?
                    " ← default" :
                    "";
            console.log(
                `  λ=${lambda.toFixed(1)} τ=${String(tau).padStart(2)}  exclAUC=${exclAuc.toFixed(3)}  exclLift=${exclLift.toFixed(1)}  softLift=${softLift.toFixed(1)}  score=${score.toFixed(3)}${marker}`,
            );
            if (score > bestComp.score) {
                bestComp = { lambda, tau, score, exclAuc, softLift };
            }
        }
    }
    console.log(
        `best competitive: λ=${bestComp.lambda} τ=${bestComp.tau} (exclAUC=${bestComp.exclAuc.toFixed(3)} softLift=${bestComp.softLift.toFixed(1)})`,
    );

    for (const prefix of ["excl", "soft"] as const) {
        const rows = compCases
            .filter((c) => c.name.startsWith(prefix))
            .map((c) => evalComp(c, bestComp.lambda, bestComp.tau));
        if (!rows.length) {
            continue;
        }
        const avg = (key: keyof CompMetrics): number =>
            rows.reduce((a, r) => a + Number(r[key]), 0) / rows.length;
        console.log(
            `\n=== competitive ${prefix}* @ λ=${bestComp.lambda} τ=${bestComp.tau} (n=${rows.length}) ===`,
        );
        console.log(
            `kitΔ=${avg("kitDelta").toFixed(1)}  plainAUC=${avg("plainAuc").toFixed(3)}  compAUC=${avg("compAuc").toFixed(3)}  rivalLift=${avg("rivalLift").toFixed(1)}`,
        );
    }
    console.log(
        `\nCHOSEN_COMPETITIVE λ=${bestComp.lambda} τ=${bestComp.tau}`,
    );
    void sortFilesByKitNearness;
    void sortFilesByKitNearnessCompetitive;
};

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
