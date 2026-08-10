import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    fileEditSortTime,
    fileUploadSortTime,
    sortFilesByEdit,
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
