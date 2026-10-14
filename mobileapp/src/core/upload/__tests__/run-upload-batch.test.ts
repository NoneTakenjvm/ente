import { afterEach, describe, expect, it, vi } from "vitest";
import {
    runUploadBatch,
    type UploadBatchEntry,
    type UploadBatchProgress,
    type UploadBatchUploaders,
} from "@/core/upload/run-upload-batch";

vi.mock("@/core/instance", () => ({
    getEnteCore: () => ({ getHttpClient: () => ({}) }),
}));
vi.mock("@/core/upload/remote", () => ({
    abortUploadBatch: vi.fn(),
    beginUploadAbort: vi.fn(),
    endUploadAbort: vi.fn(),
}));
vi.mock("@/core/upload/upload-url-pool", () => ({
    beginUploadBatch: vi.fn(async () => undefined),
    endUploadBatch: vi.fn(),
}));
vi.mock("@/core/upload/upload-crypto-pool", () => ({
    beginUploadCryptoPool: vi.fn(),
    endUploadCryptoPool: vi.fn(),
    getUploadCryptoWorker: vi.fn(async () => ({})),
}));
vi.mock("@/lib/prepare-local-image", () => ({
    prepareLocalImage: vi.fn(async () => ({
        bytes: new Uint8Array(1),
        width: 1,
        height: 1,
    })),
}));
vi.mock("@/lib/transcode/prepare-local-video", () => ({
    prepareLocalVideo: vi.fn(),
}));

const imageEntries = (count: number): UploadBatchEntry[] =>
    Array.from({ length: count }, (_, index) => ({
        file: new File(["x"], `photo-${index}.jpg`, { lastModified: 1 }),
        kind: "image" as const,
    }));

const uploadersWith = (
    uploadImageFile: UploadBatchUploaders["uploadImageFile"],
): UploadBatchUploaders => ({
    uploadImageFile,
    uploadVideoFile: vi.fn(),
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("runUploadBatch", () => {
    it("reports progress and counts completed and failed files", async () => {
        const uploadImageFile = vi.fn(async (_collectionId, _bytes, _dims, title: string) => {
            if (title === "photo-1.jpg") {
                throw new Error("boom");
            }
            return {} as never;
        });
        const progress: UploadBatchProgress[] = [];

        const result = await runUploadBatch(
            imageEntries(3),
            7,
            uploadersWith(uploadImageFile),
            new AbortController().signal,
            (update) => progress.push({ ...update }),
        );

        expect(result).toMatchObject({
            completed: 2,
            failed: 1,
            skipped: 0,
            cancelled: false,
        });
        expect(result.errors).toEqual(["photo-1.jpg: boom"]);
        expect(progress.at(-1)).toEqual({ finished: 3, total: 3, inFlight: 0 });
        expect(Math.max(...progress.map((entry) => entry.inFlight))).toBeLessThanOrEqual(3);
        expect(uploadImageFile.mock.calls[0]![0]).toBe(7);
    });

    it("stops starting new files once aborted", async () => {
        const controller = new AbortController();
        const uploadImageFile = vi.fn(async () => {
            controller.abort();
            return {} as never;
        });

        const result = await runUploadBatch(
            imageEntries(12),
            1,
            uploadersWith(uploadImageFile),
            controller.signal,
            () => undefined,
        );

        expect(result.cancelled).toBe(true);
        expect(result.completed).toBeLessThan(12);
        expect(result.completed + result.skipped).toBe(12);
        expect(result.failed).toBe(0);
    });
});
