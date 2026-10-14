import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core/instance";
import { errorMessage } from "@/lib/format";
import {
    sanitizeUploadImageTitle,
    sanitizeUploadVideoTitle,
} from "@/lib/local-media";
import { prepareLocalImage } from "@/lib/prepare-local-image";
import { prepareLocalVideo } from "@/lib/transcode/prepare-local-video";
import { withTimeout } from "@/lib/with-timeout";
import {
    abortUploadBatch,
    beginUploadAbort,
    endUploadAbort,
} from "./remote";
import {
    beginUploadCryptoPool,
    endUploadCryptoPool,
    getUploadCryptoWorker,
    type UploadCryptoWorker,
} from "./upload-crypto-pool";
import { beginUploadBatch, endUploadBatch } from "./upload-url-pool";

export interface UploadBatchEntry {
    file: File;
    kind: "image" | "video";
}

/** Single-file upload entry points, supplied by the caller (library store). */
export interface UploadBatchUploaders {
    uploadImageFile: (
        collectionId: number,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        creationTime: number,
        crypto: UploadCryptoWorker,
    ) => Promise<EnteFile>;
    uploadVideoFile: (
        collectionId: number,
        video: Blob,
        dimensions: { width: number; height: number },
        duration: number,
        title: string,
        creationTime: number,
        mimeType: string,
        crypto: UploadCryptoWorker,
    ) => Promise<EnteFile>;
}

export interface UploadBatchProgress {
    /** Files finished, successfully or not. */
    finished: number;
    total: number;
    inFlight: number;
}

export interface UploadBatchResult {
    completed: number;
    failed: number;
    /** `"<file name>: <message>"` per failed file. */
    errors: string[];
    /** Files neither completed nor failed (cancelled before they started). */
    skipped: number;
    cancelled: boolean;
}

const MAX_CONCURRENT_UPLOADS = 4;
const UPLOAD_URL_TIMEOUT_MS = 30_000;
const CANCELLED_MESSAGE = "Upload cancelled";

/**
 * Upload `entries` into `collectionId` with up to four parallel workers, each
 * on its own crypto worker.
 *
 * Aborting `signal` stops new files from starting and aborts in-flight PUTs.
 * Per-file failures are collected in the result; setup failures (upload URL
 * fetch) reject.
 */
export const runUploadBatch = async (
    entries: UploadBatchEntry[],
    collectionId: number,
    uploaders: UploadBatchUploaders,
    signal: AbortSignal,
    onProgress: (progress: UploadBatchProgress) => void,
): Promise<UploadBatchResult> => {
    let completed = 0;
    let failed = 0;
    let inFlight = 0;
    let nextIndex = 0;
    const errors: string[] = [];

    const throwIfCancelled = (): void => {
        if (signal.aborted) {
            throw new Error(CANCELLED_MESSAGE);
        }
    };

    const reportProgress = (): void => {
        onProgress({
            finished: completed + failed,
            total: entries.length,
            inFlight,
        });
    };

    const uploadEntry = async (
        entry: UploadBatchEntry,
        crypto: UploadCryptoWorker,
    ): Promise<void> => {
        throwIfCancelled();
        if (entry.kind === "video") {
            const prepared = await prepareLocalVideo(entry.file);
            throwIfCancelled();
            await uploaders.uploadVideoFile(
                collectionId,
                prepared.file,
                { width: prepared.width, height: prepared.height },
                prepared.duration,
                sanitizeUploadVideoTitle(entry.file.name),
                entry.file.lastModified * 1000,
                prepared.mimeType,
                crypto,
            );
            return;
        }

        const prepared = await prepareLocalImage(entry.file);
        throwIfCancelled();
        await uploaders.uploadImageFile(
            collectionId,
            prepared.bytes,
            { width: prepared.width, height: prepared.height },
            sanitizeUploadImageTitle(entry.file.name),
            entry.file.lastModified * 1000,
            crypto,
        );
    };

    const runWorker = async (slotIndex: number): Promise<void> => {
        const crypto = await getUploadCryptoWorker(slotIndex);
        while (true) {
            if (signal.aborted) {
                return;
            }
            const index = nextIndex;
            nextIndex += 1;
            if (index >= entries.length) {
                return;
            }
            const entry = entries[index]!;
            inFlight += 1;
            reportProgress();
            try {
                await uploadEntry(entry, crypto);
                completed += 1;
            } catch (uploadError: unknown) {
                const message = errorMessage(uploadError, "upload failed");
                if (/upload cancelled/i.test(message)) {
                    return;
                }
                failed += 1;
                errors.push(`${entry.file.name}: ${message}`);
            } finally {
                inFlight -= 1;
                reportProgress();
            }
        }
    };

    signal.addEventListener("abort", abortUploadBatch);
    try {
        beginUploadAbort();
        await withTimeout(
            beginUploadBatch(getEnteCore().getHttpClient(), entries.length),
            UPLOAD_URL_TIMEOUT_MS,
            "Timed out fetching upload URLs",
        );

        const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, entries.length);
        beginUploadCryptoPool(workerCount);
        await Promise.all(
            Array.from({ length: workerCount }, (_, slotIndex) =>
                runWorker(slotIndex)),
        );

        return {
            completed,
            failed,
            errors,
            skipped: entries.length - completed - failed,
            cancelled: signal.aborted,
        };
    } finally {
        signal.removeEventListener("abort", abortUploadBatch);
        endUploadAbort();
        endUploadBatch();
        endUploadCryptoPool();
    }
};
