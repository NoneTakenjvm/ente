/// <reference lib="webworker" />

/**
 * MobileCLIP2-S2 image embeddings off the main thread (Transformers.js).
 *
 * Loads the vision tower only (`CLIPVisionModelWithProjection`) — S2 is a
 * FastViT, not ViT-B/16, so we use `image_embeds` rather than mean-pooled
 * patch tokens. WASM fp32 is loaded first so a failed WebGPU session cannot
 * poison Transformers.js `wasmInitPromise`. WebGPU fp32 is an upgrade after
 * that. The export ships fp32 weights only.
 * Batched ORT forwards are attempted; a failed batch permanently falls back
 * to one image at a time so the scan still completes.
 */
import {
    KIT_EMBEDDING_DIMS,
    KIT_EMBEDDING_MODEL_ID,
    l2NormalizeEmbedding,
} from "@/lib/embedding-vector";
import type {
    ClipEmbeddingBatchMode,
    ClipEmbeddingDevice,
    ClipEmbeddingDtype,
    ClipEmbeddingEmbedBatchDoneMessage,
    ClipEmbeddingEmbedBatchMessage,
    ClipEmbeddingEmbedTextDoneMessage,
    ClipEmbeddingEmbedTextMessage,
    ClipEmbeddingInbound,
    ClipEmbeddingInitDoneMessage,
    ClipEmbeddingWarmTextDoneMessage,
} from "@/workers/clip-embedding-worker-types";
import { errorMessage } from "@/lib/format";

/** The pinned export ships fp32 weights only (vision 143 MB). */
const SESSION_DTYPE: ClipEmbeddingDtype = "fp32";

/** fp32 only too: 254 MB, until an int8 text tower is hosted. */
const TEXT_DTYPE = "fp32";

/**
 * Third-party Transformers.js export of MobileCLIP2-S2, pinned to a commit so
 * the weights behind the persisted index cannot change. S2 lives in `onnx/s2`.
 */
const MODEL_FILES = {
    revision: "ba95759a5bdbaca53e9111e2550a76ec09c8fd9e",
    subfolder: "onnx/s2",
};

/** The export ships no tokenizer; MobileCLIP2 keeps MobileCLIP's CLIP BPE. */
const TOKENIZER_ID = "Xenova/mobileclip_s2";

/** Pinned like {@link MODEL_FILES}: tokenizer changes would shift text vectors. */
const TOKENIZER_REVISION = "0c311c620b36a2270b851db7bef9135f3eaae5d7";

type EmbedTensor = {
    data: Float32Array | number[];
    dims: number[];
};

type VisionModel = (inputs: unknown) => Promise<{
    image_embeds?: EmbedTensor;
}>;

type ImageProcessor = (images: unknown) => Promise<{ pixel_values: unknown }>;

type TextTokenizer = (
    texts: string[],
    options: { padding: "max_length"; truncation: boolean },
) => unknown;

type TextModel = (inputs: unknown) => Promise<{
    text_embeds?: EmbedTensor;
}>;

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

/**
 * Point ORT at the copies in `public/ort` (no CDN fetch of code that sees
 * decrypted photos) and cap wasm threads. Runs before every session load.
 */
const configureOrt = async (): Promise<void> => {
    const { env } = await import("@huggingface/transformers");
    const cores =
        typeof navigator !== "undefined" ?
            navigator.hardwareConcurrency || 2 :
            2;
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
        wasm.wasmPaths = "/ort/";
        wasm.numThreads = Math.min(4, Math.max(1, cores));
    }
};

