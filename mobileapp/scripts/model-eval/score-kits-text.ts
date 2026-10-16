/**
 * Does a CLIP-family text encoder (MobileCLIP-S2, MobileCLIP2-S2, SigLIP 2) help
 * kit nearness when a kit has few or no example photos? Research only; not app code.
 *
 * Usage (from `mobileapp/`):
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/score-kits-text.ts
 *
 * Same protocol, eval kits, splits, minimums, negatives, metrics and bootstrap as
 * `score-kits.ts` (imported from it), on `coco-val2017` and `mirflickr25k` with
 * every model in `TEXT_MODELS` that has image vectors (ids intersected across
 * those models per dataset; a model without vectors is skipped with a log line;
 * `TEXT_DTYPE` applies to all text towers). Each kit gets one vector and every image is scored by
 * cosine to it, with no rival penalty (tuning picked lambda=0 on COCO in round 1).
 * - `examples`: normalise(sum of k example image vectors), k >= 1.
 * - `text`: the kit's prompt vector alone. `mean` = normalised mean of the
 *   per-label prompts ("a photo of {label}"); `joint` = one prompt naming all
 *   labels. One-label kits have a single text vector, reported as `mean`.
 * - `blend`: normalise(m * text + sum of example vectors), i.e. the text acts as
 *   m pseudo-examples. m is tuned per dataset and text variant on the seed-7
 *   split by the mean over k in {1, 2, 4, 8, 16} of hard AUC (arity 2-3) or easy
 *   AUC (arity 1).
 * - k in {0, 1, 2, 4, 8, 16, all}: `all` = the first MAX_KIT_SEEDS train
 *   positives (as `score-kits.ts` builds its centroid); other k are drawn with a
 *   RNG keyed on split seed and kit, shared by all methods (nested across k). A
 *   kit with fewer than k train positives uses them all; this is counted.
 *
 * - gate check: for each eval kit, its train positives (k = 1, 4, 16, all) are
 *   seeds; the joint prompt's cosine to all images gives each seed a percentile
 *   among them. Reported per k: min / p10 / median over kits of the mean seed
 *   percentile, and the same for 200 random pseudo-kits (random images with a
 *   random kit's joint prompt; should be about 0.5). Calibrates an app-side gate
 *   that drops the text prior when the mean seed percentile is below 0.7.
 *
 * Output: sanity section (text-only AP per dataset label) first, then tables on
 * stdout and in `<root>/results/kits-text-<stamp>.md`, raw per-kit numbers in the
 * matching `.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_EMBEDDING_MODEL_ID, l2NormalizeEmbedding } from "@/lib/embedding-vector";
import { MAX_KIT_SEEDS } from "@/lib/kit-nearness-sort";
import { createRng, shuffleInPlace } from "@/lib/shuffle-files";
import { prepareMobileClip2, siglip2Repo, type ModelName, type Transformers } from "./embed";
import { modelEvalDataRoot } from "./manifest";
import { hasVectors } from "./vectors";
import {
    averagePrecision,
    bootstrapInterval,
    buildFold,
    buildSeedContext,
    computeMetrics,
    EVAL_SEEDS,
    groupOf,
    kitMeans,
    loadDataset,
    log,
    makeSplit,
    mean,
    METRIC_LABELS,
    percent,
    rankAuc,
    signedPercent,
    TUNE_SEED,
    type DatasetData,
    type EvalKit,
    type Fold,
    type Group,
    type Metric,
    type Metrics,
    type ModelData,
    type SeedContext,
} from "./score-kits";

type TextVariant = "mean" | "joint";
type Method = "examples" | `text-${TextVariant}` | `blend-${TextVariant}`;
type KCount = number | "all";

type Result = {
    model: string;
    dataset: string;
    kit: string;
    arity: number;
    seed: number;
    k: KCount;
    method: Method;
    /** The kit had fewer than k train positives, so all of them were used. */
    short: boolean;
    metrics: Metrics;
};

/** Normalised text vector per variant; the same array for one-label kits. */
type KitText = Record<TextVariant, Float32Array>;

type TextEmbedder = (prompts: string[]) => Promise<Float32Array[]>;

type Tensor = { data: Float32Array; dims: number[] };

