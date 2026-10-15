/**
 * Compare image-embedding models on near-duplicate detection and neighbour
 * quality over the public eval datasets. Research only; not app code.
 *
 * Usage (from `mobileapp/`):
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/score-similar.ts [models…] [--selftest]
 * Default models: `mobileclip-s2 mobileclip2-s2 siglip2-b16-256 dinov3-s`. Vectors come from `embed.ts`.
 * Each section scores all models on the image ids they share (`loadAligned`).
 * Sections with missing manifests or vectors print "skipped: …". Only image
 * ids that every compared model has vectors for are used.
 *
 * Metrics (cosine = dot product of L2-normalised rows):
 * - AP: average precision, the mean of precision at each true positive's rank.
 * - ROC AUC: chance a random positive scores above a random negative.
 * - best F1: highest F1 over all cosine thresholds, with that threshold.
 * - recall @ precision >= 0.95: best recall whose precision stays >= 0.95, with its threshold.
 * - recall@1: share of queries whose nearest database image is their original.
 * - pooled pair AP (Copydays): per query, its original plus its top-200 database
 *   negatives, pooled over queries and ranked by cosine. Approximate: it ignores
 *   negatives below each query's top 200.
 * - mAP (Holidays): mean over scene groups of AP of the query's group-mates among all other images.
 * - Jaccard / precision@10: label-set overlap of an image's 10 nearest neighbours
 *   (unlabelled neighbours share nothing); precision@10 = share with >= 1 common label.
 * - chain coherence: mean Jaccard between consecutive images of a relative-sort chain.
 * - cost: embedding dims and Node CPU ms/image (not the phone).
 *
 * Writes `<root>/results/similar-<YYYYMMDD-HHmm>.{md,json}`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sortIdsByRelativePacked } from "@/lib/relative-sort-packed";
import { createRng, shuffleInPlace } from "@/lib/shuffle-files";
import { modelEvalDataRoot, readManifest, type EvalImage } from "./manifest";
import { hasVectors, loadVectors, rowDot } from "./vectors";

type Section = {
    title: string;
    rows: { metric: string; values: number[] }[];
    notes: string[];
};

type Skipped = { title: string; skipped: string };

type Aligned = {
    images: EvalImage[];
    pairs: { a: string; b: string; agreement: number }[];
    /** Per model, rows aligned with `images`. */
    perModel: { dims: number; packed: Float32Array; meta: Record<string, unknown> }[];
};

type RankingMetrics = {
    ap: number;
    auc: number;
    bestF1: number;
    bestF1Threshold: number;
    recallAtPrecision95: number;
    recallAtPrecision95Threshold: number;
};

const defaultModels = ["mobileclip-s2", "mobileclip2-s2", "siglip2-b16-256", "dinov3-s"];
const holidaysDataset = "holidays";
const distractorDatasets = ["coco-val2017", "mirflickr25k"];

const main = (): void => {
    const args = process.argv.slice(2);
    if (args.includes("--selftest")) {
        selfTest();
        return;
    }
    const models = args.length > 0 ? args : defaultModels;
    console.log(`models: ${models.join(", ")}; data root: ${modelEvalDataRoot()}`);

    const outcomes: (Section | Skipped)[] = [
        californiaSection(models),
        copydaysSection(models),
        holidaysSection(models),
        labelNeighbourSection(models, "coco-val2017"),
        labelNeighbourSection(models, "mirflickr25k"),
        chainSection(models),
        costSection(models),
    ];

    const markdown = outcomes.map((outcome) => renderSection(outcome, models)).join("\n");
    console.log(`\n${markdown}`);

    const resultsDir = join(modelEvalDataRoot(), "results");
    mkdirSync(resultsDir, { recursive: true });
    const base = join(resultsDir, `similar-${timestamp()}`);
    writeFileSync(`${base}.md`, markdown);
    writeFileSync(`${base}.json`, JSON.stringify({ models, sections: outcomes }, null, 2));
    console.log(`wrote ${base}.md and .json`);
};

