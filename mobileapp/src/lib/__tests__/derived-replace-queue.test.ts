import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    enqueueDerivedReplace,
    isDerivedReplaceInFlight,
    resetDerivedReplaceQueueForTests,
} from "@/lib/derived-replace-queue";

const stubFile = (id: number): EnteFile =>
    ({
        id,
        ownerID: 1,
        collectionID: 10,
        key: "key",
        metadata: { fileType: 0 },
    }) as EnteFile;

describe("derived-replace-queue", () => {
    beforeEach(() => {
        resetDerivedReplaceQueueForTests();
    });

    it("coalesce replaces the intermediate upload id, not the original", async () => {
        const replaceIds: number[] = [];
        let resolveFirstSave: ((file: EnteFile) => void) | undefined;
        const firstSave = new Promise<EnteFile>((resolve) => {
            resolveFirstSave = resolve;
        });
        let saveCount = 0;

        const save = async (
            _bytes: Uint8Array,
            _dims: { width: number; height: number },
            replaceFileId: number,
        ): Promise<EnteFile> => {
            replaceIds.push(replaceFileId);
            saveCount += 1;
            if (saveCount === 1) {
                return firstSave;
            }
            return stubFile(30);
        };

        const first = enqueueDerivedReplace(
            1,
            new Uint8Array([1]),
            { width: 10, height: 10 },
            save,
        );

        await vi.waitFor(() => expect(saveCount).toBe(1));

        const second = enqueueDerivedReplace(
            1,
            new Uint8Array([2]),
            { width: 20, height: 20 },
            save,
        );

        resolveFirstSave?.(stubFile(20));
        const [a, b] = await Promise.all([first, second]);
        expect(a.id).toBe(30);
        expect(b.id).toBe(30);
        expect(replaceIds).toEqual([1, 20]);
        expect(isDerivedReplaceInFlight(1)).toBe(false);
    });

    it("runs onCompleted before waiters resolve", async () => {
        const order: string[] = [];
        const done = enqueueDerivedReplace(
            5,
            new Uint8Array([1]),
            { width: 1, height: 1 },
            async () => stubFile(99),
            {
                onCompleted: async () => {
                    order.push("completed");
                },
            },
        ).then((file) => {
            order.push(`resolved:${file.id}`);
            return file;
        });

        await done;
        expect(order).toEqual(["completed", "resolved:99"]);
    });

    it("keeps the last successful upload when a coalesce save fails", async () => {
        let saveCount = 0;
        let resolveFirst: ((file: EnteFile) => void) | undefined;
        const firstSave = new Promise<EnteFile>((resolve) => {
            resolveFirst = resolve;
        });

        const promise = enqueueDerivedReplace(
            7,
            new Uint8Array([1]),
            { width: 1, height: 1 },
            async (_bytes, _dims, replaceFileId) => {
                saveCount += 1;
                if (saveCount === 1) {
                    expect(replaceFileId).toBe(7);
                    return firstSave;
                }
                throw new Error("second failed");
            },
        );

        await vi.waitFor(() => expect(saveCount).toBe(1));

        void enqueueDerivedReplace(
            7,
            new Uint8Array([2]),
            { width: 2, height: 2 },
            async () => {
                throw new Error("should use same save from first enqueue");
            },
        );

        resolveFirst?.(stubFile(70));
        await expect(promise).resolves.toMatchObject({ id: 70 });
        expect(saveCount).toBe(2);
    });
});