type TextModelSpec = {
    name: ModelName;
    /** Wraps a label (or "a, b and c") in the model's prompt template. */
    prompt: (subject: string) => string;
    /** The export has no quantised text tower, so `TEXT_DTYPE` other than fp32 skips it. */
    fp32Only?: boolean;
    load: (lib: Transformers) => Promise<TextEmbedder>;
};

const TEXT_DTYPE = (process.env.TEXT_DTYPE ?? "fp32") as "fp32" | "fp16" | "q8";

/** Text tower of each image-text model, all on CPU. */
const TEXT_MODELS: TextModelSpec[] = [
    {
        name: "mobileclip-s2",
        prompt: (subject) => `a photo of ${subject}`,
        load: async (lib) =>
            makeTextEmbedder(
                await tokenizerOf(lib, KIT_EMBEDDING_MODEL_ID),
                await lib.CLIPTextModelWithProjection.from_pretrained(KIT_EMBEDDING_MODEL_ID, {
                    device: "cpu",
                    dtype: TEXT_DTYPE,
                }),
                "text_embeds",
                { padding: "max_length", truncation: true },
            ),
    },
    {
        // Community ONNX export; same open_clip tokenizer as Xenova/mobileclip_s2 (context 77).
        name: "mobileclip2-s2",
        prompt: (subject) => `a photo of ${subject}`,
        load: async (lib) => {
            // Sets `env.localModelPath`; the hub-layout folder (with its q8 text tower) holds the same fp32 files.
            await prepareMobileClip2(lib);
            return makeTextEmbedder(
                await tokenizerOf(lib, KIT_EMBEDDING_MODEL_ID),
                await lib.CLIPTextModelWithProjection.from_pretrained("mobileclip2-s2-hub", {
                    device: "cpu",
                    dtype: TEXT_DTYPE,
                    model_file_name: "text_model",
                }),
                "text_embeds",
                { padding: "max_length", truncation: true },
            );
        },
    },
    {
        // Gemma tokenizer: lowercase text, pad to 64.
        name: "siglip2-b16-256",
        prompt: (subject) => `this is a photo of ${subject}.`.toLowerCase(),
        load: async (lib) =>
            makeTextEmbedder(
                await tokenizerOf(lib, siglip2Repo),
                await lib.SiglipTextModel.from_pretrained(siglip2Repo, {
                    device: "cpu",
                    dtype: TEXT_DTYPE,
                    model_file_name: "text_model",
                }),
                "pooler_output",
                { padding: "max_length", max_length: 64, truncation: true },
            ),
    },
];

const DATASETS = ["coco-val2017", "mirflickr25k"];
const K_VALUES: KCount[] = [0, 1, 2, 4, 8, 16, "all"];
const TUNE_KS = [1, 2, 4, 8, 16];
const BLEND_WEIGHTS = [1, 2, 4, 8, 16, 32, 64];
const TEXT_VARIANTS: TextVariant[] = ["mean", "joint"];
const EMBED_BATCH = 32;
const GATE_KS: KCount[] = [1, 4, 16, "all"];
const GATE_RANDOM_KITS = 200;
const GATE_THRESHOLD = 0.7;
const TABLE_METRICS: Record<Group, Metric[]> = {
    arity1: ["easyAuc", "fullAt12"],
    "arity2-3": ["hardAuc", "hardAt12"],
};

