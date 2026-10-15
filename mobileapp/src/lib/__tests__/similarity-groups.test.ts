import { describe, expect, it } from "vitest";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    similarCandidateFiles,
    similarityGroupsFromIds,
} from "@/lib/similarity-groups";
import { axis, embMap, stubFile } from "@/test-utils/fixtures";

const stubCollection = (id: number): Collection => ({
    id,
    name: `collection-${id}`,
    type: "uncategorized",
    owner: { id: 1, email: "", role: "" },
    key: "key",
    sharees: [],
    publicURLs: [],
    updationTime: id,
});

const collections = [stubCollection(1)];

describe("similarCandidateFiles", () => {
    it("keeps owned, non-archived stills that have a CLIP vector", () => {
        const archived = stubFile({
            id: 2,
            magicMetadata: { version: 1, count: 1, data: { visibility: 1 } },
        } as Partial<EnteFile>);
        const video = stubFile({
            id: 3,
            metadata: { ...stubFile().metadata, fileType: FileType.video },
        });
        const files = [
            stubFile({ id: 1 }),
            archived,
            video,
            stubFile({ id: 4, ownerID: 2 }),
            stubFile({ id: 5, collectionID: 9 }),
            stubFile({ id: 6 }),
        ];
        const embeddings = embMap(
            [1, 2, 3, 4, 5].map((id) => [id, axis(0)]),
        );
        const candidates = similarCandidateFiles(
            files,
            embeddings,
            collections,
            1,
        );
        expect(candidates.map((file) => file.id)).toEqual([1]);
    });

    it("lists a file id once even when it appears in several entries", () => {
        const files = [stubFile({ id: 1 }), stubFile({ id: 1 })];
        const candidates = similarCandidateFiles(
            files,
            embMap([[1, axis(0)]]),
            collections,
            1,
        );
        expect(candidates).toHaveLength(1);
    });
});

describe("similarityGroupsFromIds", () => {
    it("skips unknown files and groups left with one file", () => {
        const filesById = new Map(
            [1, 2, 3].map((id) => [id, stubFile({ id })]),
        );
        const groups = similarityGroupsFromIds(
            [
                [1, 2],
                [3, 99],
            ],
            filesById,
            collections,
            1,
        );
        expect(groups.map((group) => group.items.map((item) => item.file.id))).toEqual([
            [1, 2],
        ]);
    });
});
