import { describe, expect, it } from "vitest";
import {
    buildKitEmbeddingCentroid,
    fileMatchesKitTags,
    kitEmbeddingRivalWeights,
    listKitSeedFiles,
    listKitSeedIds,
    pickKitEmbeddingMedoids,
    sortFilesByKitEmbeddingCompetitive,
} from "@/lib/kit-nearness-sort";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import type { EnteFile } from "ente-media/file";
import { embMap } from "@/test-utils/fixtures";

const fileWithTags = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

describe("fileMatchesKitTags / listKitSeedFiles", () => {
    it("requires every kit tag", () => {
        const file = fileWithTags(1, ["beach", "vietnam"]);
        expect(fileMatchesKitTags(file, ["beach", "vietnam"])).toBe(true);
        expect(fileMatchesKitTags(file, ["beach", "vietnam", "people"])).toBe(
            false,
        );
    });

    it("lists matching seeds in id order", () => {
        const files = [
            fileWithTags(3, ["a", "b"]),
            fileWithTags(1, ["a"]),
            fileWithTags(2, ["a", "b"]),
        ];
        expect(listKitSeedFiles(files, ["a", "b"]).map((f) => f.id)).toEqual([
            2, 3,
        ]);
    });

    it("skips archived seed files", () => {
        const active = fileWithTags(1, ["a", "b"]);
        const archived = {
            ...fileWithTags(2, ["a", "b"]),
            magicMetadata: {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            },
        } as EnteFile;
        expect(listKitSeedFiles([active, archived], ["a", "b"]).map((f) => f.id)).toEqual(
            [1],
        );
    });

    it("listKitSeedIds matches listKitSeedFiles via posting lists", () => {
        const archived = {
            ...fileWithTags(4, ["a", "b"]),
            magicMetadata: {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            },
        } as EnteFile;
        const files = [
            fileWithTags(3, ["a", "b"]),
            fileWithTags(1, ["a"]),
            fileWithTags(2, ["a", "b"]),
            archived,
        ];
        const fileIdsByTag = new Map<string, Set<number>>([
            ["a", new Set([1, 2, 3, 4])],
            // 9 is tagged but outside the seed library.
            ["b", new Set([2, 3, 4, 9])],
        ]);
        const seedFileById = new Map(files.map((file) => [file.id, file]));
        expect(listKitSeedIds(["a", "b"], fileIdsByTag, seedFileById)).toEqual(
            listKitSeedFiles(files, ["a", "b"]).map((file) => file.id),
        );
        expect(listKitSeedIds(["a", "missing"], fileIdsByTag, seedFileById)).toEqual([]);
        expect(listKitSeedIds([], fileIdsByTag, seedFileById)).toEqual([]);
    });
});

describe("CLIP kit embedding nearness", () => {
    const unit = (values: number[]): number[] => {
        const n = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
        return values.map((v) => v / n);
    };

    const pad512 = (a: number, b: number): number[] => {
        const out = new Array(512).fill(0);
        out[0] = a;
        out[1] = b;
        return unit(out);
    };

    it("ranks closer-to-medoid files first", () => {
        const medoid = pad512(1, 0);
        const near = pad512(0.95, 0.05);
        const far = pad512(0, 1);
        const embeddings = embMap([
            [1, near],
            [2, far],
            [3, medoid],
        ]);
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, []),
            fileWithTags(3, []),
        ];
        const ranking = sortFilesByKitEmbeddingCompetitive(
            files,
            [medoid],
            [],
            embeddings,
        );
        expect(ranking.files.map((f) => f.id)).toEqual([3, 1, 2]);
        expect(ranking.distanceById.get(3)).toBeCloseTo(0);
        expect(ranking.distanceById.get(1)!).toBeLessThan(
            ranking.distanceById.get(2)!,
        );
    });

    it("pickKitEmbeddingMedoids keeps dense modes, skips singleton outliers", () => {
        const embeddings = embMap([
            [1, pad512(1, 0)],
            [2, pad512(1, 0)],
            [3, pad512(1, 0)],
            [4, pad512(0, 1)],
            [5, pad512(0, 1)],
            [6, pad512(0.7, 0.7)], // isolated diagonal
        ]);
        const medoids = pickKitEmbeddingMedoids(
            [1, 2, 3, 4, 5, 6],
            embeddings,
        );
        expect(medoids.map((m) => m.fileId).sort((a, b) => a - b)).toEqual([
            1, 4,
        ]);
    });

    it("buildKitEmbeddingCentroid averages seed vectors", () => {
        const embeddings = embMap([
            [1, pad512(1, 0)],
            [2, pad512(0, 1)],
        ]);
        const c = buildKitEmbeddingCentroid([1, 2], embeddings);
        expect(c).toBeDefined();
        expect(c!.length).toBe(512);
        expect(Math.abs(c![0]! - c![1]!)).toBeLessThan(1e-5);
    });

    it("kitEmbeddingRivalWeights is 0 for empty or identical rivals and rises with distance", () => {
        const selected = [Float32Array.from(pad512(1, 0))];
        const identical = [Float32Array.from(pad512(1, 0))];
        const opposite = [Float32Array.from(pad512(0, 1))];
        const [empty, same, far] = kitEmbeddingRivalWeights(selected, [
            [],
            identical,
            opposite,
        ]);
        expect(empty).toBe(0);
        expect(same).toBe(0);
        expect(far).toBeGreaterThan(0.9);
    });
});