/** California-ND: graded near-duplicate pairs against every other image pair. */
const californiaSection = (models: string[]): Section | Skipped => {
    const title = "California-ND near-duplicate pairs";
    const aligned = loadAligned(models, "california-nd");
    if (typeof aligned === "string") {
        return { title, skipped: aligned };
    }
    const { images, pairs } = aligned;
    const count = images.length;
    const rowById = new Map(images.map((image, row) => [image.id, row]));
    const positiveKeys = new Set<number>();
    for (const pair of pairs) {
        const a = rowById.get(pair.a);
        const b = rowById.get(pair.b);
        if (pair.agreement >= 0.5 && a !== undefined && b !== undefined && a !== b) {
            positiveKeys.add(Math.min(a, b) * count + Math.max(a, b));
        }
    }
    const pairCount = (count * (count - 1)) / 2;
    const labels = new Uint8Array(pairCount);
    const progress = makeProgress("california-nd pairs", count);

    const perModel = models.map((_, m) => {
        const { dims, packed } = aligned.perModel[m]!;
        const scores = new Float64Array(pairCount);
        let at = 0;
        for (let i = 0; i < count; i++) {
            for (let j = i + 1; j < count; j++) {
                scores[at] = rowDot(packed, i, packed, j, dims);
                labels[at] = positiveKeys.has(i * count + j) ? 1 : 0;
                at++;
            }
            progress(i);
        }
        return rankingMetrics(scores, labels);
    });

    return {
        title,
        rows: rankingRows(perModel),
        notes: [
            `${count} images, ${pairCount} pairs, ${positiveKeys.size} positives (agreement >= 0.5); all other pairs are negatives`,
        ],
    };
};

/** Copydays queries against a database of Copydays originals plus distractor datasets. */
const copydaysSection = (models: string[]): Section | Skipped => {
    const title = "Copydays with distractors";
    const copy = loadAligned(models, "copydays");
    if (typeof copy === "string") {
        return { title, skipped: copy };
    }
    const notes: string[] = [];
    const distractors: Aligned[] = [];
    for (const dataset of distractorDatasets) {
        const loaded = loadAligned(models, dataset);
        if (typeof loaded === "string") {
            notes.push(`distractors skipped: ${loaded}`);
        } else {
            distractors.push(loaded);
        }
    }

    const originalRows: number[] = [];
    const dbRowByGroup = new Map<string, number>();
    copy.images.forEach((image, row) => {
        if (image.edit === "original") {
            dbRowByGroup.set(image.group ?? image.id, originalRows.length);
            originalRows.push(row);
        }
    });
    const queries: { row: number; originalDbRow: number; family: string }[] = [];
    copy.images.forEach((image, row) => {
        const originalDbRow = dbRowByGroup.get(image.group ?? image.id);
        if (image.edit !== "original" && originalDbRow !== undefined) {
            queries.push({ row, originalDbRow, family: (image.edit ?? "unknown").split("-")[0]! });
        }
    });
    if (queries.length === 0) {
        return { title, skipped: "no non-original Copydays queries with an original" };
    }
    const distractorCount = distractors.reduce((sum, set) => sum + set.images.length, 0);
    const dbCount = originalRows.length + distractorCount;
    const families = [...new Set(queries.map((query) => query.family))].sort();
    const negativesPerQuery = 200;

    const perModel = models.map((name, m) => {
        const { dims, packed } = copy.perModel[m]!;
        const db = new Float32Array(dbCount * dims);
        originalRows.forEach((row, i) => {
            db.set(packed.subarray(row * dims, (row + 1) * dims), i * dims);
        });
        let offset = originalRows.length * dims;
        for (const set of distractors) {
            db.set(set.perModel[m]!.packed, offset);
            offset += set.perModel[m]!.packed.length;
        }

        const progress = makeProgress(`copydays ${name}`, queries.length);
        const hits = new Map<string, { hit: number; total: number }>();
        const pooledScores: number[] = [];
        const pooledLabels: number[] = [];
        queries.forEach((query, q) => {
            const vector = packed.subarray(query.row * dims, (query.row + 1) * dims);
            const nearest = nearestRows(db, dbCount, dims, vector, negativesPerQuery + 1, -1);
            for (const key of ["all", query.family]) {
                const tally = hits.get(key) ?? { hit: 0, total: 0 };
                tally.total++;
                tally.hit += nearest.rows[0] === query.originalDbRow ? 1 : 0;
                hits.set(key, tally);
            }
            pooledScores.push(rowDot(db, query.originalDbRow, packed, query.row, dims));
            pooledLabels.push(1);
            let negatives = 0;
            for (let i = 0; i < nearest.rows.length && negatives < negativesPerQuery; i++) {
                if (nearest.rows[i] !== query.originalDbRow && nearest.rows[i] !== -1) {
                    pooledScores.push(nearest.scores[i]!);
                    pooledLabels.push(0);
                    negatives++;
                }
            }
            progress(q);
        });

        const result: Record<string, number> = {};
        for (const key of ["all", ...families]) {
            const tally = hits.get(key)!;
            result[key === "all" ? "recall@1 (all queries)" : `recall@1 (${key})`] =
                tally.hit / tally.total;
        }
        result["pooled pair AP (approx.)"] = rankingMetrics(
            Float64Array.from(pooledScores),
            Uint8Array.from(pooledLabels),
        ).ap;
        return result;
    });

    notes.push(
        `${queries.length} queries, ${dbCount} database images (${originalRows.length} originals + ${distractorCount} distractors), ${queries.length} positives`,
        `pooled pair AP uses each query's original plus its top-${negativesPerQuery} database negatives; approximate`,
    );
    return { title, rows: recordRows(perModel), notes };
};

