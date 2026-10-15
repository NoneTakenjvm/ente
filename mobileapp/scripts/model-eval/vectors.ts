/**
 * Load the vectors `embed.ts` wrote for one model and dataset
 * (`<root>/vectors/<model>/<dataset>.{f32,ids.json,meta.json}`), plus small
 * helpers the scoring scripts share. Research only; not app code.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelEvalDataRoot } from "./manifest";

export type DatasetVectors = {
    model: string;
    dataset: string;
    /** Image ids, aligned with the rows of {@link packed}. */
    ids: string[];
    /** Row-major `ids.length × dims`, L2-normalised. */
    packed: Float32Array;
    dims: number;
    rowById: Map<string, number>;
    meta: Record<string, unknown>;
};

/** Whether `embed.ts` has written vectors for this model and dataset. */
export const hasVectors = (model: string, dataset: string): boolean =>
    existsSync(`${vectorsBase(model, dataset)}.f32`);

/** Read a model's vectors for a dataset. */
export const loadVectors = (model: string, dataset: string): DatasetVectors => {
    const base = vectorsBase(model, dataset);
    const ids = JSON.parse(readFileSync(`${base}.ids.json`, "utf8")) as string[];
    const meta = JSON.parse(
        readFileSync(`${base}.meta.json`, "utf8"),
    ) as Record<string, unknown>;
    const bytes = readFileSync(`${base}.f32`);
    // Copy so the Float32Array is 4-byte aligned whatever Buffer pooling did.
    const packed = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    if (ids.length === 0 || packed.length % ids.length !== 0) {
        throw new Error(`${model}/${dataset}: ${packed.length} floats for ${ids.length} ids`);
    }
    return {
        model,
        dataset,
        ids,
        packed,
        dims: packed.length / ids.length,
        rowById: new Map(ids.map((id, row) => [id, row])),
        meta,
    };
};

/** Dot product of two rows (cosine, since rows are L2-normalised). */
export const rowDot = (
    left: Float32Array,
    leftRow: number,
    right: Float32Array,
    rightRow: number,
    dims: number,
): number => {
    const leftStart = leftRow * dims;
    const rightStart = rightRow * dims;
    let sum = 0;
    for (let d = 0; d < dims; d++) {
        sum += left[leftStart + d]! * right[rightStart + d]!;
    }
    return sum;
};

const vectorsBase = (model: string, dataset: string): string =>
    join(modelEvalDataRoot(), "vectors", model, dataset);
