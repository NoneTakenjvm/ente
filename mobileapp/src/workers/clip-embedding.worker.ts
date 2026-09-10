/// <reference lib="webworker" />

/**
 * MobileCLIP-S2 image embeddings off the main thread (Transformers.js).
 *
 * Loads the vision tower only (`CLIPVisionModelWithProjection`) — S2 is a
 * FastViT, not ViT-B/16, so we use `image_embeds` rather than mean-pooled
 * patch tokens. WASM fp32 is loaded first so a failed WebGPU session cannot
 * poison Transformers.js `wasmInitPromise`. WebGPU fp32 is an upgrade after
 * that. Xenova pins vision to fp32 — quantized weights are skipped.
 * Batched ORT forwards are attempted; a failed batch permanently falls back
 * to one image at a time so the scan still completes.
 */
import { kitTileGrid } from "@/lib/kit-tile-layout";
import type {
    ClipEmbeddingBatchMode,
    ClipEmbeddingDevice,
    ClipEmbeddingDtype,
    ClipEmbeddingEmbedBatchDoneMessage,
    ClipEmbeddingEmbedBatchMessage,
    ClipEmbeddingEmbedDoneMessage,
    ClipEmbeddingEmbedMessage,
    ClipEmbeddingEmbedTilesDoneMessage,
    ClipEmbeddingEmbedTilesMessage,
    ClipEmbeddingInbound,
    ClipEmbeddingInitDoneMessage,
    ClipEmbeddingTileTiming,
} from "@/workers/clip-embedding-worker-types";

const MODEL_ID = "Xenova/mobileclip_s2";
const EMBEDDING_DIMS = 512;
/** Processor `crop_size` — tiles are drawn straight into this square. */
const TILE_INPUT_SIZE = 256;
/** Processor `rescale_factor`; `do_normalize` is false for this model. */
const PIXEL_RESCALE = 1 / 255;
/** Xenova config pins `vision_model` to fp32; quantized S2 is unreliable. */
const SESSION_DTYPE: ClipEmbeddingDtype = "fp32";

type EmbedTensor = {
    data: Float32Array | number[];
    dims: number[];
};

type VisionModel = (inputs: unknown) => Promise<{
    image_embeds?: EmbedTensor;
}>;

type ImageProcessor = (images: unknown) => Promise<{ pixel_values: unknown }>;

let processor: ImageProcessor | undefined;
let visionModel: VisionModel | undefined;
let activeDevice: ClipEmbeddingDevice | undefined;
let activeDtype: ClipEmbeddingDtype | undefined;
let webGpuSkipReason: string | undefined;
/** False after the first batched forward throws. */
let batchSupported = true;
let batchFallbackReason: string | undefined;
/** One ORT session at a time. */
let embedChain: Promise<void> = Promise.resolve();

const canUseWebGpu = async (): Promise<boolean> => {
    const gpu = (
        self.navigator as Navigator & {
            gpu?: { requestAdapter: () => Promise<unknown> };
        }
    ).gpu;
    if (!gpu) {
        webGpuSkipReason =
            "navigator.gpu missing in worker (use Chrome/Edge, check chrome://gpu)";
        return false;
    }
    try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
            webGpuSkipReason =
                "no WebGPU adapter (GPU blocked or disabled in chrome://flags)";
            return false;
        }
        return true;
    } catch (error) {
        webGpuSkipReason = formatUnknownError(error);
        return false;
    }
};

const formatUnknownError = (error: unknown): string => {
    if (typeof error === "number") {
        return `ORT wasm abort pointer ${error} (failed InferenceSession.create)`;
    }
    if (error instanceof Error) {
        const extra = (error as Error & { code?: unknown }).code;
        const cause = (error as Error & { cause?: unknown }).cause;
        const parts = [error.message];
        if (extra !== undefined) {
            parts.push(`code ${String(extra)}`);
        }
        if (cause !== undefined) {
            parts.push(`cause ${formatUnknownError(cause)}`);
        }
        return parts.join(" — ");
    }
    if (typeof error === "object" && error !== null) {
        const row = error as Record<string, unknown>;
        const parts = [row.message, row.error, row.reason, row.code]
            .filter((value) => value !== undefined && value !== "")
            .map(String);
        if (parts.length > 0) {
            return parts.join(" — ");
        }
        try {
            return JSON.stringify(error);
        } catch {
            return Object.prototype.toString.call(error);
        }
    }
    return String(error);
};

const resetSession = async (): Promise<void> => {
    const previous = visionModel as
        { dispose?: () => Promise<unknown> } | undefined;
    processor = undefined;
    visionModel = undefined;
    try {
        await previous?.dispose?.();
    } catch {
        // Ignore dispose failures between backend attempts.
    }
};