/** Holidays: mean AP of retrieving a scene's other images from its smallest-id image. */
const holidaysSection = (models: string[]): Section | Skipped => {
    const title = "Holidays mAP";
    const aligned = loadAligned(models, holidaysDataset);
    if (typeof aligned === "string") {
        return { title, skipped: aligned };
    }
    const { images } = aligned;
    const rowsByGroup = new Map<string, number[]>();
    images.forEach((image, row) => {
        if (image.group !== undefined) {
            rowsByGroup.set(image.group, [...(rowsByGroup.get(image.group) ?? []), row]);
        }
    });
    const queryRows: number[] = [];
    const memberSets: Set<number>[] = [];
    for (const rows of rowsByGroup.values()) {
        if (rows.length >= 2) {
            const query = rows.reduce((best, row) =>
                compareIds(images[row]!.id, images[best]!.id) < 0 ? row : best,
            );
            queryRows.push(query);
            memberSets.push(new Set(rows.filter((row) => row !== query)));
        }
    }
    if (queryRows.length === 0) {
        return { title, skipped: "no Holidays groups with >= 2 images" };
    }
    const positives = memberSets.reduce((sum, members) => sum + members.size, 0);

    const perModel = models.map((_, m) => {
        const { dims, packed } = aligned.perModel[m]!;
        const scores = new Float64Array(images.length - 1);
        const labels = new Uint8Array(images.length - 1);
        let total = 0;
        queryRows.forEach((query, q) => {
            let at = 0;
            for (let row = 0; row < images.length; row++) {
                if (row !== query) {
                    scores[at] = rowDot(packed, query, packed, row, dims);
                    labels[at] = memberSets[q]!.has(row) ? 1 : 0;
                    at++;
                }
            }
            total += rankingMetrics(scores, labels).ap;
        });
        return { mAP: total / queryRows.length };
    });

    return {
        title,
        rows: recordRows(perModel),
        notes: [
            `${images.length} images, ${queryRows.length} queries (groups with >= 2 images), ${positives} positives`,
        ],
    };
};

