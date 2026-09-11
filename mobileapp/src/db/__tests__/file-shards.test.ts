import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    FILE_LIBRARY_SHARD_COUNT,
    dirtyFileShardIds,
    fileLibraryPersistFingerprint,
    fileLibraryShardId,
} from "@/db/file-shards";

const stubFile = (
    id: number,
    updationTime: number,
    tags?: string[],
): EnteFile =>
    ({
        id,
        updationTime,
        pubMagicMetadata: tags ?
            {
                version: 1,
                count: 1,
                data: {
                    _organizer_v1: { tags, updatedAt: updationTime + 1 },
                },
            } :
            undefined,
    }) as EnteFile;

describe("fileLibraryShardId", () => {
    it("is stable and in range", () => {
        expect(fileLibraryShardId(0)).toBe(0);
        expect(fileLibraryShardId(64)).toBe(0);
        expect(fileLibraryShardId(65)).toBe(1);
        for (let id = 0; id < 500; id += 1) {
            const shard = fileLibraryShardId(id);
            expect(shard).toBeGreaterThanOrEqual(0);
            expect(shard).toBeLessThan(FILE_LIBRARY_SHARD_COUNT);
        }
    });
});

describe("dirtyFileShardIds", () => {
    it("marks only shards touching changed or removed files", () => {
        const previous = new Map<number, string>([
            [1, fileLibraryPersistFingerprint(stubFile(1, 10))],
            [2, fileLibraryPersistFingerprint(stubFile(2, 20))],
            [128, fileLibraryPersistFingerprint(stubFile(128, 30))],
        ]);
        const files = [
            stubFile(1, 10),
            stubFile(2, 21),
            stubFile(3, 1),
        ];

        const dirty = dirtyFileShardIds(
            files,
            FILE_LIBRARY_SHARD_COUNT,
            previous,
        );
        expect(dirty.has(fileLibraryShardId(2))).toBe(true);
        expect(dirty.has(fileLibraryShardId(3))).toBe(true);
        expect(dirty.has(fileLibraryShardId(128))).toBe(true);
        expect(dirty.has(fileLibraryShardId(1))).toBe(false);
    });

    it("detects tag-only optimistic edits with unchanged updationTime", () => {
        const before = stubFile(1, 10, ["a"]);
        const after = stubFile(1, 10, ["a", "b"]);
        const previous = new Map<number, string>([
            [1, fileLibraryPersistFingerprint(before)],
        ]);
        const dirty = dirtyFileShardIds(
            [after],
            FILE_LIBRARY_SHARD_COUNT,
            previous,
        );
        expect(dirty.has(fileLibraryShardId(1))).toBe(true);
    });

    it("is empty when snapshot matches", () => {
        const files = [stubFile(1, 10), stubFile(2, 20)];
        const previous = new Map(
            files.map((file) => [
                file.id,
                fileLibraryPersistFingerprint(file),
            ]),
        );
        const dirty = dirtyFileShardIds(
            files,
            FILE_LIBRARY_SHARD_COUNT,
            previous,
        );
        expect(dirty.size).toBe(0);
    });
});
