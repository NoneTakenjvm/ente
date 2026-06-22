import { describe, expect, it } from "vitest";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    exactGroupToSelection,
    findExactDuplicateGroups,
} from "@/lib/exact-duplicates";

const userId = 1;

const collection = (id: number, name: string): Collection =>
    ({
        id,
        name,
        owner: { id: userId, role: "" },
        key: "key",
        type: "album",
        updationTime: 1,
        sharees: [],
    }) as unknown as Collection;

const fileWithHash = (
    id: number,
    hash: string,
    collectionID = 10,
): EnteFile =>
    ({
        id,
        ownerID: userId,
        collectionID,
        key: "key",
        metadata: {
            fileType: 0,
            title: `photo-${id}.jpg`,
            creationTime: id,
            modificationTime: id,
            hash,
        },
        info: { fileSize: 1000 },
    }) as unknown as EnteFile;

describe("exact-duplicates", () => {
    it("groups files with the same metadata hash", () => {
        const collections = [collection(10, "Trips")];
        const files = [
            fileWithHash(1, "abc"),
            fileWithHash(2, "abc"),
            fileWithHash(3, "def"),
        ];

        const groups = findExactDuplicateGroups(files, collections, userId);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.items).toHaveLength(2);
        expect(groups[0]?.prunableCount).toBe(1);
    });

    it("skips files without hash and non-owned files", () => {
        const collections = [collection(10, "Trips")];
        const owned = fileWithHash(1, "abc");
        const shared = {
            ...fileWithHash(2, "abc"),
            ownerID: 99,
        } as EnteFile;

        const groups = findExactDuplicateGroups(
            [owned, shared],
            collections,
            userId,
        );
        expect(groups).toHaveLength(0);
    });

    it("defaults keeper selection to first item", () => {
        const collections = [collection(10, "Trips")];
        const files = [fileWithHash(1, "abc"), fileWithHash(2, "abc")];
        const groups = findExactDuplicateGroups(files, collections, userId);
        const selection = exactGroupToSelection(groups[0]!);
        expect(selection.keeperFileId).toBe(selection.items[0]?.file.id);
    });
});
