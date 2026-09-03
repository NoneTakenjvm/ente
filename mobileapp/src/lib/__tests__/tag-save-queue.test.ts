import { describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import { enqueueTagSave } from "@/lib/tag-save-queue";

const stubFile = (id: number): EnteFile =>
    ({ id }) as unknown as EnteFile;

describe("tag-save-queue", () => {
    it("coalesces rapid saves for the same file into one remote write", async () => {
        const save = vi.fn(async (_tags: string[]) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return stubFile(1);
        });

        const first = enqueueTagSave(1, ["a"], save);
        const second = enqueueTagSave(1, ["a", "b"], save);

        await Promise.all([first, second]);

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith(["a", "b"]);
    });

    it("retries are handled by the save function, not the queue", async () => {
        let attempts = 0;
        const save = vi.fn(async () => {
            attempts += 1;
            if (attempts < 2) {
                throw new Error("transient");
            }
            return stubFile(2);
        });

        await expect(
            enqueueTagSave(2, ["x"], save),
        ).rejects.toThrow("transient");
        expect(save).toHaveBeenCalledTimes(1);
    });
});
