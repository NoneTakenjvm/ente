import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    eligibleImageFiles,
    jobPercent,
    progressReporter,
    runWithConcurrency,
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

describe("jobPercent", () => {
    it("is 0 when total is 0", () => {
        expect(jobPercent(0, 0)).toBe(0);
    });

    it("rounds current out of total", () => {
        expect(jobPercent(1, 3)).toBe(33);
        expect(jobPercent(3, 3)).toBe(100);
    });

    it("counts the ratio into the current 1-based item", () => {
        expect(jobPercent(2, 4, 0.5)).toBe(38);
    });

    it("clamps to 0-100", () => {
        expect(jobPercent(5, 4)).toBe(100);
        expect(jobPercent(1, 4, -1)).toBe(0);
    });
});
