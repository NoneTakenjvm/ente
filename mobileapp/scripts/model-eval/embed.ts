/**
 * Embed a model-eval dataset with MobileCLIP-S2 (the app's model) or DINOv3
 * small, from simulated Ente thumbnails. Research only; not app code.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/embed.ts <mobileclip-s2|mobileclip2-s2|siglip2-b16-256|dinov3-s> <dataset> [--limit N] [--device cpu|dml]
 *
 * Writes `<root>/vectors/<model>/<dataset>.{f32,ids.json,meta.json}` and caches
 * thumbnails in `<root>/<dataset>/thumbs720/<id>.jpg`.
 *
 * Both models load Transformers.js through the `transformers-eval` alias
 * (3.8.x, which has DINOv3); the app itself stays on 3.5.1.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    KIT_EMBEDDING_MODEL_ID,
    l2NormalizeEmbedding,
} from "@/lib/embedding-vector";
import { modelEvalDataRoot, readManifest } from "./manifest";

export type Transformers = typeof import("transformers-eval");

export type ModelName = "mobileclip-s2" | "mobileclip2-s2" | "siglip2-b16-256" | "dinov3-s";

export const modelNames: ModelName[] = ["mobileclip-s2", "mobileclip2-s2", "siglip2-b16-256", "dinov3-s"];

export type EmbedDevice = "cpu" | "dml";

export type Embedder = {
    repo: string;
    /** Plain-text description of what the processor does to each image. */
    preprocessing: string;
    /** Model output the vector is taken from; known after the first embed. */
    outputKey: () => string;
    /** One L2-normalised vector per JPEG. */
    embed: (jpegs: Uint8Array[]) => Promise<Float32Array[]>;
};

type Tensor = { data: Float32Array; dims: number[] };
type Callable<T> = (input: unknown) => Promise<T>;

const dinov3Repo = "onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX";
export const siglip2Repo = "onnx-community/siglip2-base-patch16-256-ONNX";
const mobileclip2Repo = "plhery/mobileclip2-onnx";
const mobileclip2LocalFiles = [
    "config.json",
    "preprocessor_config.json",
    "onnx/vision_model.onnx",
    "onnx/text_model.onnx",
];
const batchSize = 8;

/** Ente's thumbnail limits, from web/packages/gallery/services/upload/thumbnail.ts. */
const maxThumbnailDimension = 720;
const maxThumbnailSize = 100 * 1024;

const processorConfigKeys = [
    "do_resize",
    "size",
    "resample",
    "do_center_crop",
    "crop_size",
    "do_rescale",
    "rescale_factor",
    "do_normalize",
    "image_mean",
    "image_std",
];

/**
 * Mimic Ente's web thumbnail: draw to a canvas scaled so both sides fit
 * 720 px (like `scaledImageDimensions`, this also scales small images up), then
 * JPEG at quality 0.7, stepping down to 0.5 while over 100 KB and still
 * shrinking by 10% or more per step.
 *
 * [Note: EXIF orientation is whatever @napi-rs/canvas applies on decode; the
 * browser's `Image` applies it, so rotated phone photos may differ.]
 */
export const makeThumbnail = async (original: Uint8Array): Promise<Buffer> => {
    const image = await loadImage(Buffer.from(original));
    const scale = Math.min(
        maxThumbnailDimension / image.width,
        maxThumbnailDimension / image.height,
    );
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);

    let jpeg = canvas.toBuffer("image/jpeg", 70);
    for (const quality of [60, 50]) {
        const previousSize = jpeg.length;
        if (jpeg.length <= maxThumbnailSize) {
            break;
        }
        jpeg = canvas.toBuffer("image/jpeg", quality);
        if (((previousSize - jpeg.length) * 100) / previousSize < 10) {
            break;
        }
    }
    return jpeg;
};

/**
 * Download the `onnx/s2/` files of the community MobileCLIP2-S2 export once into
 * `<root>/models/mobileclip2-s2/` (laid out as a normal Transformers.js model
 * dir), point `env.localModelPath` at `<root>/models`, and return the model id
 * to load: "mobileclip2-s2". Both towers load from it with
 * `model_file_name: "vision_model" | "text_model"`.
 */
