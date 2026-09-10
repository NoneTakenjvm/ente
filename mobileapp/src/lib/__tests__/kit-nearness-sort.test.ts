import { describe, expect, it } from "vitest";
import type { PhashEntry } from "@/lib/crop-match";
import {
    blendedNearnessDistance,
    buildKitEmbeddingCentroid,
    fileMatchesKitTags,
    kitDistance,
    kitDistinctiveness,
    kitNearnessDistance,
    kitNearnessDistanceCompetitive,
    listKitSeedFiles,
    pickKitEmbeddingMedoids,
    pickKitMedoids,
    rankKitsByBestFitShare,
    sortFilesByKitEmbeddingCompetitive,
    sortFilesByKitNearness,
    sortFilesByKitNearnessCompetitive,
} from "@/lib/kit-nearness-sort";
import { parseDHashHex } from "@/lib/phash";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import type { EnteFile } from "ente-media/file";

const fileWithTags = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

/** Distinct 64-bit hex dHashes (primary only) for controlled distances. */
const entry = (hex: string, color?: string): PhashEntry =>
    color ? { hashes: [hex], color } : { hashes: [hex] };

const ZERO = "0000000000000000";
const ONE_BIT = "0000000000000001";
const MANY_BITS = "ffffffffffffffff";
const HALF_A = "00000000ffffffff";
const HALF_B = "ffffffff00000000";
/** Color palette close to ZERO (1 bit). */
const COLOR_NEAR = "0000000000000001";
/** Color palette far from ZERO. */
const COLOR_FAR = "ffffffffffffffff";

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
});

describe("pickKitMedoids", () => {
    it("returns empty when no seeds have hashes", () => {
        expect(pickKitMedoids([1, 2], new Map())).toEqual([]);
    });

    it("keeps diverse modes and stops when leftovers are close", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(ONE_BIT)], // near 1
            [3, entry(MANY_BITS)], // far
            [4, entry(HALF_A)], // mid
        ]);
        const medoids = pickKitMedoids([1, 2, 3, 4], entries, {
            maxMedoids: 6,
            minSeparation: 10,
        });
        const ids = medoids.map((m) => m.fileId);
        // Densest start is 1 or 2 (tied density → lower id); far mode 3 included.
        expect(ids[0]).toBe(1);
        expect(ids).toContain(3);
        expect(ids).not.toContain(2);
    });

    it("starts from the densest cluster when id order would pick an outlier", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(MANY_BITS)], // outlier, lowest id
            [2, entry(ZERO)],
            [3, entry(ONE_BIT)],
            [4, entry("0000000000000003")], // 2 bits from ZERO
        ]);
        const medoids = pickKitMedoids([1, 2, 3, 4], entries, {
            maxMedoids: 2,
            minSeparation: 10,
        });
        // Cluster around ZERO is denser than the lone MANY_BITS seed.
        expect(medoids[0]!.fileId).not.toBe(1);
        expect([2, 3, 4]).toContain(medoids[0]!.fileId);
    });
});

describe("blendedNearnessDistance", () => {
    const zero = [parseDHashHex(ZERO)];
    const one = [parseDHashHex(ONE_BIT)];
    const colorZero = parseDHashHex(ZERO);
    const colorNear = parseDHashHex(COLOR_NEAR);
    const colorFar = parseDHashHex(COLOR_FAR);

    it("matches structure-only when color is missing", () => {
        expect(blendedNearnessDistance(zero, undefined, one, colorZero)).toBe(1);
        expect(blendedNearnessDistance(zero, colorZero, one, undefined)).toBe(1);
    });

    it("applies a bonus when palettes are close", () => {
        const structureOnly = blendedNearnessDistance(
            zero,
            undefined,
            one,
            undefined,
        );
        const withColor = blendedNearnessDistance(
            zero,
            colorZero,
            one,
            colorNear,
        );
        expect(withColor).toBeLessThan(structureOnly);
    });

    it("skips color bonus when structure exceeds the gate", () => {
        const far = [parseDHashHex(HALF_A)]; // 32 bits from ZERO
        const structureOnly = blendedNearnessDistance(
            zero,
            undefined,
            far,
            undefined,
        );
        const gated = blendedNearnessDistance(
            zero,
            colorZero,
            far,
            colorNear,
        );
        expect(gated).toBe(structureOnly);
    });

    it("does not punish a distant palette beyond structure", () => {
        const structureOnly = blendedNearnessDistance(
            zero,
            undefined,
            one,
            undefined,
        );
        const withFarColor = blendedNearnessDistance(
            zero,
            colorZero,
            one,
            colorFar,
        );
        expect(withFarColor).toBe(structureOnly);
    });
});

