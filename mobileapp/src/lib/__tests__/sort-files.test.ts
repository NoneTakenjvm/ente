import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    fileEditSortTime,
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByUpload,
} from "@/lib/sort-files";
import { fileUploadSortTime } from "@/core/metadata";
import { stubFile } from "@/test-utils/fixtures";

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

describe("sortFilesNewestFirst tiebreak", () => {
    it("orders equal upload times by newest id first", () => {
        const withUploadedAt = (id: number): EnteFile => stubFile({
            id,
            pubMagicMetadata: { version: 1, count: 1, data: { uploadedAt: 100 } },
        });
        const files = [withUploadedAt(1), withUploadedAt(3), withUploadedAt(2)];
        const ids = (list: EnteFile[]) => list.map((file) => file.id);
        expect(ids(sortFilesByUpload(files))).toEqual([3, 2, 1]);
        expect(ids(sortFilesByUpload([...files].reverse()))).toEqual([3, 2, 1]);
    });
});