const applyWasmThreadLimit = async (): Promise<void> => {
    const { env } = await import("@huggingface/transformers");
    const cores =
        typeof navigator !== "undefined" ?
            navigator.hardwareConcurrency || 2 :
            2;
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
        wasm.numThreads = Math.min(4, Math.max(1, cores));
    }
};

const loadVisionSession = async (
    device: ClipEmbeddingDevice,
    dtype: ClipEmbeddingDtype,
): Promise<void> => {
    if (device === "wasm") {
        await applyWasmThreadLimit();
    }
    const { AutoProcessor, CLIPVisionModelWithProjection } = await import(
        "@huggingface/transformers"
    );
    const nextProcessor = (await AutoProcessor.from_pretrained(
        MODEL_ID,
        {},
    )) as unknown as ImageProcessor;
    const nextModel = (await CLIPVisionModelWithProjection.from_pretrained(
        MODEL_ID,
        { device, dtype },
    )) as unknown as VisionModel;
    processor = nextProcessor;
    visionModel = nextModel;
    activeDevice = device;
    activeDtype = dtype;
};

const getSession = async (): Promise<void> => {
    if (processor && visionModel) {
        return;
    }

    // Transformers.js caches the first InferenceSession.create as
    // wasmInitPromise. A rejected WebGPU create poisons every later attempt
    // (including WASM) with the same numeric abort. Initialize WASM fp32 first.
    await loadVisionSession("wasm", SESSION_DTYPE);
    console.warn(
        `[clip-embedding.worker] ${MODEL_ID} ready device=wasm dtype=${SESSION_DTYPE}`,
    );

    if (!(await canUseWebGpu())) {
        return;
    }

    try {
        await resetSession();
        await loadVisionSession("webgpu", SESSION_DTYPE);
        webGpuSkipReason = undefined;
        console.warn(
            `[clip-embedding.worker] ${MODEL_ID} ready device=webgpu dtype=${SESSION_DTYPE}`,
        );
    } catch (error) {
        webGpuSkipReason = formatUnknownError(error);
        console.warn(
            `[clip-embedding.worker] WebGPU ${SESSION_DTYPE} failed after WASM init: ${webGpuSkipReason}`,
            error,
        );
        await resetSession();
        await loadVisionSession("wasm", SESSION_DTYPE);
        console.warn(
            `[clip-embedding.worker] ${MODEL_ID} restored device=wasm dtype=${SESSION_DTYPE}`,
        );
    }
};

const l2NormalizeEmbedding = (
    data: Float32Array | number[],
): number[] | undefined => {
    let norm = 0;
    for (const value of data) {
        norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) {
        return undefined;
    }
    const out: number[] = [];
    for (const value of data) {
        out.push(Math.round((value / norm) * 1e5) / 1e5);
    }
    return out;
};

const vectorsFromImageEmbeds = (
    embeds: EmbedTensor | undefined,
    batchSize: number,
): Array<number[] | undefined> => {
    if (!embeds?.data) {
        return Array.from({ length: batchSize }, () => undefined);
    }
    const flat =
        embeds.data instanceof Float32Array ?
            embeds.data :
            Float32Array.from(embeds.data);
    const dims = embeds.dims ?? [];
    const out: Array<number[] | undefined> = [];
    if (dims.length === 2 && dims[1] === EMBEDDING_DIMS) {
        const rows = Math.min(batchSize, dims[0]!);
        for (let i = 0; i < rows; i++) {
            out.push(
                l2NormalizeEmbedding(
                    flat.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
                ),
            );
        }
        while (out.length < batchSize) {
            out.push(undefined);
        }
        return out;
    }
    if (flat.length === batchSize * EMBEDDING_DIMS) {
        for (let i = 0; i < batchSize; i++) {
            out.push(
                l2NormalizeEmbedding(
                    flat.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
                ),
            );
        }
        return out;
    }
    if (flat.length === EMBEDDING_DIMS && batchSize === 1) {
        return [l2NormalizeEmbedding(flat)];
    }
    return Array.from({ length: batchSize }, () => undefined);
};

const embedOneVision = async (image: unknown): Promise<number[] | undefined> => {
    const inputs = await processor!(image);
    const output = await visionModel!(inputs);
    return vectorsFromImageEmbeds(output.image_embeds, 1)[0];
};

const embedSequential = async (
    images: unknown[],
): Promise<Array<number[] | undefined>> => {
    const out: Array<number[] | undefined> = [];
    for (const image of images) {
        try {
            out.push(await embedOneVision(image));
        } catch {
            out.push(undefined);
        }
    }
    return out;
};