export const prepareMobileClip2 = async (lib: Transformers): Promise<string> => {
    const directory = join(modelEvalDataRoot(), "models", "mobileclip2-s2");
    for (const file of mobileclip2LocalFiles) {
        const path = join(directory, file);
        if (existsSync(path)) {
            continue;
        }
        const url = `https://huggingface.co/${mobileclip2Repo}/resolve/main/onnx/s2/${file.split("/").pop()}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`${url}: HTTP ${response.status}`);
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    lib.env.localModelPath = join(modelEvalDataRoot(), "models");
    return "mobileclip2-s2";
};

/**
 * Load a model through the given Transformers.js build, fp32. The app worker
 * uses WASM or WebGPU; in Node the ONNX runtime offers `cpu`, or `dml`
 * (DirectML, the Windows GPU).
 */
export const loadEmbedder = async (
    model: ModelName,
    lib: Transformers,
    device: EmbedDevice = "cpu",
): Promise<Embedder> => {
    const options = { device, dtype: "fp32" } as const;
    // Per model: id to load, recorded repo, output key, and whether the vector
    // is normalised like the app does (rounded to 1e-5).
    const spec = {
        "mobileclip-s2": { id: KIT_EMBEDDING_MODEL_ID, repo: KIT_EMBEDDING_MODEL_ID, key: "image_embeds", appNormalize: true },
        "mobileclip2-s2": { id: "mobileclip2-s2", repo: `${mobileclip2Repo} (onnx/s2)`, key: "image_embeds", appNormalize: false },
        "siglip2-b16-256": { id: siglip2Repo, repo: siglip2Repo, key: "pooler_output", appNormalize: false },
        "dinov3-s": { id: dinov3Repo, repo: dinov3Repo, key: "pooler_output", appNormalize: false },
    }[model];
    const { id, repo, key } = spec;
    if (model === "mobileclip2-s2") {
        await prepareMobileClip2(lib);
    }
    const processor = (await (model === "dinov3-s"
        ? lib.AutoImageProcessor.from_pretrained(id)
        : lib.AutoProcessor.from_pretrained(id))) as unknown as Callable<
        Record<string, unknown>
    > & { config?: Record<string, unknown>; image_processor?: { config: Record<string, unknown> } };
    // mobileclip-s2 mirrors src/workers/clip-embedding.worker.ts (CLIPVisionModelWithProjection, image_embeds).
    const loadNetwork = (): Promise<unknown> => {
        switch (model) {
            case "mobileclip-s2":
                return lib.CLIPVisionModelWithProjection.from_pretrained(id, options);
            case "mobileclip2-s2":
                return lib.CLIPVisionModelWithProjection.from_pretrained(id, { ...options, model_file_name: "vision_model" });
            case "siglip2-b16-256":
                return lib.SiglipVisionModel.from_pretrained(id, { ...options, model_file_name: "vision_model" });
            case "dinov3-s":
                return lib.AutoModel.from_pretrained(id, options);
        }
    };
    const network = (await loadNetwork()) as Callable<Record<string, Tensor | undefined>>;

    const config = processor.image_processor?.config ?? processor.config ?? {};
    const preprocessing = JSON.stringify(
        Object.fromEntries(
            processorConfigKeys.flatMap((key) =>
                key in config ? [[key, config[key]]] : [],
            ),
        ),
    );
    let outputKey = "";

    const embed = async (jpegs: Uint8Array[]): Promise<Float32Array[]> => {
        // The worker decodes thumbnail bytes the same way: RawImage.fromBlob.
        const images = await Promise.all(
            jpegs.map((jpeg) =>
                lib.RawImage.fromBlob(
                    new Blob([Buffer.from(jpeg)], { type: "image/jpeg" }),
                ),
            ),
        );
        const output = await network(await processor(images));
        const rows = rowsOf(output, key, model === "dinov3-s");
        outputKey = rows.key;
        return rows.vectors.map((row) => {
            const vector = spec.appNormalize ? l2NormalizeEmbedding(row) : l2Normalize(row);
            if (!vector) {
                throw new Error("Model returned a zero or non-finite vector");
            }
            return vector;
        });
    };

    return { repo, preprocessing, outputKey: () => outputKey, embed };
};

/** Raw (unnormalised) rows of the output tensor the vector is read from. */
const rowsOf = (
    output: Record<string, Tensor | undefined>,
    key: string,
    allowClsFallback: boolean,
): { key: string; vectors: Float32Array[] } => {
    const tensor = output[key];
    if (tensor) {
        const [count, dims] = tensor.dims as [number, number];
        return {
            key,
            vectors: Array.from({ length: count }, (_, index) =>
                tensor.data.subarray(index * dims, (index + 1) * dims),
            ),
        };
    }
    // No pooler_output: CLS token (first row) of last_hidden_state.
    const hidden = output.last_hidden_state;
    if (!allowClsFallback || !hidden) {
        throw new Error(`Model output has no ${key}`);
    }
    const [count, tokens, dims] = hidden.dims as [number, number, number];
    return {
        key: "last_hidden_state[CLS]",
        vectors: Array.from({ length: count }, (_, index) =>
            hidden.data.subarray(index * tokens * dims, index * tokens * dims + dims),
        ),
    };
};

const l2Normalize = (row: Float32Array): Float32Array | undefined => {
    const norm = Math.sqrt(row.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 && Number.isFinite(norm)
        ? row.map((value) => value / norm)
        : undefined;
};

/** Commit the model repo's `main` resolves to, or "unknown" when offline. */
const resolveRevision = async (repo: string): Promise<string> => {
    try {
        const response = await fetch(`https://huggingface.co/api/models/${repo}`);
        return ((await response.json()) as { sha?: string }).sha ?? "unknown";
    } catch {
        return "unknown";
    }
};