const main = async (): Promise<void> => {
    const lib: Transformers = await import("transformers-eval");
    const embedders = new Map<ModelName, TextEmbedder>();
    const results: Result[] = [];
    /** model → dataset → chosen m. */
    const chosen: Record<string, Record<string, Record<TextVariant, number>>> = {};
    const usedDatasets: string[] = [];
    /** Sanity and gate-check lines per model and dataset, in run order. */
    const checks: Record<string, string[]> = {};

    for (const dataset of DATASETS) {
        const available = TEXT_MODELS.filter((spec) => {
            const skip = !hasVectors(spec.name, dataset)
                ? "no image vectors"
                : spec.fp32Only && TEXT_DTYPE !== "fp32"
                  ? `no ${TEXT_DTYPE} text tower`
                  : undefined;
            if (skip) {
                log(`${dataset}: skipping ${spec.name} (${skip})`);
            }
            return !skip;
        });
        const loaded = available.length ? loadDataset(dataset, available.map((spec) => spec.name)) : undefined;
        if (!loaded) {
            continue;
        }
        usedDatasets.push(dataset);
        const { data } = loaded;
        log(
            `${dataset}: ${data.size} images shared by ${available.map((spec) => spec.name).join(", ")}, ` +
                `${data.labelNames.length} labels, ${data.kits.length} eval kits`,
        );

        for (const [index, spec] of available.entries()) {
            const model = loaded.modelData[index]!;
            let embedText = embedders.get(spec.name);
            if (!embedText) {
                embedText = await spec.load(lib);
                embedders.set(spec.name, embedText);
            }
            const { labelVectors, kitTexts } = await embedKitTexts(embedText, spec, data, model.dims);
            const section = [
                ...sanitySection(spec, data, model, labelVectors),
                ...gateSection(spec, data, model, buildSeedContext(data, model, makeSplit(data, EVAL_SEEDS[0]!)), kitTexts),
            ];
            console.log(section.join("\n"));
            (checks[spec.name] ??= []).push(...section);

            const tuneContext = buildSeedContext(data, model, makeSplit(data, TUNE_SEED));
            const weights = tuneWeights(tuneContext, kitTexts);
            (chosen[spec.name] ??= {})[dataset] = weights;
            log(`${dataset}/${spec.name}: tuned m mean=${weights.mean} joint=${weights.joint}`);
            for (const seed of EVAL_SEEDS) {
                const context = buildSeedContext(data, model, makeSplit(data, seed));
                results.push(...evaluateSeed(spec.name, context, kitTexts, weights));
                log(`${dataset}/${spec.name}: seed ${seed} done`);
            }
        }
    }
    if (!usedDatasets.length) {
        throw new Error("No dataset has a manifest and image vectors for any text model");
    }

    const markdown = renderMarkdown(usedDatasets, results, chosen, checks);
    console.log(`\n${markdown}`);
    const directory = join(modelEvalDataRoot(), "results");
    mkdirSync(directory, { recursive: true });
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
        `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const base = join(directory, `kits-text-${TEXT_DTYPE}-${stamp}`);
    writeFileSync(`${base}.md`, markdown);
    writeFileSync(
        `${base}.json`,
        JSON.stringify({ datasets: usedDatasets, textDtype: TEXT_DTYPE, chosenWeights: chosen, results }),
    );
    log(`wrote ${base}.{md,json}`);
};

// ---------------------------------------------------------------------------
// Text embeddings

type Tokenizer = (texts: string[], options: object) => unknown;

const tokenizerOf = async (lib: Transformers, repo: string): Promise<Tokenizer> =>
    (await lib.AutoTokenizer.from_pretrained(repo)) as unknown as Tokenizer;

/** Batch prompts through a text tower and L2-normalise the `outputKey` rows. */
const makeTextEmbedder = (
    tokenizer: Tokenizer,
    tower: unknown,
    outputKey: string,
    tokenizerOptions: object,
): TextEmbedder => {
    const network = tower as (input: unknown) => Promise<Record<string, Tensor | undefined>>;
    return async (prompts) => {
        const vectors: Float32Array[] = [];
        for (let first = 0; first < prompts.length; first += EMBED_BATCH) {
            const batch = prompts.slice(first, first + EMBED_BATCH);
            const output = await network(tokenizer(batch, tokenizerOptions));
            const tensor = output[outputKey];
            if (!tensor) {
                throw new Error(`Text model output has no ${outputKey}`);
            }
            const [count, dims] = tensor.dims as [number, number];
            for (let row = 0; row < count; row += 1) {
                vectors.push(normalized(tensor.data.slice(row * dims, (row + 1) * dims)));
            }
        }
        return vectors;
    };
};

const labelText = (data: DatasetData, labelId: number): string =>
    data.labelNames[labelId]!.replace(/_/g, " ");

/** One prompt naming all labels: "a and b" / "a, b and c" in the model's template. */
const jointPrompt = (spec: TextModelSpec, data: DatasetData, kit: EvalKit): string => {
    const names = kit.labelIds.map((id) => labelText(data, id));
    const last = names.pop()!;
    return spec.prompt(`${names.length ? `${names.join(", ")} and ` : ""}${last}`);
};

/** Prompt vectors for every dataset label and for each eval kit (mean and joint). */
const embedKitTexts = async (
    embedText: TextEmbedder,
    spec: TextModelSpec,
    data: DatasetData,
    dims: number,
): Promise<{ labelVectors: Float32Array[]; kitTexts: KitText[] }> => {
    const labelPrompts = data.labelNames.map((_, id) => spec.prompt(labelText(data, id)));
    const jointPrompts = data.kits.map((kit) => (kit.arity === 1 ? undefined : jointPrompt(spec, data, kit)));
    const prompts = [...new Set([...labelPrompts, ...jointPrompts.filter((p): p is string => !!p)])];
    const embedded = await embedText(prompts);
    const vectorByPrompt = new Map(prompts.map((prompt, index) => [prompt, embedded[index]!]));
    if (embedded[0]!.length !== dims) {
        throw new Error(`Text dims ${embedded[0]!.length} differ from image dims ${dims}`);
    }
    const labelVectors = labelPrompts.map((prompt) => vectorByPrompt.get(prompt)!);
    const kitTexts = data.kits.map((kit, index): KitText => {
        const sum = new Float32Array(dims);
        for (const id of kit.labelIds) {
            addScaled(sum, labelVectors[id]!, 1);
        }
        const meanVector = normalized(sum);
        const joint = jointPrompts[index];
        return { mean: meanVector, joint: joint ? vectorByPrompt.get(joint)! : meanVector };
    });
    log(`${spec.name}: embedded ${prompts.length} prompts`);
    return { labelVectors, kitTexts };
};

// ---------------------------------------------------------------------------
// Sanity: text-only retrieval of each dataset label

const sanitySection = (
    spec: TextModelSpec,
    data: DatasetData,
    model: ModelData,
    labelVectors: Float32Array[],
): string[] => {
    const rows = data.labelNames.flatMap((name, id) => {
        const mask = data.labelMasks[id]!;
        if (!mask.some((value) => value === 1)) {
            return [];
        }
        const scores = scoreRows(model.packed, data.size, model.dims, labelVectors[id]!);
        const ranked = Array.from({ length: data.size }, (_, index) => index).sort(
            (a, b) => scores[b]! - scores[a]! || a - b,
        );
        return [{ name, ap: averagePrecision(ranked, mask) }];
    });
    rows.sort((a, b) => b.ap - a.ap);
    const format = (list: typeof rows): string => list.map((r) => `${r.name} ${percent(r.ap)}`).join(", ");
    return [
        `### Sanity: ${spec.name} on ${data.name}`,
        ``,
        `Text-only retrieval over all ${data.size} images, prompt "${spec.prompt("{label}")}", ${rows.length} labels. ` +
            `Mean AP ${percent(mean(rows.map((r) => r.ap)))}%.`,
        ``,
        `- Best 3: ${format(rows.slice(0, 3))}`,
        `- Worst 3: ${format(rows.slice(-3).reverse())}`,
        ``,
    ];
};

