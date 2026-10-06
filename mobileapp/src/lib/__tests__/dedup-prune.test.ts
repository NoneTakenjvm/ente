import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    dedupGroupMembersKey,
    defaultKeeperFileId,
    planDuplicateGroupPrune,
    type DedupGroupItem,
} from "@/lib/dedup-prune";

const file = (id: number, collectionID: number): EnteFile =>
    ({
        id,
        ownerID: 1,
        collectionID,
        key: "key",
        metadata: {
            fileType: 0,
            title: `${id}.jpg`,
            creationTime: 1,
            modificationTime: 1,
        },
    }) as unknown as EnteFile;

describe("dedup-prune", () => {
    it("plans trash for non-keepers and links keeper into missing albums", () => {
        const keeper = file(1, 10);
        const loser = file(2, 20);

        const plan = planDuplicateGroupPrune([
            {
                id: "group-1",
                isSelected: true,
                keeperFileId: keeper.id,
                items: [
                    {
                        file: keeper,
                        collectionIDs: new Set([10]),
                        collectionName: "A",
                    },
                    {
                        file: loser,
                        collectionIDs: new Set([20]),
                        collectionName: "B",
                    },
                ],
            },
        ]);

        expect(plan.filesToTrash.map((entry) => entry.id)).toEqual([2]);
        expect(plan.collectionsToLink.get(20)?.map((entry) => entry.id)).toEqual([
            1,
        ]);
    });

    describe("defaultKeeperFileId", () => {
        const item = (
            id: number,
            data: Record<string, unknown> = {},
            fileSize = 0,
            creationTime = 1,
        ): DedupGroupItem => ({
            file: {
                ...file(id, 10),
                metadata: { ...file(id, 10).metadata, creationTime },
                info: { fileSize },
                pubMagicMetadata: { version: 1, count: 1, data },
            } as unknown as EnteFile,
            collectionIDs: new Set([10]),
            collectionName: "A",
        });
        const context = (
            favorites: number[] = [],
            quality: Array<[number, number]> = [],
        ): {
            favoriteFileIds: Set<number>;
            qualityById: Map<number, number>;
        } => ({
            favoriteFileIds: new Set(favorites),
            qualityById: new Map(quality),
        });

        it("prefers caption, then edits, over favourite and size", () => {
            const items = [
                item(1, { w: 4000, h: 3000 }, 9_000_000),
                item(2, { editedName: "x.jpg" }),
                item(3, { caption: "hi" }),
            ];
            expect(defaultKeeperFileId(items, context([1]))).toBe(3);
            expect(defaultKeeperFileId(items.slice(0, 2), context([1]))).toBe(2);
        });

        it("prefers favourite, then more pixels", () => {
            const items = [
                item(1, { w: 4000, h: 3000 }),
                item(2, { w: 1000, h: 1000 }),
            ];
            expect(defaultKeeperFileId(items, context([2]))).toBe(2);
            expect(defaultKeeperFileId(items, context())).toBe(1);
        });

        it("uses quality only when both are scored, then bytes, then earliest", () => {
            const items = [
                item(1, { w: 10, h: 10 }, 500, 5),
                item(2, { w: 10, h: 10 }, 100, 1),
            ];
            expect(defaultKeeperFileId(items, context([], [[2, 0.9], [1, 0.4]]))).toBe(2);
            // One unscored file: quality is skipped, bytes decide.
            expect(defaultKeeperFileId(items, context([], [[2, 0.9]]))).toBe(1);
            const sameBytes = [item(1, {}, 100, 5), item(2, {}, 100, 1)];
            expect(defaultKeeperFileId(sameBytes)).toBe(2);
        });

        it("keys groups by sorted members", () => {
            expect(dedupGroupMembersKey([item(30), item(4), item(100)])).toBe(
                "4-30-100",
            );
        });
    });
});
