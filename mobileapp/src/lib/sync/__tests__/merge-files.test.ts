import { describe, expect, it } from "vitest";
import type { CollectionFileChange } from "@/core/api/files";
import {
    dedupeFilesById,
    mergeFavoritesCollectionIntoLibrary,
    mergeFileChangesIntoLibrary,
} from "@/lib/sync/merge-files";
import { stubFile } from "@/test-utils/fixtures";

describe("merge-files", () => {
    it("mergeFileChangesIntoLibrary applies upserts and deletions", () => {
        const library = new Map([[1, stubFile({ id: 1, collectionID: 10 })]]);
        const collectionFiles = new Map([[1, stubFile({ id: 1, collectionID: 10 })]]);
        const changes: CollectionFileChange[] = [
            { id: 1, updationTime: 2, isDeleted: true },
            {
                id: 2,
                updationTime: 3,
                isDeleted: false,
                file: stubFile({ id: 2, collectionID: 10 }),
            },
        ];

        mergeFileChangesIntoLibrary(
            library,
            10,
            collectionFiles,
            changes,
            new Map([[10, collectionFiles]]),
        );

        expect(library.has(1)).toBe(false);
        expect(library.get(2)?.id).toBe(2);
    });

    it("mergeFileChangesIntoLibrary keeps a file still present in another collection", () => {
        const library = new Map([[1, stubFile({ id: 1, collectionID: 10 })]]);
        const collectionFiles = new Map([[1, stubFile({ id: 1, collectionID: 10 })]]);
        const otherFiles = new Map([[1, stubFile({ id: 1, collectionID: 20 })]]);
        const changes: CollectionFileChange[] = [
            { id: 1, updationTime: 2, isDeleted: true },
        ];

        mergeFileChangesIntoLibrary(
            library,
            10,
            collectionFiles,
            changes,
            new Map([
                [10, collectionFiles],
                [20, otherFiles],
            ]),
        );

        expect(collectionFiles.has(1)).toBe(false);
        expect(library.get(1)?.collectionID).toBe(20);
    });

    it("mergeFavoritesCollectionIntoLibrary keeps album collectionID and does not delete on unfavourite", () => {
        const library = new Map([[1, stubFile({ id: 1, collectionID: 10 })]]);
        const changes: CollectionFileChange[] = [
            {
                id: 1,
                updationTime: 2,
                isDeleted: false,
                file: stubFile({ id: 1, collectionID: 99 }),
            },
            { id: 1, updationTime: 3, isDeleted: true },
            {
                id: 2,
                updationTime: 4,
                isDeleted: false,
                file: stubFile({ id: 2, collectionID: 99 }),
            },
        ];

        mergeFavoritesCollectionIntoLibrary(library, changes);

        expect(library.get(1)?.collectionID).toBe(10);
        expect(library.get(2)?.collectionID).toBe(99);
    });

    it("dedupeFilesById keeps one entry per id", () => {
        const duplicates = [
            stubFile({ id: 1, collectionID: 1 }),
            stubFile({ id: 1, collectionID: 2 }),
        ];
        expect(dedupeFilesById(duplicates)).toHaveLength(1);
    });
});