/** Label agreement of each sampled image's 10 nearest neighbours within one dataset. */
const labelNeighbourSection = (models: string[], dataset: string): Section | Skipped => {
    const title = `Neighbour label agreement: ${dataset}`;
    const aligned = loadAligned(models, dataset);
    if (typeof aligned === "string") {
        return { title, skipped: aligned };
    }
    const { images } = aligned;
    const labelSets = toLabelSets(images);
    const labelled = images.map((_, row) => row).filter((row) => labelSets[row] !== null);
    if (labelled.length === 0) {
        return { title, skipped: `${dataset} has no labelled images` };
    }
    const queries = shuffleInPlace(labelled, createRng(1)).slice(0, 5000);
    const neighbourCount = 10;

    const perModel = models.map((name, m) => {
        const { dims, packed } = aligned.perModel[m]!;
        const progress = makeProgress(`${dataset} ${name}`, queries.length);
        let jaccardSum = 0;
        let precisionSum = 0;
        let used = 0;
        queries.forEach((query, q) => {
            const vector = packed.subarray(query * dims, (query + 1) * dims);
            const nearest = nearestRows(packed, images.length, dims, vector, neighbourCount, query);
            let found = 0;
            let sharing = 0;
            let jaccard = 0;
            for (const row of nearest.rows) {
                if (row !== -1) {
                    const overlap = jaccardOf(labelSets[query]!, labelSets[row]!);
                    found++;
                    jaccard += overlap;
                    sharing += overlap > 0 ? 1 : 0;
                }
            }
            if (found > 0) {
                jaccardSum += jaccard / found;
                precisionSum += sharing / found;
                used++;
            }
            progress(q);
        });
        return {
            "mean Jaccard (10 NN)": jaccardSum / used,
            "precision@10 (>= 1 shared label)": precisionSum / used,
        };
    });

    return {
        title,
        rows: recordRows(perModel),
        notes: [
            `${images.length} images, ${labelled.length} labelled, ${queries.length} queries (seeded sample)`,
        ],
    };
};

/** Label coherence of a relative-sort "closest" chain over a MIRFLICKR sample. */
const chainSection = (models: string[]): Section | Skipped => {
    const title = "Relative-sort chain coherence: mirflickr25k";
    const aligned = loadAligned(models, "mirflickr25k");
    if (typeof aligned === "string") {
        return { title, skipped: aligned };
    }
    const allIndices = aligned.images.map((_, row) => row);
    const sample = shuffleInPlace(allIndices, createRng(2)).slice(0, 2000);
    if (sample.length < 2) {
        return { title, skipped: "fewer than 2 mirflickr25k images" };
    }
    const labelSets = toLabelSets(sample.map((row) => aligned.images[row]!));
    const sampleIds = sample.map((_, index) => index);
    const earlySteps = 200;

    const perModel = models.map((_, m) => {
        const { dims, packed } = aligned.perModel[m]!;
        const sampled = new Float32Array(sample.length * dims);
        sample.forEach((row, i) => {
            sampled.set(packed.subarray(row * dims, (row + 1) * dims), i * dims);
        });
        const order = sortIdsByRelativePacked(sampleIds, sampled, dims, "closest", 1);
        let earlySum = 0;
        let totalSum = 0;
        for (let step = 0; step < order.length - 1; step++) {
            const overlap = jaccardOf(labelSets[order[step]!]!, labelSets[order[step + 1]!]!);
            totalSum += overlap;
            earlySum += step < earlySteps ? overlap : 0;
        }
        const steps = order.length - 1;
        return {
            [`mean Jaccard, first ${earlySteps} steps`]: earlySum / Math.min(earlySteps, steps),
            "mean Jaccard, whole chain": totalSum / steps,
        };
    });

    return {
        title,
        rows: recordRows(perModel),
        notes: [
            `${sample.length} sampled images (seeded), ${sample.length - 1} chain steps; mode "closest", seed 1, no start file`,
        ],
    };
};

/** Embedding size and Node CPU time per image, from each model's meta. */
const costSection = (models: string[]): Section | Skipped => {
    const title = "Cost";
    const datasets = [...distractorDatasets, "copydays", holidaysDataset, "california-nd"];
    const perModel: Record<string, number>[] = [];
    for (const model of models) {
        const dataset = datasets.find((name) => hasVectors(model, name));
        if (dataset === undefined) {
            return { title, skipped: `no vectors for ${model}` };
        }
        const loaded = loadVectors(model, dataset);
        const msPerImage = loaded.meta.msPerImage;
        perModel.push({
            dims: loaded.dims,
            "ms per image": typeof msPerImage === "number" ? msPerImage : Number.NaN,
        });
    }
    return {
        title,
        rows: recordRows(perModel),
        notes: ["ms per image is Node CPU time while embedding, not the phone"],
    };
};

