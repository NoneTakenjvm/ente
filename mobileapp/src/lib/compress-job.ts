import type { EnteFile } from "ente-media/file";
import {
    compressManageCandidates,
    CompressionSkippedError,
} from "@/lib/compress";
import { fileFileName } from "ente-media/file-metadata";
import { errorMessage } from "@/lib/format";
import type { CompressEncoder } from "@/lib/transcode/compress-media";

export type CompressJobStage =
    "download" |
    "compress" |
    "upload" |
    "skip" |
    "done" |
    "error";

export interface CompressJobStageUpdate {
    stage: CompressJobStage;
    fileId: number;
    fileLabel: string;
    /** 1-based index of the file currently being processed (or just finished). */
    current: number;
    total: number;
    /** 0–1 within the current stage when known. */
    ratio?: number;
    encoder?: CompressEncoder;
}

export interface CompressJobOptions {
    files: EnteFile[];
    fileIds?: Set<number>;
    includePreviouslyCompressed?: boolean;
    quality: number;
    videoCrf: number;
    minSizeBytes?: number;
    maxLongEdge?: number;
    signal: AbortSignal;
    shouldPause: () => boolean;
    onProgress: (update: CompressJobStageUpdate) => void;
    /** Download and decrypt the original bytes of {@link file}. */
    downloadFile: (
        file: EnteFile,
        onProgress: (ratio?: number) => void,
    ) => Promise<Uint8Array>;
    /**
     * Compress {@link bytes} and start the replacement upload. Resolves once
     * compression is done; `finalize` settles when the upload does.
     */
    compressFile: (
        fileId: number,
        bytes: Uint8Array,
        options: {
            quality: number;
            videoCrf: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            /** Aborts compression between its stages when the job is paused or stopped. */
            signal?: AbortSignal;
            onStage?: (
                stage: "compress" | "upload",
                ratio?: number,
                encoder?: CompressEncoder,
            ) => void;
        },
    ) => Promise<{ finalize: Promise<unknown> }>;
}

export interface CompressJobResult {
    completed: number;
    failed: number;
    skipped: number;
    errors: string[];
}

type StageReporter = (
    stage: CompressJobStage,
    ratio?: number,
    encoder?: CompressEncoder,
) => void;

/** Originals up to this size are downloaded while the previous file compresses. */
const PREFETCH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Run a batch compression job, compressing one file at a time.
 *
 * [Note: Compress job pipeline]
 *
 * While file N compresses, file N+1 downloads (when small enough to hold both
 * in memory) and file N-1 finishes uploading. N-1's upload must settle before
 * N+1 starts compressing, so at most two uploads run at once and compressed
 * copies cannot pile up on a slow network. Progress is only reported for the
 * newest file.
 */
export const runCompressJob = async (
    options: CompressJobOptions,
): Promise<CompressJobResult> => {
    const candidates = options.fileIds ?
        options.files.filter((file) => options.fileIds?.has(file.id)) :
        compressManageCandidates(
            options.files,
            options.includePreviouslyCompressed ?? false,
        );

    const result: CompressJobResult = {
        completed: 0,
        failed: 0,
        skipped: 0,
        errors: [],
    };

    const total = candidates.length;
    options.onProgress({
        stage: "download",
        fileId: 0,
        fileLabel: "",
        current: 0,
        total,
    });

    let activeIndex = -1;
    const stageReporter = (index: number, file: EnteFile): StageReporter => {
        const fileLabel = fileFileName(file);
        return (stage, ratio, encoder) => {
            if (index !== activeIndex) {
                return;
            }
            options.onProgress({
                stage,
                fileId: file.id,
                fileLabel,
                current: index + 1,
                total,
                ratio,
                encoder,
            });
        };
    };

    const recordFailure = (
        file: EnteFile,
        report: StageReporter,
        error: unknown,
    ): void => {
        if (error instanceof CompressionSkippedError) {
            result.skipped += 1;
            report("skip");
            return;
        }
        result.failed += 1;
        result.errors.push(
            `${file.id}: ${errorMessage(error, "compress failed")}`,
        );
        report("error");
    };

    const startDownload = (index: number): Promise<Uint8Array> => {
        const file = candidates[index]!;
        const report = stageReporter(index, file);
        return options.downloadFile(file, (ratio) => {
            report("download", ratio);
        });
    };

    const prefetchDownload = (index: number): Promise<Uint8Array> | undefined => {
        const file = candidates[index];
        if (!file || (file.info?.fileSize ?? Infinity) > PREFETCH_MAX_BYTES) {
            return undefined;
        }
        const download = startDownload(index);
        // Errors surface when the loop awaits it; this covers a pause before then.
        void download.catch(() => undefined);
        return download;
    };

    let prefetched: Promise<Uint8Array> | undefined;
    let previousUpload: Promise<void> = Promise.resolve();

    for (let index = 0; index < candidates.length; index++) {
        if (options.signal.aborted || options.shouldPause()) {
            break;
        }

        const file = candidates[index]!;
        activeIndex = index;
        const report = stageReporter(index, file);
        try {
            const download = prefetched ?? startDownload(index);
            prefetched = undefined;
            const bytes = await download;
            if (options.signal.aborted || options.shouldPause()) {
                break;
            }
            prefetched = prefetchDownload(index + 1);
            const { finalize } = await options.compressFile(file.id, bytes, {
                quality: options.quality,
                videoCrf: options.videoCrf,
                minSizeBytes: options.minSizeBytes,
                maxLongEdge: options.maxLongEdge,
                signal: options.signal,
                onStage: report,
            });
            await previousUpload;
            previousUpload = finalize.then(
                () => {
                    result.completed += 1;
                    report("done", 1);
                },
                (error: unknown) => {
                    recordFailure(file, report, error);
                },
            );
        } catch (error: unknown) {
            // A file interrupted by pause/stop is not a failure.
            if (options.signal.aborted) {
                break;
            }
            recordFailure(file, report, error);
        }
    }

    await previousUpload;
    return result;
};