const loadVisionSession = async (
    device: ClipEmbeddingDevice,
    dtype: ClipEmbeddingDtype,
): Promise<void> => {
    await configureOrt();
    const { AutoProcessor, CLIPVisionModelWithProjection } = await import(
        "@huggingface/transformers"
    );
    const nextProcessor = (await AutoProcessor.from_pretrained(
        KIT_EMBEDDING_MODEL_ID,
        { revision: MODEL_FILES.revision },
    )) as unknown as ImageProcessor;
    const nextModel = (await CLIPVisionModelWithProjection.from_pretrained(
        KIT_EMBEDDING_MODEL_ID,
        { ...MODEL_FILES, device, dtype },
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
        `[clip-embedding.worker] ${KIT_EMBEDDING_MODEL_ID} ready device=wasm dtype=${SESSION_DTYPE}`,
    );

    if (!(await canUseWebGpu())) {
        return;
    }

    try {
        await resetSession();
        await loadVisionSession("webgpu", SESSION_DTYPE);
        webGpuSkipReason = undefined;
        console.warn(
            `[clip-embedding.worker] ${KIT_EMBEDDING_MODEL_ID} ready device=webgpu dtype=${SESSION_DTYPE}`,
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
            `[clip-embedding.worker] ${KIT_EMBEDDING_MODEL_ID} restored device=wasm dtype=${SESSION_DTYPE}`,
        );
    }
};

const vectorsFromImageEmbeds = (
    embeds: EmbedTensor | undefined,
    batchSize: number,
): Array<Float32Array | undefined> => {
    if (!embeds?.data) {
        return Array.from({ length: batchSize }, () => undefined);
    }
    const flat =
        embeds.data instanceof Float32Array ?
            embeds.data :
            Float32Array.from(embeds.data);
    const dims = embeds.dims ?? [];
    const out: Array<Float32Array | undefined> = [];
    if (dims.length === 2 && dims[1] === KIT_EMBEDDING_DIMS) {
        const rows = Math.min(batchSize, dims[0]!);
        for (let i = 0; i < rows; i++) {
            out.push(
                l2NormalizeEmbedding(
                    flat.subarray(i * KIT_EMBEDDING_DIMS, (i + 1) * KIT_EMBEDDING_DIMS),
                ),
            );
        }
        while (out.length < batchSize) {
            out.push(undefined);
        }
        return out;
    }
    if (flat.length === batchSize * KIT_EMBEDDING_DIMS) {
        for (let i = 0; i < batchSize; i++) {
            out.push(
                l2NormalizeEmbedding(
                    flat.subarray(i * KIT_EMBEDDING_DIMS, (i + 1) * KIT_EMBEDDING_DIMS),
                ),
            );
        }
        return out;
    }
    if (flat.length === KIT_EMBEDDING_DIMS && batchSize === 1) {
        return [l2NormalizeEmbedding(flat)];
    }
    return Array.from({ length: batchSize }, () => undefined);
};

const embedOneVision = async (image: unknown): Promise<Float32Array | undefined> => {
    const inputs = await processor!(image);
    const output = await visionModel!(inputs);
    return vectorsFromImageEmbeds(output.image_embeds, 1)[0];
};

const embedSequential = async (
    images: unknown[],
): Promise<Array<Float32Array | undefined>> => {
    const out: Array<Float32Array | undefined> = [];
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
    vectors: Array<Float32Array | undefined>;
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
    results: Array<{ fileId: number; vector?: Float32Array }>;
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

/** Loaded on the first `warm-text` or `embed-text` request; a failed load is retried. */
let textSessionPromise:
    Promise<{ tokenizer: TextTokenizer; model: TextModel }> | undefined;

const loadTextSession = (): Promise<{
    tokenizer: TextTokenizer;
    model: TextModel;
}> => {
    textSessionPromise ??= (async () => {
        await configureOrt();
        const { AutoTokenizer, CLIPTextModelWithProjection } = await import(
            "@huggingface/transformers"
        );
        const tokenizer = (await AutoTokenizer.from_pretrained(
            TOKENIZER_ID,
            { revision: TOKENIZER_REVISION },
        )) as unknown as TextTokenizer;
        const model = (await CLIPTextModelWithProjection.from_pretrained(
            KIT_EMBEDDING_MODEL_ID,
            { ...MODEL_FILES, device: "wasm", dtype: TEXT_DTYPE },
        )) as unknown as TextModel;
        return { tokenizer, model };
    })().catch((error: unknown) => {
        textSessionPromise = undefined;
        throw error;
    });
    return textSessionPromise;
};

const embedText = async (text: string): Promise<Float32Array> => {
    const { tokenizer, model } = await loadTextSession();
    const inputs = tokenizer([text], { padding: "max_length", truncation: true });
    const output = await runSerialised(() => model(inputs));
    const embeds = output.text_embeds;
    if (!embeds?.data || embeds.data.length < KIT_EMBEDDING_DIMS) {
        throw new Error("text forward returned no 512-d text_embeds");
    }
    const row = Float32Array.from(embeds.data.slice(0, KIT_EMBEDDING_DIMS));
    const vector = l2NormalizeEmbedding(row);
    if (!vector) {
        throw new Error("text embedding is zero or non-finite");
    }
    return vector;
};

const handleEmbedText = (message: ClipEmbeddingEmbedTextMessage): void => {
    void (async () => {
        const done: ClipEmbeddingEmbedTextDoneMessage = {
            kind: "embed-text-done",
            id: message.id,
        };
        try {
            done.vector = await embedText(message.text);
        } catch (error) {
            // Never echo the prompt: report the failure class only.
            done.error = errorMessage(error, "embed-text failed");
        }
        self.postMessage(done, done.vector ? [done.vector.buffer as ArrayBuffer] : []);
    })();
};

const handleWarmText = (id: number): void => {
    void (async () => {
        const done: ClipEmbeddingWarmTextDoneMessage = {
            kind: "warm-text-done",
            id,
        };
        try {
            await loadTextSession();
        } catch (error) {
            done.error = errorMessage(error, "warm-text failed");
        }
        self.postMessage(done);
    })();
};

const handleInit = async (id: number): Promise<void> => {
    try {
        await getSession();
        const done: ClipEmbeddingInitDoneMessage = {
            kind: "init-done",
            id,
            device: activeDevice ?? "wasm",
            dtype: activeDtype,
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
            webGpuSkipReason,
            error: formatUnknownError(error),
        };
        self.postMessage(done);
    }
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
                errorMessage(error, "embed-batch failed");
        }
        const vectorBuffers = done.results.flatMap((result) =>
            result.vector ? [result.vector.buffer as ArrayBuffer] : []);
        self.postMessage(done, vectorBuffers);
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
    if (message.kind === "embed-text") {
        handleEmbedText(message);
        return;
    }
    if (message.kind === "warm-text") {
        handleWarmText(message.id);
        return;
    }
    handleEmbedBatch(message);
};
