import { describe, expect, it } from "vitest";
import { resolveAlbumCoverFile, validCoverFileIdForMatches } from "@/lib/album-cover";
import type { QueryAlbum } from "@/lib/query-albums";
import { serializeTagFilter } from "@/lib/query-albums";
import { emptyTagFilter } from "@/lib/tag-filter";
import { bareFile } from "@/test-utils/fixtures";

const album = (coverFileId?: number): QueryAlbum => ({
    id: "album-1",
    name: "Test",
    query: serializeTagFilter(emptyTagFilter()),
    coverFileId,
});

describe("resolveAlbumCoverFile", () => {
    it("returns newest match when no custom cover is set", () => {
        const matches = [bareFile(10), bareFile(20)];
        expect(resolveAlbumCoverFile(album(), matches)?.id).toBe(10);
    });

    it("uses custom cover when it is still in matches", () => {
        const matches = [bareFile(10), bareFile(20)];
        expect(resolveAlbumCoverFile(album(20), matches)?.id).toBe(20);
    });

    it("falls back to newest when custom cover is missing", () => {
        const matches = [bareFile(10)];
        expect(resolveAlbumCoverFile(album(99), matches)?.id).toBe(10);
    });
});

describe("validCoverFileIdForMatches", () => {
    it("keeps a cover id that is still in matches", () => {
        expect(validCoverFileIdForMatches(20, [bareFile(10), bareFile(20)])).toBe(20);
    });

    it("drops a cover id that is no longer in matches", () => {
        expect(validCoverFileIdForMatches(20, [bareFile(10)])).toBeUndefined();
    });
});
