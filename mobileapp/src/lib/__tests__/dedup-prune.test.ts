import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { planDuplicateGroupPrune } from "@/lib/dedup-prune";

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
});
