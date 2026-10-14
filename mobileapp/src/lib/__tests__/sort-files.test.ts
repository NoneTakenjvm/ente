import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    fileEditSortTime,
    remapSortedFilesIfSameIds,
    sortFilesByEdit,
    sortFilesByScore,
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

describe("sortFilesByScore", () => {
    const files = [1, 2, 3, 4].map((id) => stubFile({ id }));
    const scores = new Map<number, number>([
        [1, 10],
        [2, 30],
        [3, 20],
    ]);
    const scoreOf = (file: EnteFile): number | undefined => scores.get(file.id);

    it("sorts descending and puts unknown last", () => {
        expect(
            sortFilesByScore(files, scoreOf, false, true).map((f) => f.id),
        ).toEqual([2, 3, 1, 4]);
    });

    it("keeps unknown last when ascending", () => {
        expect(
            sortFilesByScore(files, scoreOf, true, true).map((f) => f.id),
        ).toEqual([1, 3, 2, 4]);
    });

    it("scores unknown as 0 when unknownLast is off", () => {
        expect(
            sortFilesByScore(files, scoreOf, true, false).map((f) => f.id),
        ).toEqual([4, 1, 3, 2]);
        expect(
            sortFilesByScore(files, scoreOf, false, false).map((f) => f.id),
        ).toEqual([2, 3, 1, 4]);
    });

    it("breaks ties by ascending id in both directions", () => {
        const tied = [stubFile({ id: 5 }), stubFile({ id: 2 }), stubFile({ id: 9 })];
        expect(
            sortFilesByScore(tied, () => 1, false, false).map((f) => f.id),
        ).toEqual([2, 5, 9]);
        expect(
            sortFilesByScore(tied, () => 1, true, true).map((f) => f.id),
        ).toEqual([2, 5, 9]);
    });

    it("returns a copy", () => {
        expect(sortFilesByScore(files, scoreOf, true, true)).not.toBe(files);
    });
});