// ---------------------------------------------------------------------------
// Gate check: where do a kit's own photos rank under its joint text prompt?

const gateSection = (
    spec: TextModelSpec,
    data: DatasetData,
    model: ModelData,
    context: SeedContext,
    kitTexts: KitText[],
): string[] => {
    const scoresByKit = kitTexts.map((text) => {
        const scores = scoreRows(model.packed, data.size, model.dims, text.joint);
        return { scores, sorted: Float64Array.from(scores).sort() };
    });
    const meanPercentile = (kitIndex: number, rows: number[]): number => {
        const { scores, sorted } = scoresByKit[kitIndex]!;
        return mean(rows.map((row) => percentileOf(sorted, scores[row]!)));
    };
    const draws = data.kits.map((kit) => drawExamples(context, kit));
    const rng = createRng(2024);
    const table = GATE_KS.map((k) => {
        const real = data.kits.flatMap((_, kitIndex) =>
            draws[kitIndex]!.positives ? [meanPercentile(kitIndex, draws[kitIndex]!.rowsFor(k))] : [],
        );
        const randomCount = k === "all" ? MAX_KIT_SEEDS : k;
        const random = Array.from({ length: GATE_RANDOM_KITS }, () => {
            const rows = new Set<number>();
            while (rows.size < Math.min(randomCount, data.size)) {
                rows.add(Math.floor(rng() * data.size));
            }
            return meanPercentile(Math.floor(rng() * data.kits.length), [...rows]);
        });
        const summary = (values: number[]): string => {
            const sorted = [...values].sort((a, b) => a - b);
            const at = (q: number): string => sorted[Math.floor(q * (sorted.length - 1))]!.toFixed(2);
            const below = sorted.filter((value) => value < GATE_THRESHOLD).length;
            return `${at(0)} / ${at(0.1)} / ${at(0.5)} (${below}/${sorted.length} < ${GATE_THRESHOLD})`;
        };
        return `| ${k} | ${summary(real)} | ${summary(random)} |`;
    });
    return [
        `### Gate check: ${spec.name} on ${data.name}`,
        ``,
        `Mean percentile of the first k train positives' cosine to the kit's joint prompt among all ${data.size} images ` +
            `(seed ${context.split.seed} split; min / p10 / median over kits). Random = ${GATE_RANDOM_KITS} pseudo-kits of random images with a random kit's prompt; expect about 0.5.`,
        ``,
        `| k | real kits | random pseudo-kits |`,
        `|---|---|---|`,
        ...table,
        ``,
    ];
};

