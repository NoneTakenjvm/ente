import { describe, expect, it } from "vitest";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";
import {
    buildSimilarityGroups,
    MAX_GROUP_SIZE,
} from "@/lib/similarity-groups";

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
