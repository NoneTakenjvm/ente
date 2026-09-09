import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import { sortFilesByUpdatedAt } from "@/lib/updated-at-sort";

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

describe("sortFilesByUpdatedAt", () => {
    it("returns a copy unchanged for none", () => {
        const files = [stubFile({ id: 1 }), stubFile({ id: 2 })];
        const ordered = sortFilesByUpdatedAt(files, "none");
        expect(ordered.map((f) => f.id)).toEqual([1, 2]);
        expect(ordered).not.toBe(files);
    });

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
        expect(
            sortFilesByUpdatedAt([older, newer], "newest").map((f) => f.id),
        ).toEqual([2, 1]);
    });

    it("sorts oldest update first", () => {
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
        expect(
            sortFilesByUpdatedAt([newer, older], "oldest").map((f) => f.id),
        ).toEqual([1, 2]);
    });
});