const embedImages = async (
    images: unknown[],
): Promise<{
    vectors: Array<number[] | undefined>;
    batchMode: ClipEmbeddingBatchMode;
}> => {
    await getSession();
    if (images.length <= 1 || !batchSupported) {
        return {
            vectors: await embedSequential(images),
            batchMode: "sequential",
        };
    }
    try {
        const inputs = await processor!(images);
        const output = await visionModel!(inputs);
        const vectors = vectorsFromImageEmbeds(
            output.image_embeds,
            images.length,
        );
        if (vectors.every((vector) => vector === undefined)) {
            throw new Error("batched forward returned no 512-d image_embeds");
        }
        return { vectors, batchMode: "batched" };
    } catch (error) {
        batchSupported = false;
        batchFallbackReason = formatUnknownError(error);
        console.warn(
            `[clip-embedding.worker] batched forward failed; sequential from now on: ${batchFallbackReason}`,
            error,
        );
        return {
            vectors: await embedSequential(images),
            batchMode: "sequential",
        };
    }
};

const jpegBlob = (bytes: Uint8Array): Blob => {
    const standalone =
        bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength ?
            bytes :
            bytes.slice();
    return new Blob([standalone.buffer as ArrayBuffer], { type: "image/jpeg" });
};

const bytesToRawImage = async (bytes: Uint8Array): Promise<unknown> => {
    const { RawImage } = await import("@huggingface/transformers");
    return RawImage.fromBlob(jpegBlob(bytes));
};

/** Run `task` after every earlier ORT call has finished (one session at a time). */
const runSerialised = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        embedChain = embedChain
            .then(async () => {
                try {
                    resolve(await task());
                } catch (error) {
                    reject(error);
                }
            })
            .catch(() => {
                // Keep the chain alive after a rejected batch.
            });
    });

const embedBatchBytes = async (
    items: Array<{ fileId: number; bytes: Uint8Array }>,
): Promise<{
    results: Array<{ fileId: number; vector?: number[] }>;
    batchMode: ClipEmbeddingBatchMode;
}> => {
    if (items.length === 0) {
        return { results: [], batchMode: "sequential" };
    }
    const images = await Promise.all(
        items.map((item) => bytesToRawImage(item.bytes)),
    );
    const output = await runSerialised(() => embedImages(images));
    return {
        batchMode: output.batchMode,
        results: items.map((item, index) => ({
            fileId: item.fileId,
            vector: output.vectors[index],
        })),
    };
};

const handleInit = async (id: number): Promise<void> => {
    try {
        await getSession();
        const done: ClipEmbeddingInitDoneMessage = {
            kind: "init-done",
            id,
            device: activeDevice ?? "wasm",
            dtype: activeDtype,
            modelId: MODEL_ID,
            webGpuSkipReason,
        };
        self.postMessage(done);
    } catch (error) {
        await resetSession();
        activeDevice = undefined;
        activeDtype = undefined;
        const done: ClipEmbeddingInitDoneMessage = {
            kind: "init-done",
            id,
            device: "wasm",
            modelId: MODEL_ID,
            webGpuSkipReason,
            error: formatUnknownError(error),
        };
        self.postMessage(done);
    }
};

const handleEmbed = (message: ClipEmbeddingEmbedMessage): void => {
    void (async () => {
        const done: ClipEmbeddingEmbedDoneMessage = {
            kind: "embed-done",
            id: message.id,
            fileId: message.fileId,
        };
        try {
            const { results } = await embedBatchBytes([
                { fileId: message.fileId, bytes: message.bytes },
            ]);
            done.vector = results[0]?.vector;
        } catch (error) {
            done.error =
                error instanceof Error ? error.message : "embed failed";
        }
        self.postMessage(done);
    })();
};

const handleEmbedBatch = (message: ClipEmbeddingEmbedBatchMessage): void => {
    void (async () => {
        const done: ClipEmbeddingEmbedBatchDoneMessage = {
            kind: "embed-batch-done",
            id: message.id,
            results: message.items.map((item) => ({ fileId: item.fileId })),
        };
        try {
            const { results, batchMode } = await embedBatchBytes(
                message.items,
            );
            done.results = results;
            done.batchMode = batchMode;
            if (batchMode === "sequential" && batchFallbackReason) {
                done.batchFallbackReason = batchFallbackReason;
            }
        } catch (error) {
            done.error =
                error instanceof Error ? error.message : "embed-batch failed";
        }
        self.postMessage(done);
    })();
};

type TilePixelValues = {
    rows: number;
    columns: number;
    count: number;
    /** NCHW `count × 3 × 256 × 256`, already rescaled to `[0, 1]`. */
    pixelValues: Float32Array;
};

/**
 * Decode once, then per {@link kitTileGrid} tile: one scaled `drawImage` into
 * a 256×256 canvas and one pass writing the RGB planes into a packed NCHW
 * tensor. Same maths as the Transformers.js processor for this model (canvas
 * resample, ×1/255, no normalisation) without its per-tile full-image canvas
 * copies and intermediate arrays.
 */
