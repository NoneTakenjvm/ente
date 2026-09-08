/**
 * On-device CLIP image embeddings for kit nearness ranking.
 *
 * Uses transformers.js + Xenova CLIP ViT-B/16. Prefers WebGPU (`q4f16` when the
 * hub file exists, else `fp16`); falls back to WASM (`q8`). Embed jobs use a
 * small concurrency cap. First load downloads the model from Hugging Face and
 * caches it. Changing {@link KIT_EMBEDDING_MODEL_ID} invalidates the local index.
 *
 * Full-library scans are started explicitly from Manage → Settings. Gallery kit
 * nearness only embeds missing seed thumbnails for the selected kit.
 */
import { getSessionCacheKey } from "@/lib/cache-key";
import { getDecryptedThumbnailBytes } from "@/lib/thumbnail-bytes";
import {
    loadEncryptedEmbeddingIndex,
    saveEncryptedEmbeddingIndex,
    type PersistedEmbeddingIndex,
} from "@/db/kv";
import { imageFilesForPhash } from "@/lib/similarity-job";
import type { EnteFile } from "ente-media/file";

/** Model id baked into corpus exports so offline eval stays consistent. */
export const KIT_EMBEDDING_MODEL_ID = "Xenova/clip-vit-base-patch16";

export const KIT_EMBEDDING_DIMS = 512;

export type KitEmbeddingDevice = "webgpu" | "wasm";

type ImageFeaturePipeline = (
    input: string,
    options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let pipelinePromise: Promise<ImageFeaturePipeline> | undefined;
let activeDevice: KitEmbeddingDevice | undefined;
/** Why WebGPU was skipped / failed (for Settings toast + console). */
let webGpuSkipReason: string | undefined;

type KitEmbeddingDtype = "q4f16" | "fp16" | "q8";

/**
 * WebGPU prefers fp16 (widely available on Xenova CLIP hubs); q4f16 is tried
 * next when present. Keep q8 for the WASM path only.
 */
const WEBGPU_DTYPES: readonly KitEmbeddingDtype[] = ["fp16", "q4f16"];
const WASM_DTYPE: KitEmbeddingDtype = "q8";

const canUseWebGpu = async (): Promise<boolean> => {
    const gpu = (
        navigator as Navigator & {
            gpu?: { requestAdapter: () => Promise<unknown> };
        }
    ).gpu;
    if (!gpu) {
        webGpuSkipReason = "navigator.gpu missing (use Chrome/Edge, check chrome://gpu)";
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

const isCoarsePointerMobile = (): boolean => {
    if (typeof window === "undefined" || !window.matchMedia) {
        return false;
    }
    return window.matchMedia("(pointer: coarse)").matches;
};

/** Concurrent embeds — keep low on mobile / WASM to avoid OOM. */
const kitEmbeddingConcurrencyFor = (
    device: KitEmbeddingDevice,
): number => {
    if (device === "webgpu") {
        return isCoarsePointerMobile() ? 2 : 4;
    }
    return isCoarsePointerMobile() ? 1 : 2;
};

const loadPipeline = async (
    device: KitEmbeddingDevice,
    dtype: KitEmbeddingDtype,
): Promise<ImageFeaturePipeline> => {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline(
        "image-feature-extraction",
        KIT_EMBEDDING_MODEL_ID,
        { dtype, device },
    );
    return extractor as unknown as ImageFeaturePipeline;
};

/** Active backend after the first model load (undefined until then). */
export const getKitEmbeddingDevice = (): KitEmbeddingDevice | undefined =>
    activeDevice;

/** Human-readable reason when the session fell back to WASM. */
export const getKitEmbeddingWebGpuSkipReason = (): string | undefined =>
    webGpuSkipReason;

const getExtractor = async (): Promise<ImageFeaturePipeline> => {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            if (await canUseWebGpu()) {
                for (const dtype of WEBGPU_DTYPES) {
                    try {
                        const extractor = await loadPipeline("webgpu", dtype);
                        activeDevice = "webgpu";
                        webGpuSkipReason = undefined;
                        return extractor;
                    } catch (error) {
                        const detail =
                            error instanceof Error ?
                                error.message :
                                String(error);
                        webGpuSkipReason = `WebGPU ${dtype}: ${detail}`;
                        console.warn(
                            `[kit-embedding] WebGPU dtype=${dtype} failed; trying next`,
                            error,
                        );
                    }
                }
            }
            const extractor = await loadPipeline("wasm", WASM_DTYPE);
            activeDevice = "wasm";
            if (webGpuSkipReason) {
                console.warn(
                    "[kit-embedding] falling back to WASM:",
                    webGpuSkipReason,
                );
            }
            return extractor;
        })();
    }
    return pipelinePromise;
};

/** L2-normalize; returns undefined when empty / non-finite. */
const l2NormalizeEmbedding = (
    data: number[] | Float32Array,
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
        // 5 decimals keeps JSON/IDB smaller while preserving ranking fidelity.
        out.push(Math.round((value / norm) * 1e5) / 1e5);
    }
    return out;
};

/**
 * Embed a decrypted thumbnail blob. Returns undefined on model/decode failure.
 */
