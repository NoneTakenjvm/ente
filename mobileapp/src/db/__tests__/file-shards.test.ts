import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    FILE_LIBRARY_SHARD_COUNT,
    dirtyFileShardIdsFromUpdation,
    fileLibraryShardId,
    resolveDirtyFileShardIds,
} from "@/db/file-shards";

const stubFile = (id: number, updationTime: number): EnteFile =>
    ({ id, updationTime }) as EnteFile;

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

describe("dirtyFileShardIdsFromUpdation", () => {
    it("marks only shards touching changed or removed files", () => {
        const previous = new Map<number, number>([
            [1, 10],
            [2, 20],
            [128, 30],
        ]);
        const files = [stubFile(1, 10), stubFile(2, 21), stubFile(3, 1)];
        const dirty = dirtyFileShardIdsFromUpdation(
            files,
            FILE_LIBRARY_SHARD_COUNT,
            previous,
        );
        expect(dirty.has(fileLibraryShardId(2))).toBe(true);
        expect(dirty.has(fileLibraryShardId(3))).toBe(true);
        expect(dirty.has(fileLibraryShardId(128))).toBe(true);
        expect(dirty.has(fileLibraryShardId(1))).toBe(false);
    });
});

describe("resolveDirtyFileShardIds", () => {
    it("includes explicitly marked optimistic tag edits", () => {
        const previous = new Map<number, number>([[1, 10], [2, 20]]);
        const files = [stubFile(1, 10), stubFile(2, 20)];
        const dirty = resolveDirtyFileShardIds(
            files,
            FILE_LIBRARY_SHARD_COUNT,
            previous,
            new Set([1]),
            false,
        );
        expect(dirty.has(fileLibraryShardId(1))).toBe(true);
        expect(dirty.has(fileLibraryShardId(2))).toBe(false);
    });

    it("is empty when nothing changed and nothing marked", () => {
        const previous = new Map<number, number>([[1, 10], [2, 20]]);
        const files = [stubFile(1, 10), stubFile(2, 20)];
        const dirty = resolveDirtyFileShardIds(
            files,
            FILE_LIBRARY_SHARD_COUNT,
            previous,
            new Set(),
            false,
        );
        expect(dirty.size).toBe(0);
    });
});