describe("sortFilesByKitNearness", () => {
    it("orders by min distance to medoids; missing hash last", () => {
        const entries = new Map<number, PhashEntry>([
            [10, entry(ZERO)],
            [20, entry(MANY_BITS)],
            [30, entry(ONE_BIT)],
        ]);
        const medoids = pickKitMedoids([10], entries);
        const files = [
            { id: 40 } as EnteFile,
            { id: 20 } as EnteFile,
            { id: 30 } as EnteFile,
            { id: 10 } as EnteFile,
        ];
        expect(
            sortFilesByKitNearness(files, medoids, entries).map((f) => f.id),
        ).toEqual([10, 30, 20, 40]);
    });

    it("kitNearnessDistance is 0 for a medoid seed", () => {
        const entries = new Map<number, PhashEntry>([[5, entry(ZERO)]]);
        const medoids = pickKitMedoids([5], entries);
        expect(kitNearnessDistance(5, medoids, entries)).toBe(0);
    });

    it("leaves order unchanged when there are no medoids", () => {
        const files = [{ id: 2 } as EnteFile, { id: 1 } as EnteFile];
        const ordered = sortFilesByKitNearness(files, [], new Map());
        expect(ordered.map((f) => f.id)).toEqual([2, 1]);
        expect(ordered).not.toBe(files);
    });

    it("ranks a mid-structure color-match above a closer color-mismatch", () => {
        // 10 bits set → structure dist 10; near-full color bonus → score 0.
        const TEN_BITS = "00000000000003ff";
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO, ZERO)],
            [2, entry(TEN_BITS, COLOR_NEAR)],
            [3, entry(ONE_BIT, COLOR_FAR)],
        ]);
        const medoids = pickKitMedoids([1], entries);
        const ordered = sortFilesByKitNearness(
            [{ id: 2 } as EnteFile, { id: 3 } as EnteFile],
            medoids,
            entries,
        );
        expect(kitNearnessDistance(2, medoids, entries)).toBeLessThan(
            kitNearnessDistance(3, medoids, entries),
        );
        expect(ordered[0]!.id).toBe(2);
    });
});

describe("multi-medoid scoring", () => {
    it("scores against the nearest mode", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(MANY_BITS)],
            [3, entry(HALF_B)], // closer to MANY_BITS than ZERO in Hamming
            [4, entry(ONE_BIT)], // closer to ZERO
        ]);
        const medoids = pickKitMedoids([1, 2], entries, {
            maxMedoids: 2,
            minSeparation: 1,
        });
        expect(medoids).toHaveLength(2);
        const files = [
            { id: 3 } as EnteFile,
            { id: 4 } as EnteFile,
        ];
        const ordered = sortFilesByKitNearness(files, medoids, entries);
        // 4 near ZERO medoid (dist 1); 3 farther from both
        expect(ordered[0]!.id).toBe(4);
        expect(ordered[1]!.id).toBe(3);
    });
});

