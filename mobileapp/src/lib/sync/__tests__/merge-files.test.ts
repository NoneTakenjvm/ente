import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import type { CollectionFileChange } from "@/core/api/files";
import {
    dedupeFilesById,
    filterFilesForCollection,
    mergeFavoritesCollectionIntoLibrary,
    mergeFileChangesIntoLibrary,
} from "@/lib/sync/merge-files";

const file = (id: number, collectionID: number): EnteFile =>
    ({
        id,
        collectionID,
        key: "key",
        metadata: {
            fileType: 0,
            title: `${id}.jpg`,
            creationTime: id,
            modificationTime: id,
        },
    }) as EnteFile;

describe("merge-files", () => {
    it("mergeFileChangesIntoLibrary applies upserts and deletions", () => {
        const library = new Map([[1, file(1, 10)]]);
        const collectionFiles = new Map([[1, file(1, 10)]]);
        const changes: CollectionFileChange[] = [
            { id: 1, updationTime: 2, isDeleted: true },
            {
                id: 2,
                updationTime: 3,
                isDeleted: false,
                file: file(2, 10),
            },
        ];

        mergeFileChangesIntoLibrary(library, 10, collectionFiles, changes);

        expect(library.has(1)).toBe(false);
        expect(library.get(2)?.id).toBe(2);
    });

    it("mergeFavoritesCollectionIntoLibrary keeps album collectionID and does not delete on unfavourite", () => {
        const library = new Map([[1, file(1, 10)]]);
        const changes: CollectionFileChange[] = [
            {
                id: 1,
                updationTime: 2,
                isDeleted: false,
                file: file(1, 99),
            },
            { id: 1, updationTime: 3, isDeleted: true },
            {
                id: 2,
                updationTime: 4,
                isDeleted: false,
                file: file(2, 99),
            },
        ];

        mergeFavoritesCollectionIntoLibrary(library, changes);

        expect(library.get(1)?.collectionID).toBe(10);
        expect(library.get(2)?.collectionID).toBe(99);
    });

    it("dedupeFilesById keeps one entry per id", () => {
        expect(dedupeFilesById([file(1, 1), file(1, 2)])).toHaveLength(1);
    });

    it("filterFilesForCollection filters by collection", () => {
        const all = [file(1, 10), file(2, 20)];
        expect(filterFilesForCollection(all, 10)).toHaveLength(1);
        expect(filterFilesForCollection(all, null)).toHaveLength(2);
    });
});