/** Share of `sorted` scoring strictly below `score`. */
const percentileOf = (sorted: Float64Array, score: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle]! < score) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low / sorted.length;
};

// ---------------------------------------------------------------------------
// Example draws and kit vectors

/** Train positives of a kit under one split, and the seeded draw order over them. */
type ExampleDraw = { positives: number; rowsFor: (k: KCount) => number[] };

const drawExamples = (context: SeedContext, kit: EvalKit): ExampleDraw => {
    const positives: number[] = [];
    for (let row = 0; row < context.data.size; row += 1) {
        if (context.split.isTrain[row] && kit.carried[row] === kit.arity) {
            positives.push(row);
        }
    }
    const shuffled = shuffleInPlace(
        [...positives],
        createRng(context.split.seed * 1_000_003 + hashString(kit.name)),
    );
    const firstSeeds = positives.slice(0, MAX_KIT_SEEDS);
    return {
        positives: positives.length,
        rowsFor: (k) => (k === "all" ? firstSeeds : shuffled.slice(0, k)),
    };
};

const hashString = (value: string): number => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    }
    return hash >>> 0;
};

const sumRows = (rows: number[], model: ModelData): Float32Array => {
    const sum = new Float32Array(model.dims);
    for (const row of rows) {
        addScaled(sum, model.vectors.get(row)!, 1);
    }
    return sum;
};

const addScaled = (target: Float32Array, source: Float32Array, scale: number): void => {
    for (let i = 0; i < target.length; i += 1) {
        target[i]! += scale * source[i]!;
    }
};

/** normalise(weight * text + exampleSum). */
const blendVector = (exampleSum: Float32Array, text: Float32Array, weight: number): Float32Array => {
    const blended = Float32Array.from(exampleSum);
    addScaled(blended, text, weight);
    return normalized(blended);
};

const normalized = (vector: Float32Array): Float32Array => {
    const result = l2NormalizeEmbedding(vector);
    if (!result) {
        throw new Error("Zero or non-finite vector");
    }
    return result;
};

/** Cosine (dot of unit vectors) of the first `count` packed rows against `vector`. */
const scoreRows = (packed: Float32Array, count: number, dims: number, vector: Float32Array): Float64Array => {
    const scores = new Float64Array(count);
    for (let row = 0; row < count; row += 1) {
        const start = row * dims;
        let sum = 0;
        for (let d = 0; d < dims; d += 1) {
            sum += packed[start + d]! * vector[d]!;
        }
        scores[row] = sum;
    }
    return scores;
};

// ---------------------------------------------------------------------------
// Tuning and evaluation

/** Hard AUC for arity 2-3 kits, easy AUC for arity 1. */
const tuningObjective = (scores: Float64Array, fold: Fold, arity: number): number => {
    const pick = (indices: number[]): number[] => indices.map((index) => scores[index]!);
    return rankAuc(pick(fold.positives), pick(arity >= 2 ? fold.hard : fold.easy));
};