const tilePixelValues = async (bytes: Uint8Array): Promise<TilePixelValues> => {
    const bitmap = await createImageBitmap(jpegBlob(bytes));
    try {
        const grid = kitTileGrid(bitmap.width, bitmap.height);
        const context = new OffscreenCanvas(
            TILE_INPUT_SIZE,
            TILE_INPUT_SIZE,
        ).getContext("2d", { willReadFrequently: true });
        if (!context) {
            throw new Error("OffscreenCanvas 2d context unavailable");
        }
        const plane = TILE_INPUT_SIZE * TILE_INPUT_SIZE;
        const pixelValues = new Float32Array(grid.rects.length * 3 * plane);
        grid.rects.forEach(({ x, y, size }, index) => {
            context.drawImage(
                bitmap,
                x,
                y,
                size,
                size,
                0,
                0,
                TILE_INPUT_SIZE,
                TILE_INPUT_SIZE,
            );
            const rgba = context.getImageData(
                0,
                0,
                TILE_INPUT_SIZE,
                TILE_INPUT_SIZE,
            ).data;
            const red = index * 3 * plane;
            const green = red + plane;
            const blue = green + plane;
            for (let p = 0, s = 0; p < plane; p += 1, s += 4) {
                pixelValues[red + p] = rgba[s]! * PIXEL_RESCALE;
                pixelValues[green + p] = rgba[s + 1]! * PIXEL_RESCALE;
                pixelValues[blue + p] = rgba[s + 2]! * PIXEL_RESCALE;
            }
        });
        return {
            rows: grid.rows,
            columns: grid.columns,
            count: grid.rects.length,
            pixelValues,
        };
    } finally {
        bitmap.close();
    }
};

/**
 * Embed every tile of one thumbnail as a single forward. Preprocessing runs
 * outside the ORT queue so the next photo's tiles are prepared while the GPU
 * works on this one. Any tile without a vector fails the whole photo — a
 * partial grid would silently bias max-over-tiles scoring.
 */
const embedTilesBytes = async (
    bytes: Uint8Array,
): Promise<{
    rows: number;
    columns: number;
    vectors: Float32Array;
    timing: ClipEmbeddingTileTiming;
}> => {
    await getSession();
    const preprocessStart = performance.now();
    const { rows, columns, count, pixelValues } = await tilePixelValues(bytes);
    const { Tensor } = await import("@huggingface/transformers");
    const inputs = {
        pixel_values: new Tensor("float32", pixelValues, [
            count,
            3,
            TILE_INPUT_SIZE,
            TILE_INPUT_SIZE,
        ]),
    };
    const preprocessMs = performance.now() - preprocessStart;
    let forwardMs = 0;
    const output = await runSerialised(async () => {
        const forwardStart = performance.now();
        const result = await visionModel!(inputs);
        forwardMs = performance.now() - forwardStart;
        return result;
    });
    const vectors = vectorsFromImageEmbeds(output.image_embeds, count);
    const packed = new Float32Array(count * EMBEDDING_DIMS);
    vectors.forEach((vector, index) => {
        if (vector?.length !== EMBEDDING_DIMS) {
            throw new Error(`tile ${index} returned no 512-d image_embeds`);
        }
        packed.set(vector, index * EMBEDDING_DIMS);
    });
    return {
        rows,
        columns,
        vectors: packed,
        timing: { preprocessMs, forwardMs },
    };
};

const handleEmbedTiles = (message: ClipEmbeddingEmbedTilesMessage): void => {
    void (async () => {
        const done: ClipEmbeddingEmbedTilesDoneMessage = {
            kind: "embed-tiles-done",
            id: message.id,
            fileId: message.fileId,
            rows: 0,
            columns: 0,
        };
        try {
            const { rows, columns, vectors, timing } = await embedTilesBytes(
                message.bytes,
            );
            done.rows = rows;
            done.columns = columns;
            done.vectors = vectors;
            done.timing = timing;
            self.postMessage(done, [vectors.buffer]);
            return;
        } catch (error) {
            done.error =
                error instanceof Error ? error.message : "embed-tiles failed";
        }
        self.postMessage(done);
    })();
};

self.onmessage = (event: MessageEvent<ClipEmbeddingInbound>): void => {
    const message = event.data;
    if (message.kind === "init") {
        void handleInit(message.id).catch((error) => {
            console.warn("[clip-embedding.worker] init failed", error);
        });
        return;
    }
    if (message.kind === "embed") {
        handleEmbed(message);
        return;
    }
    if (message.kind === "embed-batch") {
        handleEmbedBatch(message);
        return;
    }
    if (message.kind === "embed-tiles") {
        handleEmbedTiles(message);
    }
};
