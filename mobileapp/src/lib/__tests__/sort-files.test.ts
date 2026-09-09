import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import {
    fileEditSortTime,
    fileUpdateSortTime,
    fileUploadSortTime,
    moveFilesToFrontByUpdate,
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByUpdate,
    sortFilesByUpload,
} from "@/lib/sort-files";

const stubFile = (overrides: Partial<EnteFile>): EnteFile =>
    ({
        id: 1,
        collectionID: 1,
        ownerID: 1,
        updationTime: 0,
        encryptedKey: "key",
        keyDecryptionNonce: "nonce",
        metadata: {
            creationTime: 0,
            modificationTime: 0,
            title: "file",
            fileType: 1,
            hash: "hash",
        },
        isDeleted: false,
        ...overrides,
    }) as EnteFile;

const pubData = (
    data: FilePublicMagicMetadataData & {
        _organizer_v1?: { tags?: string[]; updatedAt?: number };
    },
): FilePublicMagicMetadataData => data as FilePublicMagicMetadataData;

describe("fileUploadSortTime", () => {
    it("prefers stored uploadedAt", () => {
        const file = stubFile({
            pubMagicMetadata: {
                version: 1,
                count: 1,
                data: { uploadedAt: 100 },
            },
            updationTime: 50,
        });
        expect(fileUploadSortTime(file)).toBe(100);
    });

    it("falls back to updationTime when uploadedAt is missing", () => {
        const file = stubFile({ updationTime: 50 });
        expect(fileUploadSortTime(file)).toBe(50);
    });

    it("falls back to fileCreationTime when both are missing", () => {
        const file = stubFile({
            updationTime: undefined,
            metadata: {
                creationTime: 30,
                modificationTime: 50,
                title: "file",
                fileType: 1,
            },
        });
        expect(fileUploadSortTime(file)).toBe(30);
    });
});

describe("fileEditSortTime", () => {
    it("prefers stored editedAt", () => {
        const file = stubFile({
            pubMagicMetadata: { version: 1, count: 1, data: { editedAt: 200 } },
            metadata: {
                modificationTime: 10,
                title: "file",
                fileType: 1,
                creationTime: 0,
            },
        });
        expect(fileEditSortTime(file)).toBe(200);
    });

    it("falls back to modification time", () => {
        const file = stubFile({
            metadata: {
                modificationTime: 40,
                title: "file",
                fileType: 1,
                creationTime: 0,
            },
        });
        expect(fileEditSortTime(file)).toBe(40);
    });
});

describe("sortFilesByUpload", () => {
    it("sorts newest upload first, using stored time", () => {
        const older = stubFile({
            id: 1,
            pubMagicMetadata: { version: 1, count: 1, data: { uploadedAt: 100 } },
        });
        const newer = stubFile({
            id: 2,
            pubMagicMetadata: { version: 1, count: 1, data: { uploadedAt: 400 } },
        });
        expect(sortFilesByUpload([older, newer]).map((f) => f.id)).toEqual([
            2, 1,
        ]);
    });
});

describe("sortFilesByEdit", () => {
    it("sorts newest edit first", () => {
        const older = stubFile({
            id: 1,
            pubMagicMetadata: { version: 1, count: 1, data: { editedAt: 100 } },
        });
        const newer = stubFile({
            id: 2,
            pubMagicMetadata: { version: 1, count: 1, data: { editedAt: 500 } },
        });
        expect(sortFilesByEdit([newer, older]).map((f) => f.id)).toEqual([
            2, 1,
        ]);
    });
});

describe("fileUpdateSortTime", () => {
    it("prefers the newest of tag, edit, and server times", () => {
        const file = stubFile({
            updationTime: 100,
            pubMagicMetadata: {
                version: 1,
                count: 1,
                data: pubData({
                    editedAt: 200,
                    _organizer_v1: { tags: ["a"], updatedAt: 300 },
                }),
            },
        });
        expect(fileUpdateSortTime(file)).toBe(300);
    });

    it("uses updationTime when organizer and editedAt are absent", () => {
        const file = stubFile({ updationTime: 80 });
        expect(fileUpdateSortTime(file)).toBe(80);
    });
});

describe("sortFilesByUpdate", () => {
    it("sorts newest update first", () => {
        const older = stubFile({
            id: 1,
            updationTime: 10,
            pubMagicMetadata: {
                version: 1,
                count: 1,
                data: pubData({
                    _organizer_v1: { tags: [], updatedAt: 100 },
                }),
            },
        });
        const newer = stubFile({
            id: 2,
            updationTime: 50,
            pubMagicMetadata: {
                version: 1,
                count: 1,
                data: pubData({
                    _organizer_v1: { tags: ["x"], updatedAt: 500 },
                }),
            },
        });
        expect(sortFilesByUpdate([older, newer]).map((f) => f.id)).toEqual([
            2, 1,
        ]);
    });
});

describe("remapSortedFilesIfSameIds", () => {
    it("keeps previous order when only file objects changed", () => {
        const first = stubFile({ id: 1, updationTime: 1 });
        const second = stubFile({ id: 2, updationTime: 2 });
        const updatedFirst = stubFile({ id: 1, updationTime: 9 });
        const remapped = remapSortedFilesIfSameIds(
            [second, first],
            [updatedFirst, second],
        );
        expect(remapped?.map((file) => file.id)).toEqual([2, 1]);
        expect(remapped?.[1]).toBe(updatedFirst);
    });

    it("returns undefined when membership changes", () => {
        expect(
            remapSortedFilesIfSameIds(
                [stubFile({ id: 1 })],
                [stubFile({ id: 1 }), stubFile({ id: 2 })],
            ),
        ).toBeUndefined();
    });
});

describe("moveFilesToFrontByUpdate", () => {
    it("moves touched ids to the front by update time", () => {
        const files = [
            stubFile({ id: 1, updationTime: 10 }),
            stubFile({ id: 2, updationTime: 50 }),
            stubFile({ id: 3, updationTime: 20 }),
        ];
        expect(
            moveFilesToFrontByUpdate(files, [3, 1]).map((file) => file.id),
        ).toEqual([3, 1, 2]);
    });
});