/** Pick the blend weight m per text variant on the tuning split. */
const tuneWeights = (context: SeedContext, kitTexts: KitText[]): Record<TextVariant, number> => {
    const { data, model, split } = context;
    const sums: Record<TextVariant, number[]> = {
        mean: BLEND_WEIGHTS.map(() => 0),
        joint: BLEND_WEIGHTS.map(() => 0),
    };
    let terms = 0;
    data.kits.forEach((kit, kitIndex) => {
        const fold = buildFold(context, kitIndex);
        if (!fold) {
            return;
        }
        const draw = drawExamples(context, kit);
        for (const k of TUNE_KS) {
            const exampleSum = sumRows(draw.rowsFor(k), model);
            for (const variant of TEXT_VARIANTS) {
                BLEND_WEIGHTS.forEach((weight, index) => {
                    const vector = blendVector(exampleSum, kitTexts[kitIndex]![variant], weight);
                    sums[variant][index]! += tuningObjective(
                        scoreRows(context.testVectors, split.testRows.length, model.dims, vector),
                        fold,
                        kit.arity,
                    );
                });
            }
            terms += 1;
        }
    });
    const best = (variant: TextVariant): number => {
        let bestIndex = 0;
        sums[variant].forEach((sum, index) => {
            if (sum > sums[variant][bestIndex]!) {
                bestIndex = index;
            }
        });
        return BLEND_WEIGHTS[bestIndex]!;
    };
    log(`tuning: ${terms} kit-k terms`);
    return { mean: best("mean"), joint: best("joint") };
};

/** Score every kit with a valid fold under this seed with all methods and k. */
const evaluateSeed = (
    modelName: string,
    context: SeedContext,
    kitTexts: KitText[],
    weights: Record<TextVariant, number>,
): Result[] => {
    const { data, model, split } = context;
    const results: Result[] = [];
    data.kits.forEach((kit, kitIndex) => {
        const fold = buildFold(context, kitIndex);
        if (!fold) {
            return;
        }
        const draw = drawExamples(context, kit);
        const text = kitTexts[kitIndex]!;
        const variants = kit.arity === 1 ? (["mean"] as TextVariant[]) : TEXT_VARIANTS;
        const record = (k: KCount, method: Method, vector: Float32Array): void => {
            const scores = scoreRows(context.testVectors, split.testRows.length, model.dims, vector);
            results.push({
                model: modelName,
                dataset: data.name,
                kit: kit.name,
                arity: kit.arity,
                seed: split.seed,
                k,
                method,
                short: k !== "all" && k > draw.positives,
                metrics: computeMetrics(scores, fold, kit.arity, split.testRows),
            });
        };
        for (const variant of variants) {
            record(0, `text-${variant}`, text[variant]);
        }
        for (const k of K_VALUES) {
            const exampleSum = sumRows(draw.rowsFor(k === 0 ? 0 : k), model);
            if (k !== 0) {
                record(k, "examples", normalized(Float32Array.from(exampleSum)));
            }
            for (const variant of variants) {
                record(k, `blend-${variant}`, blendVector(exampleSum, text[variant], weights[variant]));
            }
        }
    });
    return results;
};

// ---------------------------------------------------------------------------
// Output