/** Version of the `transformers-eval` alias installed in node_modules. */
const aliasVersion = (): string =>
    (
        JSON.parse(
            readFileSync(
                join(process.cwd(), "node_modules/transformers-eval/package.json"),
                "utf8",
            ),
        ) as { version: string }
    ).version;

const main = async (): Promise<void> => {
    const [modelArg, dataset, ...rest] = process.argv.slice(2);
    const limitIndex = rest.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
    const deviceIndex = rest.indexOf("--device");
    const device = deviceIndex >= 0 ? rest[deviceIndex + 1] : "cpu";
    const model = modelNames.find((name) => name === modelArg);
    if (!model || !dataset || !(limit > 0) || (device !== "cpu" && device !== "dml")) {
        throw new Error(`Usage: embed.ts <${modelNames.join("|")}> <dataset> [--limit N] [--device cpu|dml]`);
    }
    const root = modelEvalDataRoot();
    const images = readManifest(dataset).images.slice(0, limit);

    const thumbDir = join(root, dataset, "thumbs720");
    mkdirSync(thumbDir, { recursive: true });
    const thumbPath = (id: string): string => join(thumbDir, `${id}.jpg`);
    for (const [index, image] of images.entries()) {
        if (!existsSync(thumbPath(image.id))) {
            const original = readFileSync(join(root, dataset, image.file));
            mkdirSync(dirname(thumbPath(image.id)), { recursive: true });
            writeFileSync(thumbPath(image.id), await makeThumbnail(original));
        }
        if ((index + 1) % 500 === 0) {
            console.log(`thumbnails ${index + 1}/${images.length}`);
        }
    }

    const lib: Transformers = await import("transformers-eval");
    const embedder = await loadEmbedder(model, lib, device);
    let dims = 0;
    let buffer = new Float32Array(0);
    const start = performance.now();
    for (let first = 0; first < images.length; first += batchSize) {
        const batch = images.slice(first, first + batchSize);
        const vectors = await embedder.embed(
            batch.map((image) => readFileSync(thumbPath(image.id))),
        );
        if (dims === 0) {
            dims = vectors[0]!.length;
            buffer = new Float32Array(images.length * dims);
        }
        for (const [offset, vector] of vectors.entries()) {
            buffer.set(vector, (first + offset) * dims);
        }
        const done = first + batch.length;
        if (Math.floor(first / 200) !== Math.floor(done / 200)) {
            console.log(
                `embedded ${done}/${images.length} (${((performance.now() - start) / done).toFixed(1)} ms/image)`,
            );
        }
    }
    const msPerImage = (performance.now() - start) / images.length;

    const outDir = join(root, "vectors", model);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${dataset}.f32`), new Uint8Array(buffer.buffer));
    writeFileSync(
        join(outDir, `${dataset}.ids.json`),
        JSON.stringify(images.map((image) => image.id)),
    );
    writeFileSync(
        join(outDir, `${dataset}.meta.json`),
        JSON.stringify(
            {
                model,
                repo: embedder.repo,
                revision: await resolveRevision(embedder.repo),
                dims,
                preprocessing: `Input: Ente-style JPEG thumbnail (longest side 720, quality 0.7 down to 0.5). Processor config: ${embedder.preprocessing}. Vector: ${embedder.outputKey()}, L2-normalised.`,
                dtype: "fp32",
                device,
                transformersVersion: aliasVersion(),
                images: images.length,
                msPerImage,
            },
            null,
            2,
        ),
    );
    console.log(`${model} ${dataset}: ${images.length} images, ${msPerImage.toFixed(1)} ms/image`);
};

// Only run as a CLI, not when embed-check.ts imports the helpers above.
if (/[\\/]embed\.ts$/.test(process.argv[1] ?? "")) {
    main().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    });
}
