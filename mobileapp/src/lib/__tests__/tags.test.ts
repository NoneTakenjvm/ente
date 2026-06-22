import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    buildTagIndex,
    describeTagFilter,
    extractTags,
    extractUserTags,
    filterFilesByTags,
    countFilesMatchingTagFilter,
    isSystemTag,
    tagIndexToMaps,
} from "@/lib/tags";

const fileWithTags = (id: number, tags: string[]): EnteFile =>
    ({
        id,
        collectionID: 1,
        key: "key",
        metadata: {
            fileType: 0,
            title: "photo.jpg",
            creationTime: 1,
            modificationTime: 1,
        },
        pubMagicMetadata: {
            version: 1,
            count: 1,
            data: {
                _organizer_v1: { tags, updatedAt: 1 },
            },
        },
    }) as unknown as EnteFile;

const include = (tag: string) => ({
    tag,
    mode: "include" as const,
    join: "and" as const,
});

const exclude = (tag: string, join: "and" | "or" = "and") => ({
    tag,
    mode: "exclude" as const,
    join,
});

describe("tags", () => {
    it("extractTags reads _organizer_v1.tags", () => {
        expect(extractTags(fileWithTags(1, ["selfie", "vietnam"]))).toEqual([
            "selfie",
            "vietnam",
        ]);
    });

    it("extractUserTags hides system tags", () => {
        expect(
            extractUserTags(
                fileWithTags(1, ["vacation", "compressed", "rotated", "cropped"]),
            ),
        ).toEqual(["vacation"]);
        expect(isSystemTag("compressed")).toBe(true);
        expect(isSystemTag("vacation")).toBe(false);
    });

    it("buildTagIndex maps tags to file ids", () => {
        const index = buildTagIndex([
            fileWithTags(1, ["selfie", "compressed"]),
            fileWithTags(2, ["selfie", "vietnam"]),
        ]);
        expect(index.tags).toEqual(["selfie", "vietnam"]);
        expect(index.fileIdsByTag.selfie).toEqual([1, 2]);
        expect(index.fileIdsByTag.vietnam).toEqual([2]);
    });

    it("filterFilesByTags uses AND semantics for include clauses", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["selfie", "vietnam"]),
            fileWithTags(3, ["vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: false,
                clauses: [include("selfie"), include("vietnam")],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([2]);
    });

    it("filterFilesByTags supports OR between include clauses", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["vietnam"]),
            fileWithTags(3, ["beach"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: false,
                clauses: [
                    include("selfie"),
                    { tag: "vietnam", mode: "include", join: "or" },
                ],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([1, 2]);
    });

    it("filterFilesByTags supports include and exclude together", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["selfie", "vietnam"]),
            fileWithTags(3, ["selfie", "beach"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: false,
                clauses: [include("selfie"), exclude("vietnam")],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([1, 3]);
    });

    it("filterFilesByTags supports exclude-only filters", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: false,
                clauses: [exclude("vietnam")],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([1]);
    });

    it("countFilesMatchingTagFilter counts intersection in candidate set", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["selfie", "vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        expect(
            countFilesMatchingTagFilter(
                new Set([1, 2]),
                {
                    untagged: false,
                    tagged: false,
                    clauses: [include("selfie"), include("vietnam")],
                },
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("filterFilesByTags supports untagged pseudo-tag", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
            ({ ...fileWithTags(3, []), pubMagicMetadata: undefined }) as EnteFile,
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            { untagged: true, tagged: false, clauses: [] },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([1, 3]);
    });

    it("countFilesMatchingTagFilter counts untagged files in candidate set", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        expect(
            countFilesMatchingTagFilter(
                new Set([1, 2]),
                { untagged: true, tagged: false, clauses: [] },
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("filterFilesByTags supports tagged filter for all tagged files", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
            fileWithTags(3, ["vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            { untagged: false, tagged: true, clauses: [] },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([2, 3]);
    });

    it("filterFilesByTags combines tagged scope with exclude clauses", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: true,
                clauses: [exclude("selfie")],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([2]);
    });

    it("filterFilesByTags combines tagged scope with include clauses", () => {
        const files = [
            fileWithTags(1, ["selfie"]),
            fileWithTags(2, ["vietnam"]),
            fileWithTags(3, ["selfie", "vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                untagged: false,
                tagged: true,
                clauses: [include("selfie")],
            },
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id)).toEqual([1, 3]);
    });

    it("countFilesMatchingTagFilter counts tagged files in candidate set", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        expect(
            countFilesMatchingTagFilter(
                new Set([1, 2]),
                { untagged: false, tagged: true, clauses: [] },
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("describeTagFilter formats include, exclude, and join clauses", () => {
        expect(
            describeTagFilter({
                untagged: true,
                tagged: false,
                clauses: [include("selfie"), exclude("vietnam")],
            }),
        ).toBe("untagged, selfie, AND not vietnam");
    });
});