/** Sort descending by score and compute AP, ROC AUC, best F1 and recall at precision >= 0.95. */
export const rankingMetrics = (scores: Float64Array, labels: Uint8Array): RankingMetrics => {
    const count = scores.length;
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
        order[i] = i;
    }
    order.sort((a, b) => scores[b]! - scores[a]!);

    let positives = 0;
    for (let i = 0; i < count; i++) {
        positives += labels[i]!;
    }
    const negatives = count - positives;
    const result: RankingMetrics = {
        ap: 0,
        auc: 0,
        bestF1: 0,
        bestF1Threshold: Number.NaN,
        recallAtPrecision95: 0,
        recallAtPrecision95Threshold: Number.NaN,
    };
    if (positives === 0 || negatives === 0) {
        return { ...result, ap: Number.NaN, auc: Number.NaN };
    }

    let truePositives = 0;
    let falsePositives = 0;
    let aucSum = 0;
    let apSum = 0;
    let start = 0;
    while (start < count) {
        // A tie group is evaluated as one threshold.
        const score = scores[order[start]!]!;
        let end = start;
        let groupPositives = 0;
        while (end < count && scores[order[end]!] === score) {
            groupPositives += labels[order[end]!]!;
            end++;
        }
        const groupNegatives = end - start - groupPositives;
        aucSum += groupNegatives * (truePositives + 0.5 * groupPositives);
        truePositives += groupPositives;
        falsePositives += groupNegatives;
        const precision = truePositives / (truePositives + falsePositives);
        const recall = truePositives / positives;
        apSum += precision * groupPositives;
        const f1 = (2 * precision * recall) / (precision + recall);
        if (f1 > result.bestF1) {
            result.bestF1 = f1;
            result.bestF1Threshold = score;
        }
        if (precision >= 0.95 && recall > result.recallAtPrecision95) {
            result.recallAtPrecision95 = recall;
            result.recallAtPrecision95Threshold = score;
        }
        start = end;
    }
    result.ap = apSum / positives;
    result.auc = aucSum / (positives * negatives);
    return result;
};

/** Jaccard overlap of two label sets; 0 when either is empty or unlabelled. */
export const jaccardOf = (left: Set<string> | null, right: Set<string> | null): number => {
    if (!left || !right) {
        return 0;
    }
    let shared = 0;
    for (const label of left) {
        shared += right.has(label) ? 1 : 0;
    }
    return shared / (left.size + right.size - shared);
};

/**
 * Brute-force top-`k` rows of `db` by dot product with `query`, best first,
 * skipping `skipRow`. Unfilled slots have row -1.
 */
const nearestRows = (
    db: Float32Array,
    rowCount: number,
    dims: number,
    query: Float32Array,
    k: number,
    skipRow: number,
): { rows: Int32Array; scores: Float64Array } => {
    const rows = new Int32Array(k).fill(-1);
    const scores = new Float64Array(k).fill(Number.NEGATIVE_INFINITY);
    for (let row = 0; row < rowCount; row++) {
        if (row === skipRow) {
            continue;
        }
        const start = row * dims;
        let sum = 0;
        for (let d = 0; d < dims; d++) {
            sum += db[start + d]! * query[d]!;
        }
        if (sum > scores[k - 1]!) {
            let slot = k - 1;
            while (slot > 0 && scores[slot - 1]! < sum) {
                scores[slot] = scores[slot - 1]!;
                rows[slot] = rows[slot - 1]!;
                slot--;
            }
            scores[slot] = sum;
            rows[slot] = row;
        }
    }
    return { rows, scores };
};

/** Load every model's vectors for a dataset restricted to the ids all models share, or return why not. */
const loadAligned = (models: string[], dataset: string): Aligned | string => {
    if (!existsSync(join(modelEvalDataRoot(), dataset, "manifest.json"))) {
        return `${dataset} manifest missing`;
    }
    const missing = models.filter((model) => !hasVectors(model, dataset));
    if (missing.length > 0) {
        return `${dataset} vectors missing for ${missing.join(", ")}`;
    }
    const manifest = readManifest(dataset);
    const loaded = models.map((model) => loadVectors(model, dataset));
    const images = manifest.images.filter((image) => loaded.every((v) => v.rowById.has(image.id)));
    if (images.length === 0) {
        return `${dataset} has no ids shared by all models`;
    }
    const perModel = loaded.map(({ dims, packed, rowById, meta }) => {
        const aligned = new Float32Array(images.length * dims);
        images.forEach((image, i) => {
            const source = rowById.get(image.id)! * dims;
            aligned.set(packed.subarray(source, source + dims), i * dims);
        });
        return { dims, packed: aligned, meta };
    });
    return { images, pairs: manifest.pairs ?? [], perModel };
};

