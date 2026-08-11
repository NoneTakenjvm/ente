import { describe, expect, it, vi } from "vitest";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";
import {
    buildSimilarityGroups,
    MAX_GROUP_SIZE,
    mergeCropMatches,
} from "@/lib/similarity-groups";

vi.mock("@/lib/similarity-job", () => ({
    checkCropMatchInWorkers: vi.fn(async () => true),
}));

const stubFile = (
    id: number,
    collectionID: number,
    ownerID: number,
): EnteFile =>
    ({
        id,
        collectionID,
        ownerID,
        updationTime: id,
        encryptedKey: "key",
        keyDecryptionNonce: "nonce",
        metadata: {
            creationTime: id,
            modificationTime: id,
            title: `file-${id}`,
            fileType: FileType.image,
            hash: "hash",
        },
        isDeleted: false,
    }) as unknown as EnteFile;

const stubCollection = (id: number): Collection => ({
    id,
    name: `collection-${id}`,
    type: "uncategorized",
    owner: { id: 1, email: "", role: "" },
    key: "key",
    sharees: [],
    publicURLs: [],
    updationTime: id,
});

// Hex strings where each is one 64-bit dHash value; normalized into PhashEntry
// hashes before building groups.
const describeGroups = (
    hashes: Map<number, string[]>,
    filesById: Map<number, EnteFile>,
    collections: Collection[],
): number[][] => {
    const entries = new Map<number, PhashEntry>();
    for (const [fileId, hashesArr] of hashes.entries()) {
        entries.set(fileId, { hashes: hashesArr });
    }
    const groups = buildSimilarityGroups(entries, filesById, collections, 1, 10);
    return groups.map((group) =>
        group.items.map((item) => item.file.id).sort((a, b) => a - b));
};

describe("buildSimilarityGroups with rotation/mirror variants", () => {
    const filesById = new Map([
        [1, stubFile(1, 1, 1)],
        [2, stubFile(2, 1, 1)],
        [3, stubFile(3, 1, 1)],
        [4, stubFile(4, 1, 1)],
    ]);
    const collections = [stubCollection(1)];

    it("groups a rotated duplicate whose variant matches another file's primary", () => {
        // file 1: primary at prefix a1bf..., variants include a1bf... (itself)
        // file 2: variants where the 270°-no-mirror variant equals file 1's
        // primary (a1bf...), so the rotated file matches the source.
        const entries = new Map<number, string[]>([
            [1, ["a1bf--------" as string, "c0de--------", "c0de--------", "c0de--------"]],
            [2, ["f9c1--------", "f9c1--------", "f9c1--------", "a1bf--------"]],
        ]);
        const groups = describeGroups(entries, filesById, collections);
        expect(groups).toEqual([[1, 2]]);
    });

    it("groups a mirrored duplicate via the mirror variant", () => {
        // file 3: mirror variant (index 1, 90°? no — use 0°+mirror at index 1)
        // The index order is [rot0,nomirror, rot0,mirror, rot90,nomirror, ...].
        const entries = new Map<number, string[]>([
            [1, ["a1bf--------"]],
            [3, ["d00d--------", "a1bf--------"]],
        ]);
        const groups = describeGroups(entries, filesById, collections);
        expect(groups).toEqual([[1, 3]]);
    });

    it("does not group two different photos whose all variants differ", () => {
        const entries = new Map<number, string[]>([
            [1, ["aaaa--------"]],
            [4, ["cccc--------"]],
        ]);
        const groups = describeGroups(entries, filesById, collections);
        expect(groups).toEqual([]);
    });

    it("treats legacy single-hash entries like the original single-hash compare", () => {
        // file 1 and file 2 primary hashes identical (same prefix, distance 0).
        const entries = new Map<number, string[]>([
            [1, ["a1bf--------"]],
            [2, ["a1bf--------"]],
        ]);
        const groups = describeGroups(entries, filesById, collections);
        expect(groups).toEqual([[1, 2]]);
    });

    it("does not union a file with itself via its own multiple variants", () => {
        // file 1 has two variants sharing a prefix but no other files.
        const entries = new Map<number, string[]>([
            [1, ["a1bf--------", "a1bf--------"]],
            [2, ["c0de--------"]],
        ]);
        const groups = describeGroups(entries, filesById, collections);
        expect(groups).toEqual([]);
    });
});

