import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    buildTagIndex,
    createEmptyTagFilterRoot,
    describeTagFilter,
    emptyTagFilter,
    extractTags,
    extractUserTags,
    filterFilesByTags,
    countFilesMatchingTagFilter,
    isSystemTag,
    newTagFilterNodeId,
    tagIndexToMaps,
    type TagFilterClauseNode,
    type TagFilterGroup,
    type TagFilterSelection,
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

const includeClause = (tag: string): TagFilterClauseNode => ({
    kind: "clause",
    id: newTagFilterNodeId(),
    tag,
    mode: "include",
});

const excludeClause = (tag: string): TagFilterClauseNode => ({
    kind: "clause",
    id: newTagFilterNodeId(),
    tag,
    mode: "exclude",
});

const andRoot = (...children: TagFilterGroup["children"]): TagFilterGroup => ({
    kind: "group",
    id: newTagFilterNodeId(),
    op: "and",
    children,
});

const orRoot = (...children: TagFilterGroup["children"]): TagFilterGroup => ({
    kind: "group",
    id: newTagFilterNodeId(),
    op: "or",
    children,
});

const filterWithRoot = (
    root: TagFilterGroup,
    overrides: Partial<TagFilterSelection> = {},
): TagFilterSelection => ({
    ...emptyTagFilter(),
    root,
    ...overrides,
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
                fileWithTags(1, [
                    "vacation",
                    "compressed",
                    "rotated",
                    "cropped",
                    "auto-cropped",
                ]),
            ),
        ).toEqual(["vacation"]);
        expect(isSystemTag("compressed")).toBe(true);
        expect(isSystemTag("auto-cropped")).toBe(true);
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
            filterWithRoot(
                andRoot(includeClause("selfie"), includeClause("vietnam")),
            ),
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
            filterWithRoot(
                orRoot(includeClause("selfie"), includeClause("vietnam")),
            ),
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
            filterWithRoot(
                andRoot(includeClause("selfie"), excludeClause("vietnam")),
            ),
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
            filterWithRoot(andRoot(excludeClause("vietnam"))),
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
                filterWithRoot(
                    andRoot(includeClause("selfie"), includeClause("vietnam")),
                ),
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("filterFilesByTags supports untagged scope", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
            ({ ...fileWithTags(3, []), pubMagicMetadata: undefined }) as EnteFile,
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                tagScope: "untagged",
                favoritesScope: "all",
                mediaScope: "all",
                croppedScope: "all",
                root: createEmptyTagFilterRoot(),
            },
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
                {
                    tagScope: "untagged",
                    favoritesScope: "all",
                    mediaScope: "all",
                    croppedScope: "all",
                    root: createEmptyTagFilterRoot(),
                },
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("filterFilesByTags supports tagged scope for all tagged files", () => {
        const files = [
            fileWithTags(1, []),
            fileWithTags(2, ["selfie"]),
            fileWithTags(3, ["vietnam"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const filtered = filterFilesByTags(
            files,
            {
                tagScope: "tagged",
                favoritesScope: "all",
                mediaScope: "all",
                croppedScope: "all",
                root: createEmptyTagFilterRoot(),
            },
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
            filterWithRoot(andRoot(excludeClause("selfie")), {
                tagScope: "tagged",
            }),
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
            filterWithRoot(andRoot(includeClause("selfie")), {
                tagScope: "tagged",
            }),
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
                {
                    tagScope: "tagged",
                    favoritesScope: "all",
                    mediaScope: "all",
                    croppedScope: "all",
                    root: createEmptyTagFilterRoot(),
                },
                fileIdsByTag,
                files,
            ),
        ).toBe(1);
    });

    it("filterFilesByTags supports favorites scope", () => {
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
                tagScope: "all",
                favoritesScope: "favorites",
                mediaScope: "all",
                croppedScope: "all",
                root: createEmptyTagFilterRoot(),
            },
            fileIdsByTag,
            { favoriteFileIds: new Set([1, 3]) },
        );
        expect(filtered.map((file) => file.id)).toEqual([1, 3]);
    });

    it("filterFilesByTags supports not-favorites scope", () => {
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
                tagScope: "all",
                favoritesScope: "not-favorites",
                mediaScope: "all",
                croppedScope: "all",
                root: createEmptyTagFilterRoot(),
            },
            fileIdsByTag,
            { favoriteFileIds: new Set([1, 3]) },
        );
        expect(filtered.map((file) => file.id)).toEqual([2]);
    });

    it("filterFilesByTags supports manually-cropped scope", () => {
        const files = [
            fileWithTags(1, ["selfie", "cropped"]),
            fileWithTags(2, ["vietnam", "cropped", "auto-cropped"]),
            fileWithTags(3, ["beach", "auto-cropped"]),
            fileWithTags(4, ["plain"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);
        const cropped = filterFilesByTags(
            files,
            {
                tagScope: "all",
                favoritesScope: "all",
                mediaScope: "all",
                croppedScope: "cropped",
                root: createEmptyTagFilterRoot(),
            },
            fileIdsByTag,
        );
        expect(cropped.map((file) => file.id)).toEqual([1]);

        const notCropped = filterFilesByTags(
            files,
            {
                tagScope: "all",
                favoritesScope: "all",
                mediaScope: "all",
                croppedScope: "not-cropped",
                root: createEmptyTagFilterRoot(),
            },
            fileIdsByTag,
        );
        expect(notCropped.map((file) => file.id)).toEqual([2, 3, 4]);
    });

    it("filterFilesByTags distinguishes grouped (A AND B) OR C from A AND (B OR C)", () => {
        const files = [
            fileWithTags(1, ["a"]),
            fileWithTags(2, ["b"]),
            fileWithTags(3, ["c"]),
            fileWithTags(4, ["a", "b"]),
            fileWithTags(5, ["b", "c"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);

        const groupedAndOr = filterFilesByTags(
            files,
            filterWithRoot(
                orRoot(
                    andRoot(includeClause("a"), includeClause("b")),
                    includeClause("c"),
                ),
            ),
            fileIdsByTag,
        );
        expect(groupedAndOr.map((file) => file.id).sort()).toEqual([3, 4, 5]);

        const andGroupedOr = filterFilesByTags(
            files,
            filterWithRoot(
                andRoot(
                    includeClause("a"),
                    orRoot(includeClause("b"), includeClause("c")),
                ),
            ),
            fileIdsByTag,
        );
        expect(andGroupedOr.map((file) => file.id).sort()).toEqual([4]);
        expect(groupedAndOr.map((file) => file.id).sort()).not.toEqual(
            andGroupedOr.map((file) => file.id).sort(),
        );
    });

    it("describeTagFilter formats scope, favourites, and nested groups", () => {
        expect(
            describeTagFilter({
                tagScope: "untagged",
                favoritesScope: "favorites",
                mediaScope: "all",
                croppedScope: "cropped",
                root: andRoot(includeClause("selfie"), excludeClause("vietnam")),
            }),
        ).toBe(
            "untagged · favourites · manually-cropped · selfie AND not vietnam",
        );

        expect(
            describeTagFilter(
                filterWithRoot(
                    orRoot(
                        andRoot(includeClause("selfie"), includeClause("vietnam")),
                        includeClause("beach"),
                    ),
                ),
            ),
        ).toBe("(selfie AND vietnam) OR beach");
    });

    it("filterFilesByTags supports the same tag in sibling groups with different modes", () => {
        const files = [
            fileWithTags(1, ["vacation"]),
            fileWithTags(2, ["archived"]),
            fileWithTags(3, ["vacation", "archived"]),
        ];
        const index = buildTagIndex(files);
        const { fileIdsByTag } = tagIndexToMaps(index);

        const filtered = filterFilesByTags(
            files,
            filterWithRoot(
                orRoot(
                    andRoot(includeClause("vacation"), excludeClause("archived")),
                    andRoot(includeClause("archived"), excludeClause("vacation")),
                ),
            ),
            fileIdsByTag,
        );
        expect(filtered.map((file) => file.id).sort()).toEqual([1, 2]);
    });
});