const renderMarkdown = (
    datasets: string[],
    results: Result[],
    chosen: Record<string, Record<string, Record<TextVariant, number>>>,
    checks: Record<string, string[]>,
): string => {
    const modelNames = TEXT_MODELS.map((spec) => spec.name).filter((name) => name in chosen);
    const lines = [
        `# Kit nearness with text vectors: ${modelNames.join(", ")}`,
        ``,
        `Text dtype ${TEXT_DTYPE}. Each dataset is scored on the images all listed models share. All methods score by cosine to one kit vector with no rival penalty (tuning picked λ=0 on COCO in round 1). Values are percentages averaged over seeds ${EVAL_SEEDS.join("/")} per kit, then over kits. ` +
            `Δ = best blend (the text variant with the higher mean at that k) minus examples, in percentage points, with a 95% bootstrap CI over kits. ` +
            `k = number of example photos (all = up to ${MAX_KIT_SEEDS}); blend k=0 equals text. The text columns do not depend on k, so every row repeats the k=0 value. One-label kits have one text variant, shown as "text" / "blend".`,
    ];
    for (const modelName of modelNames) {
        lines.push(`## ${modelName}`, ``, ...checks[modelName]!);
        for (const dataset of datasets) {
            const weights = chosen[modelName]![dataset];
            if (!weights) {
                continue;
            }
            lines.push(
                `### ${modelName} · ${dataset}`,
                ``,
                `Chosen m (seed-${TUNE_SEED} tuning, mean over k ∈ {${TUNE_KS.join(", ")}}): mean ${weights.mean}, joint ${weights.joint}.`,
                ``,
                `Kit-seeds with fewer train positives than k (all of them used): ${K_VALUES.filter((k) => k !== 0 && k !== "all")
                    .map((k) => {
                        const rows = results.filter(
                            (row) =>
                                row.model === modelName && row.dataset === dataset && row.k === k && row.method === "blend-mean",
                        );
                        return `k=${k}: ${rows.filter((row) => row.short).length}/${rows.length}`;
                    })
                    .join(", ")}.`,
                ``,
            );
            for (const group of ["arity2-3", "arity1"] as Group[]) {
                const rows = results.filter(
                    (row) => row.model === modelName && row.dataset === dataset && groupOf(row.arity) === group,
                );
                if (rows.length) {
                    lines.push(...renderGroup(`${modelName} · ${dataset}`, group, rows), ``);
                }
            }
        }
    }
    return lines.join("\n");
};

const renderGroup = (dataset: string, group: Group, rows: Result[]): string[] => {
    const kitCount = new Set(rows.map((row) => row.kit)).size;
    const seedCount = rows.filter((row) => row.method === "text-mean").length;
    const joint = group === "arity2-3";
    const columns: { title: string; method: Method }[] = [
        { title: "examples", method: "examples" },
        { title: joint ? "text (mean)" : "text", method: "text-mean" },
        ...(joint ? [{ title: "text (joint)", method: "text-joint" as const }] : []),
        { title: joint ? "blend (mean)" : "blend", method: "blend-mean" },
        ...(joint ? [{ title: "blend (joint)", method: "blend-joint" as const }] : []),
    ];
    const blendMethods: Method[] = joint ? ["blend-mean", "blend-joint"] : ["blend-mean"];
    const lines = [`### ${dataset} · ${group === "arity1" ? "arity 1" : "arity 2–3"} (${kitCount} kits, ${seedCount} kit-seeds)`, ``];
    for (const metric of TABLE_METRICS[group]) {
        const kitValues = (method: Method, k: KCount): Map<string, number> =>
            kitMeans(
                rows.filter(
                    (row) => row.method === method && row.k === (method.startsWith("text") ? 0 : k),
                ),
                metric,
            );
        lines.push(
            `**${METRIC_LABELS[metric]}**`,
            ``,
            `| k | ${columns.map((c) => c.title).join(" | ")} | Δ best blend − examples [95% CI] |`,
            `|${"---|".repeat(columns.length + 2)}`,
        );
        for (const k of K_VALUES) {
            const cells = columns.map((column) => {
                const values = kitValues(column.method, k);
                return values.size ? percent(mean([...values.values()])) : "–";
            });
            let delta = "n/a";
            if (k !== 0) {
                const examples = kitValues("examples", k);
                const candidates = blendMethods.map((method) => {
                    const blended = kitValues(method, k);
                    const differences = [...blended]
                        .filter(([kit]) => examples.has(kit))
                        .map(([kit, value]) => value - examples.get(kit)!);
                    return { differences, average: mean(blended.size ? [...blended.values()] : [0]) };
                });
                const best = candidates.reduce((a, b) => (b.average > a.average ? b : a));
                if (best.differences.length) {
                    const [low, high] = bootstrapInterval(best.differences);
                    delta = `${signedPercent(mean(best.differences))} [${signedPercent(low)}, ${signedPercent(high)}]`;
                }
            }
            lines.push(`| ${k} | ${[...cells, delta].join(" | ")} |`);
        }
        lines.push(``);
    }
    return lines;
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