const toLabelSets = (images: EvalImage[]): (Set<string> | null)[] =>
    images.map((image) => (image.labels?.length ? new Set(image.labels) : null));

/** Numeric comparison when both ids are numbers, else string comparison. */
const compareIds = (left: string, right: string): number => {
    const a = Number(left);
    const b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
};

const rankingRows = (perModel: RankingMetrics[]): Section["rows"] =>
    recordRows(
        perModel.map((m) => ({
            AP: m.ap,
            "ROC AUC": m.auc,
            "best F1": m.bestF1,
            "best F1 cosine threshold": m.bestF1Threshold,
            "recall @ precision >= 0.95": m.recallAtPrecision95,
            "cosine threshold @ precision >= 0.95": m.recallAtPrecision95Threshold,
        })),
    );

/** Turn one metric record per model into rows, in the first model's key order. */
const recordRows = (perModel: Record<string, number>[]): Section["rows"] =>
    Object.keys(perModel[0]!).map((metric) => ({
        metric,
        values: perModel.map((record) => record[metric] ?? Number.NaN),
    }));

const renderSection = (outcome: Section | Skipped, models: string[]): string => {
    if ("skipped" in outcome) {
        return `### ${outcome.title}\n\nskipped: ${outcome.skipped}\n`;
    }
    const header = `| Metric | ${models.join(" | ")} | Δ (2nd − 1st) |`;
    const divider = `|---|${models.map(() => "---:|").join("")}---:|`;
    const lines = outcome.rows.map(({ metric, values }) => {
        const delta = values.length >= 2 ? formatNumber(values[1]! - values[0]!) : "–";
        return `| ${metric} | ${values.map(formatNumber).join(" | ")} | ${delta} |`;
    });
    const notes = outcome.notes.map((note) => `- ${note}`);
    return [`### ${outcome.title}`, "", header, divider, ...lines, "", ...notes, ""].join("\n");
};

const formatNumber = (value: number): string => {
    if (Number.isNaN(value)) {
        return "n/a";
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
};

/** Print a progress line at most every 15 s. */
const makeProgress = (label: string, total: number): ((done: number) => void) => {
    let last = Date.now();
    return (done: number): void => {
        if (Date.now() - last > 15000) {
            last = Date.now();
            console.log(`  ${label}: ${done}/${total}`);
        }
    };
};

const timestamp = (): string => {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
};

/** Micro cases for the metric helpers. */
const selfTest = (): void => {
    const check = (name: string, actual: number, expected: number): void => {
        const ok = Math.abs(actual - expected) < 1e-9;
        console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${actual} (expected ${expected})`);
        if (!ok) {
            process.exitCode = 1;
        }
    };
    const labels = Uint8Array.from([1, 1, 0, 0]);
    const perfect = rankingMetrics(Float64Array.from([0.9, 0.8, 0.2, 0.1]), labels);
    check("perfect AP", perfect.ap, 1);
    check("perfect AUC", perfect.auc, 1);
    check("perfect best F1", perfect.bestF1, 1);
    check("perfect recall@P95", perfect.recallAtPrecision95, 1);
    const reversed = rankingMetrics(Float64Array.from([0.1, 0.2, 0.8, 0.9]), labels);
    check("reversed AUC", reversed.auc, 0);
    check("all-tied AUC", rankingMetrics(Float64Array.from([1, 1, 1, 1]), labels).auc, 0.5);
    check("mixed AP", rankingMetrics(Float64Array.from([0.9, 0.7, 0.8, 0.1]), labels).ap, (1 + 2 / 3) / 2);
    check("jaccard", jaccardOf(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
};

main();