describe("buildSimilarityGroups oversized-component cap", () => {
    const filesById = new Map(
        Array.from({ length: MAX_GROUP_SIZE + 20 }, (_, i) => [
            i + 1,
            stubFile(i + 1, 1, 1),
        ]),
    );
    const collections = [stubCollection(1)];

    it("never emits a group larger than MAX_GROUP_SIZE even when loose links chain", () => {
        // A chain of hashes: each adjacent pair differs by 1 bit (dist 1 <= 10),
        // so the plain union-find would collapse all ~60 into one component.
        // The cap must split it into bounded clusters.
        const entries = new Map<number, string[]>();
        for (let i = 0; i < MAX_GROUP_SIZE + 20; i++) {
            entries.set(i + 1, [
                (0xa1b00000 + i).toString(16).padStart(16, "0"),
            ]);
        }
        const groups = describeGroups(entries, filesById, collections);
        for (const group of groups) {
            expect(group.length).toBeLessThanOrEqual(MAX_GROUP_SIZE);
        }
        // The chain is real adjacency, so we should still get multiple groups
        // covering the files — not a single cap-sized dump plus stragglers.
        expect(groups.length).toBeGreaterThan(1);
    });

    it("keeps a genuinely identical cluster together below the cap", () => {
        // 3 truly identical copies: same hash → one tight group, no split.
        const entries = new Map<number, string[]>([
            [1, ["a1bf000000000000"]],
            [2, ["a1bf000000000000"]],
            [3, ["a1bf000000000000"]],
        ]);
        const localFiles = new Map([
            [1, stubFile(1, 1, 1)],
            [2, stubFile(2, 1, 1)],
            [3, stubFile(3, 1, 1)],
        ]);
        const groups = describeGroups(entries, localFiles, collections);
        expect(groups).toEqual([[1, 2, 3]]);
    });
});

describe("mergeCropMatches size cap", () => {
    const count = MAX_GROUP_SIZE + 25;
    const collections = [stubCollection(1)];
    const filesById = new Map(
        Array.from({ length: count }, (_, i) => [i + 1, stubFile(i + 1, 1, 1)]),
    );

    /** Distinct dHash so Stage-1 leaves everything as singletons; shared color
     *  prefix so Stage-2 proposes a long chain of crop candidates. */
    const cropChainEntries = (): Map<number, PhashEntry> => {
        const entries = new Map<number, PhashEntry>();
        for (let i = 0; i < count; i++) {
            // Far-apart dHash values (unique 3-hex buckets, high Hamming distance)
            // so Stage-1 leaves everything as singletons. Shared color prefix `aa`
            // puts them all in one Stage-2 color bucket.
            const hashPrefix = (i * 17).toString(16).padStart(3, "0").slice(-3);
            const color = `aa${i.toString(16).padStart(14, "0")}`;
            entries.set(i + 1, {
                hashes: [`${hashPrefix}${"f".repeat(13)}`],
                color,
                // Worker is mocked; payload only needs to be present.
                grid: "AAAA",
            });
        }
        return entries;
    };

    it("never emits a group larger than MAX_GROUP_SIZE when every crop check matches", async () => {
        const entries = cropChainEntries();
        const stage1 = buildSimilarityGroups(entries, filesById, collections, 1, 10);
        expect(stage1).toEqual([]);

        const merged = await mergeCropMatches(stage1, {
            entries,
            filesById,
            collections,
            userId: 1,
            batchSize: 16,
        });

        expect(merged.length).toBeGreaterThan(0);
        for (const group of merged) {
            expect(group.items.length).toBeLessThanOrEqual(MAX_GROUP_SIZE);
        }
        const covered = merged.reduce((sum, group) => sum + group.items.length, 0);
        // Every file should land in some capped group when all pairs match.
        expect(covered).toBe(count);
    });

    it("aborts when the signal is already aborted", async () => {
        const entries = cropChainEntries();
        const abort = new AbortController();
        abort.abort();
        await expect(
            mergeCropMatches([], {
                entries,
                filesById,
                collections,
                userId: 1,
                signal: abort.signal,
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
