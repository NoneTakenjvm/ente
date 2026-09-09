/// <reference lib="webworker" />

/**
 * CLIP image embeddings off the main thread (Transformers.js + Xenova ViT-B/16).
 *
 * Prefers WebGPU fp16; falls back to WASM q8. Supports single-image and true
 * multi-image batches (`extractor([img…])` → one ORT run). Batches are
 * serialized so a single session does not OOM.
 */
import type {
    ClipEmbeddingDevice,
    ClipEmbeddingEmbedBatchMessage,
    ClipEmbeddingEmbedMessage,
    ClipEmbeddingInbound,
    ClipEmbeddingInitDoneMessage,
    ClipEmbeddingEmbedDoneMessage,
    ClipEmbeddingEmbedBatchDoneMessage,
} from "@/workers/clip-embedding-worker-types";

const MODEL_ID = "Xenova/clip-vit-base-patch16";
const EMBEDDING_DIMS = 512;
const WEBGPU_DTYPE = "fp16" as const;
const WASM_DTYPE = "q8" as const;

type ImageFeaturePipeline = (
    input: unknown,
    options?: { pooling?: string; normalize?: boolean; pool?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let pipelinePromise: Promise<ImageFeaturePipeline> | undefined;
let activeDevice: ClipEmbeddingDevice | undefined;
let webGpuSkipReason: string | undefined;
/** One ORT batch at a time. */
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
        webGpuSkipReason =
            error instanceof Error ? error.message : "requestAdapter failed";
        return false;
    }
};

const loadPipeline = async (
    device: ClipEmbeddingDevice,
    dtype: typeof WEBGPU_DTYPE | typeof WASM_DTYPE,
): Promise<ImageFeaturePipeline> => {
    const { env, pipeline } = await import("@huggingface/transformers");
    if (device === "wasm") {
        const cores =
            typeof navigator !== "undefined" ?
                navigator.hardwareConcurrency || 2 :
                2;
        const wasm = env.backends?.onnx?.wasm;
        if (wasm) {
            wasm.numThreads = Math.min(4, Math.max(1, cores));
        }
    }
    const extractor = await pipeline("image-feature-extraction", MODEL_ID, {
        dtype,
        device,
    });
    return extractor as unknown as ImageFeaturePipeline;
};

const getExtractor = async (): Promise<ImageFeaturePipeline> => {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            if (await canUseWebGpu()) {
                try {
                    const extractor = await loadPipeline("webgpu", WEBGPU_DTYPE);
                    activeDevice = "webgpu";
                    webGpuSkipReason = undefined;
                    return extractor;
                } catch (error) {
                    const detail =
                        error instanceof Error ? error.message : String(error);
                    webGpuSkipReason = `WebGPU ${WEBGPU_DTYPE}: ${detail}`;
                    console.warn(
                        "[clip-embedding.worker] WebGPU failed; falling back to WASM",
                        error,
                    );
                }
            }
            const extractor = await loadPipeline("wasm", WASM_DTYPE);
            activeDevice = "wasm";
            return extractor;
        })();
    }
    return pipelinePromise;
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

/** Mean-pool patch tokens for one image into a 512-d vector. */
const poolOneImage = (
    flat: Float32Array,
    offset: number,
    tokenCount: number,
): number[] | undefined => {
    if (tokenCount <= 1) {
        return l2NormalizeEmbedding(
            flat.subarray(offset, offset + EMBEDDING_DIMS),
        );
    }
    const mean = new Float32Array(EMBEDDING_DIMS);
    for (let t = 0; t < tokenCount; t++) {
        const base = offset + t * EMBEDDING_DIMS;
        for (let d = 0; d < EMBEDDING_DIMS; d++) {
            mean[d]! += flat[base + d]!;
        }
    }
    for (let d = 0; d < EMBEDDING_DIMS; d++) {
        mean[d]! /= tokenCount;
    }
    return l2NormalizeEmbedding(mean);
};

const poolBatchToVectors = (
    data: Float32Array | number[],
    dims: number[],
    batchSize: number,
): Array<number[] | undefined> => {
    const flat =
        data instanceof Float32Array ? data : Float32Array.from(data);
    const out: Array<number[] | undefined> = [];
    if (dims.length === 2 && dims[0] === batchSize && dims[1] === EMBEDDING_DIMS) {
        for (let i = 0; i < batchSize; i++) {
            out.push(
                l2NormalizeEmbedding(
                    flat.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
                ),
            );
        }
        return out;
    }
    if (
        dims.length === 3 &&
        dims[0] === batchSize &&
        dims[2] === EMBEDDING_DIMS
    ) {
        const tokens = dims[1]!;
        const stride = tokens * EMBEDDING_DIMS;
        for (let i = 0; i < batchSize; i++) {
            out.push(poolOneImage(flat, i * stride, tokens));
        }
        return out;
    }
    // Fallback: try to interpret as concatenated singles.
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
    return Array.from({ length: batchSize }, () => undefined);
};

const bytesToRawImage = async (bytes: Uint8Array): Promise<unknown> => {
    const { RawImage } = await import("@huggingface/transformers");
    // After transfer the buffer is ours; only copy when it's a subarray view.
    const standalone =
        bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength ?
            bytes :
            bytes.slice();
    const blob = new Blob([standalone.buffer as ArrayBuffer], {
        type: "image/jpeg",
    });
    return RawImage.fromBlob(blob);
};

const runOrtOnImages = async (
    images: unknown[],
): Promise<{ data: Float32Array | number[]; dims: number[] }> => {
    const extractor = await getExtractor();
    return extractor(images.length === 1 ? images[0] : images, {
        pooling: "mean",
        normalize: true,
    });
};

/**
 * Decode off the ORT chain so JPEG decode for batch N+1 overlaps GPU work on
 * batch N. ORT itself stays serialized on {@link embedChain}.
 */
const embedBatchBytes = async (
    items: Array<{ fileId: number; bytes: Uint8Array }>,
): Promise<Array<{ fileId: number; vector?: number[] }>> => {
    if (items.length === 0) {
        return [];
    }
    const images = await Promise.all(
        items.map((item) => bytesToRawImage(item.bytes)),
    );
    const output = await new Promise<{
        data: Float32Array | number[];
        dims: number[];
    }>((resolve, reject) => {
        embedChain = embedChain
            .then(async () => {
                try {
                    resolve(await runOrtOnImages(images));
                } catch (error) {
                    reject(error);
                }
            })
            .catch(() => {
                // Keep the chain alive after a rejected batch.
            });
    });
    const vectors = poolBatchToVectors(
        output.data,
        output.dims ?? [],
        items.length,
    );
    return items.map((item, index) => ({
        fileId: item.fileId,
        vector: vectors[index],
    }));
};

const handleInit = async (id: number): Promise<void> => {
    try {
        await getExtractor();
        const done: ClipEmbeddingInitDoneMessage = {
            kind: "init-done",
            id,
            device: activeDevice ?? "wasm",
            webGpuSkipReason,
        };
        self.postMessage(done);
    } catch (error) {
        pipelinePromise = undefined;
        activeDevice = undefined;
        const done: ClipEmbeddingInitDoneMessage = {
            kind: "init-done",
            id,
            device: "wasm",
            webGpuSkipReason,
            error:
                error instanceof Error ? error.message : "model load failed",
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
            const results = await embedBatchBytes([
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
            done.results = await embedBatchBytes(message.items);
        } catch (error) {
            done.error =
                error instanceof Error ? error.message : "embed-batch failed";
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
    }
};