const embedThumbnailBytes = async (
    bytes: Uint8Array,
): Promise<number[] | undefined> => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    try {
        const extractor = await getExtractor();
        const output = await extractor(url, {
            pooling: "mean",
            normalize: true,
        });
        const data = output.data;
        if (!data || data.length < 8) {
            return undefined;
        }
        // CLIP image-feature-extraction returns [1, 512] pooled.
        const flat =
            data instanceof Float32Array ? data : Float32Array.from(data);
        if (flat.length === KIT_EMBEDDING_DIMS) {
            return l2NormalizeEmbedding(flat);
        }
        // Some builds return patch tokens — take the first vector / mean.
        if (flat.length % KIT_EMBEDDING_DIMS === 0) {
            const tokens = flat.length / KIT_EMBEDDING_DIMS;
            const mean = new Float32Array(KIT_EMBEDDING_DIMS);
            for (let t = 0; t < tokens; t++) {
                for (let d = 0; d < KIT_EMBEDDING_DIMS; d++) {
                    mean[d]! += flat[t * KIT_EMBEDDING_DIMS + d]!;
                }
            }
            for (let d = 0; d < KIT_EMBEDDING_DIMS; d++) {
                mean[d]! /= tokens;
            }
            return l2NormalizeEmbedding(mean);
        }
        return undefined;
    } catch {
        return undefined;
    } finally {
        URL.revokeObjectURL(url);
    }
};

export const hydrateEmbeddingIndex = async (): Promise<
    Map<number, number[]>
> => {
    const persisted = await loadEncryptedEmbeddingIndex(getSessionCacheKey());
    if (persisted?.modelId !== KIT_EMBEDDING_MODEL_ID) {
        return new Map();
    }
    const map = new Map<number, number[]>();
    for (const [id, vector] of Object.entries(persisted.entries)) {
        if (!Array.isArray(vector) || vector.length !== persisted.dims) {
            continue;
        }
        const normalized = l2NormalizeEmbedding(vector);
        if (normalized) {
            map.set(Number(id), normalized);
        }
    }
    return map;
};

const persistEmbeddingIndex = async (
    entries: Map<number, number[]>,
): Promise<void> => {
    const record: PersistedEmbeddingIndex = {
        version: 1,
        modelId: KIT_EMBEDDING_MODEL_ID,
        dims: KIT_EMBEDDING_DIMS,
        entries: Object.fromEntries(entries),
    };
    await saveEncryptedEmbeddingIndex(record, getSessionCacheKey());
};

export type KitEmbeddingProgress = {
    completed: number;
    total: number;
    phase: "model" | "embed";
    device?: KitEmbeddingDevice;
    concurrency?: number;
};

export type RunKitEmbeddingJobOptions = {
    files: readonly EnteFile[];
    userId: number;
    existing?: Map<number, number[]>;
    /**
     * When set, only these files are candidates (still must be owned images).
     * Default: every owned image in {@link files}.
     */
    onlyFileIds?: ReadonlySet<number>;
    onProgress?: (progress: KitEmbeddingProgress) => void;
    /**
     * Called after each persist batch so UI can refresh rankings mid-scan.
     */
    onBatchPersisted?: (entries: Map<number, number[]>) => void;
    /** When true, the job waits (like phash scan pause) instead of aborting. */
    shouldPause?: () => boolean;
    signal?: AbortSignal;
};

const waitIfPaused = async (
    shouldPause?: () => boolean,
    signal?: AbortSignal,
): Promise<boolean> => {
    while (shouldPause?.()) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (signal?.aborted) {
            return true;
        }
    }
    return signal?.aborted ?? false;
};

const runWithConcurrency = async <T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> => {
    if (!items.length) {
        return;
    }
    let index = 0;
    const runners = Array.from(
        { length: Math.min(limit, items.length) },
        async (): Promise<void> => {
            while (index < items.length) {
                const current = items[index]!;
                index += 1;
                await worker(current);
            }
        },
    );
    await Promise.all(runners);
};

/**
 * Embed owned images missing vectors. Persists as it goes.
 */
export const runKitEmbeddingJob = async (
    options: RunKitEmbeddingJobOptions,
): Promise<Map<number, number[]>> => {
    const entries = new Map(
        options.existing ?? (await hydrateEmbeddingIndex()),
    );
    options.onProgress?.({ completed: 0, total: 1, phase: "model" });
    await getExtractor();
    const device = activeDevice ?? "wasm";
    const concurrency = kitEmbeddingConcurrencyFor(device);

    let candidates = imageFilesForPhash([...options.files], options.userId);
    if (options.onlyFileIds) {
        candidates = candidates.filter((file) =>
            options.onlyFileIds!.has(file.id));
    }
    const todo = candidates.filter((file) => !entries.has(file.id));
    const total = todo.length;
    if (total === 0) {
        options.onProgress?.({
            completed: 0,
            total: 0,
            phase: "embed",
            device,
            concurrency,
        });
        return entries;
    }

    let completed = 0;
    let sincePersist = 0;
    let persistChain = Promise.resolve();

    const noteProgress = (): void => {
        options.onProgress?.({
            completed,
            total,
            phase: "embed",
            device,
            concurrency,
        });
    };

    await runWithConcurrency(todo, concurrency, async (file) => {
        if (options.signal?.aborted) {
            return;
        }
        if (await waitIfPaused(options.shouldPause, options.signal)) {
            return;
        }
        const bytes = await getDecryptedThumbnailBytes(file);
        if (bytes) {
            const vector = await embedThumbnailBytes(bytes);
            if (vector?.length === KIT_EMBEDDING_DIMS) {
                entries.set(file.id, vector);
                sincePersist += 1;
            }
        }
        completed += 1;
        noteProgress();
        if (sincePersist >= 24) {
            sincePersist = 0;
            const snapshot = new Map(entries);
            persistChain = persistChain.then(async () => {
                await persistEmbeddingIndex(snapshot);
                options.onBatchPersisted?.(snapshot);
            });
            await persistChain;
        }
    });

    await persistChain;
    await persistEmbeddingIndex(entries);
    options.onBatchPersisted?.(entries);
    return entries;
};