describe("competitive kit nearness", () => {
    it("kitDistinctiveness is 0 for identical kits and rises with δ", () => {
        expect(kitDistinctiveness(0)).toBe(0);
        expect(kitDistinctiveness(8, 8)).toBeCloseTo(0.5);
        expect(kitDistinctiveness(100, 8)).toBeGreaterThan(0.9);
    });

    it("kitDistance is small for overlapping modes and large for opposites", () => {
        const near = pickKitMedoids(
            [1, 2],
            new Map([
                [1, entry(ZERO)],
                [2, entry(ONE_BIT)],
            ]),
        );
        const far = pickKitMedoids(
            [3],
            new Map([[3, entry(MANY_BITS)]]),
        );
        expect(kitDistance(near, near)).toBeLessThan(2);
        expect(kitDistance(near, far)).toBeGreaterThan(30);
    });

    it("selected seed stays at competitive distance 0", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(MANY_BITS)],
        ]);
        const selected = pickKitMedoids([1], entries);
        const rivals = [pickKitMedoids([2], entries)];
        expect(
            kitNearnessDistanceCompetitive(1, selected, rivals, entries),
        ).toBe(0);
    });

    it("penalizes a file closer to a dissimilar rival", () => {
        // Near-all-ones: closer to MANY_BITS rival than to ZERO selected.
        const NEAR_MANY = "ffffffffffffff00";
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(MANY_BITS)],
            [3, entry(NEAR_MANY)],
        ]);
        const selected = pickKitMedoids([1], entries);
        const rivals = [pickKitMedoids([2], entries)];
        const plain = kitNearnessDistance(3, selected, entries);
        const competitive = kitNearnessDistanceCompetitive(
            3,
            selected,
            rivals,
            entries,
        );
        expect(kitNearnessDistance(3, rivals[0]!, entries)).toBeLessThan(plain);
        expect(competitive).toBeGreaterThan(plain);
    });

    it("does not penalize when rival kit is identical", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(ZERO)],
            [3, entry(ONE_BIT)],
        ]);
        const selected = pickKitMedoids([1], entries);
        const rivals = [pickKitMedoids([2], entries)];
        const plain = kitNearnessDistance(3, selected, entries);
        const competitive = kitNearnessDistanceCompetitive(
            3,
            selected,
            rivals,
            entries,
        );
        expect(competitive).toBe(plain);
    });

    it("sorts rival-owned lookalikes below selected lookalikes", () => {
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(MANY_BITS)],
            [10, entry(ONE_BIT)], // near selected
            [20, entry("ffffffffffff0000")], // nearer to MANY_BITS
        ]);
        const selected = pickKitMedoids([1], entries);
        const rivals = [pickKitMedoids([2], entries)];
        const ordered = sortFilesByKitNearnessCompetitive(
            [{ id: 20 } as EnteFile, { id: 10 } as EnteFile],
            selected,
            rivals,
            entries,
        );
        expect(ordered[0]!.id).toBe(10);
        expect(ordered[1]!.id).toBe(20);
    });
});

describe("rankKitsByBestFitShare", () => {
    it("ranks kits by how often each is nearest for hashed files", () => {
        const files = [
            fileWithTags(1, ["kit-a"]),
            fileWithTags(2, ["kit-b"]),
            fileWithTags(10, []),
            fileWithTags(20, []),
            fileWithTags(30, []),
        ];
        const entries = new Map<number, PhashEntry>([
            [1, entry(ZERO)],
            [2, entry(MANY_BITS)],
            [10, entry(ONE_BIT)], // nearer kit-a
            [20, entry("fffffffffffffffe")], // nearer kit-b
            [30, entry(HALF_A)], // nearer kit-a than kit-b typically
        ]);
        const ranked = rankKitsByBestFitShare(
            [
                { id: "a", tags: ["kit-a"] },
                { id: "b", tags: ["kit-b"] },
            ],
            files,
            entries,
        );
        expect(ranked.map((row) => row.presetId)).toEqual(["a", "b"]);
        expect(ranked[0]!.winCount + ranked[1]!.winCount).toBe(5);
        expect(ranked[0]!.share).toBeGreaterThan(ranked[1]!.share);
    });

    it("returns 0 share when kits have no hashed seeds", () => {
        const ranked = rankKitsByBestFitShare(
            [{ id: "empty", tags: ["missing"] }],
            [fileWithTags(1, ["other"])],
            new Map([[1, entry(ZERO)]]),
        );
        expect(ranked).toEqual([
            { presetId: "empty", winCount: 0, share: 0 },
        ]);
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
        const embeddings = new Map<number, number[]>([
            [1, near],
            [2, far],
            [3, medoid],
        ]);
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, []),
            fileWithTags(3, []),
        ];
        const ordered = sortFilesByKitEmbeddingCompetitive(
            files,
            [medoid],
            [],
            embeddings,
        );
        expect(ordered.map((f) => f.id)).toEqual([3, 1, 2]);
    });

    it("pickKitEmbeddingMedoids keeps dense modes, skips singleton outliers", () => {
        const embeddings = new Map<number, number[]>([
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
        const embeddings = new Map([
            [1, pad512(1, 0)],
            [2, pad512(0, 1)],
        ]);
        const c = buildKitEmbeddingCentroid([1, 2], embeddings);
        expect(c).toBeDefined();
        expect(c!.length).toBe(512);
        expect(Math.abs(c![0]! - c![1]!)).toBeLessThan(1e-5);
    });
});
