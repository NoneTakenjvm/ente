import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    enqueueDerivedReplace,
    isDerivedReplaceInFlight,
    resetDerivedReplaceQueueForTests,
} from "@/lib/derived-replace-queue";
import { stubFile } from "@/test-utils/fixtures";

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
            return stubFile({ id: 30, collectionID: 10 });
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

        resolveFirstSave?.(stubFile({ id: 20, collectionID: 10 }));
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
            async () => stubFile({ id: 99, collectionID: 10 }),
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

    it("resolves the saved waiter and rejects the failed one when a coalesce save fails", async () => {
        let saveCount = 0;
        let resolveFirst: ((file: EnteFile) => void) | undefined;
        const firstSave = new Promise<EnteFile>((resolve) => {
            resolveFirst = resolve;
        });
        const firstCompleted = vi.fn(async () => undefined);
        const secondCompleted = vi.fn(async () => undefined);
        const secondFailed = vi.fn(async () => undefined);

        const first = enqueueDerivedReplace(
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
            { onCompleted: firstCompleted },
        );

        await vi.waitFor(() => expect(saveCount).toBe(1));

        const second = enqueueDerivedReplace(
            7,
            new Uint8Array([2]),
            { width: 2, height: 2 },
            async () => {
                throw new Error("should use same save from first enqueue");
            },
            { onCompleted: secondCompleted, onFailed: secondFailed },
        );
        const secondOutcome = expect(second).rejects.toThrow("second failed");

        resolveFirst?.(stubFile({ id: 70, collectionID: 10 }));
        await expect(first).resolves.toMatchObject({ id: 70 });
        await secondOutcome;
        expect(saveCount).toBe(2);
        expect(firstCompleted).not.toHaveBeenCalled();
        expect(secondCompleted).not.toHaveBeenCalled();
        expect(secondFailed).toHaveBeenCalledWith(
            expect.objectContaining({ message: "second failed" }),
            expect.objectContaining({ id: 70 }),
        );
    });

    it("completes with the latest enqueue's options", async () => {
        let resolveFirst: ((file: EnteFile) => void) | undefined;
        let saveCount = 0;
        const save = async (): Promise<EnteFile> => {
            saveCount += 1;
            if (saveCount === 1) {
                return new Promise<EnteFile>((resolve) => {
                    resolveFirst = resolve;
                });
            }
            return stubFile({ id: 90, collectionID: 10 });
        };
        const firstCompleted = vi.fn(async () => undefined);
        const secondCompleted = vi.fn(async () => undefined);

        const first = enqueueDerivedReplace(
            8,
            new Uint8Array([1]),
            { width: 1, height: 1 },
            save,
            { onCompleted: firstCompleted },
        );
        await vi.waitFor(() => expect(saveCount).toBe(1));
        const second = enqueueDerivedReplace(
            8,
            new Uint8Array([2]),
            { width: 2, height: 2 },
            save,
            { onCompleted: secondCompleted },
        );

        resolveFirst?.(stubFile({ id: 80, collectionID: 10 }));
        await Promise.all([first, second]);
        expect(firstCompleted).not.toHaveBeenCalled();
        expect(secondCompleted).toHaveBeenCalledWith(
            expect.objectContaining({ id: 90 }),
        );
    });
});
