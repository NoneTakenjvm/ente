import { describe, expect, it } from "vitest";
import {
    KIT_EMBEDDING_DIMS,
    l2NormalizeEmbedding,
    packEmbeddingVector,
} from "@/lib/kit-embedding";

describe("embedding Float32 packing", () => {
    it("packEmbeddingVector returns the same Float32Array instance", () => {
        const packed = new Float32Array(KIT_EMBEDDING_DIMS);
        packed[0] = 1;
        expect(packEmbeddingVector(packed)).toBe(packed);
    });

    it("packEmbeddingVector copies plain number arrays", () => {
        const plain = Array.from({ length: KIT_EMBEDDING_DIMS }, (_, i) =>
            (i === 0 ? 1 : 0));
        const packed = packEmbeddingVector(plain);
        expect(packed).toBeInstanceOf(Float32Array);
        expect(packed?.[0]).toBe(1);
        expect(packed?.length).toBe(KIT_EMBEDDING_DIMS);
    });

    it("l2NormalizeEmbedding returns a packed unit vector", () => {
        const raw = Array.from({ length: KIT_EMBEDDING_DIMS }, () => 0);
        raw[0] = 3;
        raw[1] = 4;
        const normalized = l2NormalizeEmbedding(raw);
        expect(normalized).toBeInstanceOf(Float32Array);
        let sumSq = 0;
        for (const value of normalized!) {
            sumSq += value * value;
        }
        expect(sumSq).toBeCloseTo(1, 4);
    });
});
