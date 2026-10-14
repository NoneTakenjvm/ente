import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    eligibleImageFiles,
    progressReporter,
    runWithConcurrency,
    waitIfPaused,
    workerCount,
} from "@/lib/job-utils";

const userId = 1;

const imageFile = (id: number, archived = false): EnteFile =>
    ({
        id,
        ownerID: userId,
        collectionID: 1,
        metadata: {
            fileType: FileType.image,
            title: `photo-${id}.jpg`,
            creationTime: id,
            modificationTime: id,
        },
        magicMetadata: archived ?
            {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            } :
            undefined,
    }) as unknown as EnteFile;

afterEach(() => {
    vi.useRealTimers();
});

describe("eligibleImageFiles", () => {
    it("keeps owned still images and skips archived", () => {
        const files = [
            imageFile(1),
            imageFile(2, true),
            {
                ...imageFile(3),
                ownerID: 99,
            } as EnteFile,
            {
                ...imageFile(4),
                metadata: {
                    fileType: FileType.video,
                    title: "clip.mp4",
                    creationTime: 4,
                    modificationTime: 4,
                },
            } as EnteFile,
        ];
        expect(eligibleImageFiles(files, userId).map((file) => file.id)).toEqual(
            [1],
        );
    });
});

describe("workerCount", () => {
    it("stays within 2 to 8", () => {
        expect(workerCount()).toBeGreaterThanOrEqual(2);
        expect(workerCount()).toBeLessThanOrEqual(8);
    });
});

describe("runWithConcurrency", () => {
    it("processes every item without exceeding the limit", async () => {
        let running = 0;
        let peak = 0;
        const seen: number[] = [];
        await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 1));
            seen.push(item);
            running -= 1;
        });
        expect(peak).toBe(3);
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});

describe("waitIfPaused", () => {
    it("returns false immediately when not paused", async () => {
        expect(await waitIfPaused(() => false)).toBe(false);
    });

    it("resolves false once the pause ends", async () => {
        vi.useFakeTimers();
        let paused = true;
        const result = waitIfPaused(() => paused);
        await vi.advanceTimersByTimeAsync(400);
        paused = false;
        await vi.advanceTimersByTimeAsync(200);
        expect(await result).toBe(false);
    });

    it("resolves true when aborted while paused", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const result = waitIfPaused(() => true, controller.signal);
        controller.abort();
        await vi.advanceTimersByTimeAsync(200);
        expect(await result).toBe(true);
    });

    it("reports an already aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await waitIfPaused(undefined, controller.signal)).toBe(true);
    });
});

describe("progressReporter", () => {
    it("emits the first call, throttles the rest, and honours force", () => {
        let now = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const emit = vi.fn();
        const report = progressReporter(200, emit);

        report();
        now += 50;
        report();
        expect(emit).toHaveBeenCalledTimes(1);

        now += 200;
        report();
        expect(emit).toHaveBeenCalledTimes(2);

        now += 10;
        report(true);
        expect(emit).toHaveBeenCalledTimes(3);
        vi.restoreAllMocks();
    });
});
