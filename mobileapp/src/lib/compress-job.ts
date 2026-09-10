import type { EnteFile } from "ente-media/file";
import {
    compressManageCandidates,
    CompressionSkippedError,
} from "@/lib/compress";
import { fileFileName } from "ente-media/file-metadata";
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
    compressFile: (
        fileId: number,
        options: {
            quality: number;
            videoCrf: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            onStage?: (
                stage: "download" | "compress" | "upload",
                ratio?: number,
                encoder?: CompressEncoder,
            ) => void;
        },
    ) => Promise<unknown>;
}

export interface CompressJobResult {
    completed: number;
    failed: number;
    skipped: number;
    errors: string[];
}

export const compressibleFiles = (
    files: EnteFile[],
    includePreviouslyCompressed = false,
): EnteFile[] => compressManageCandidates(files, includePreviouslyCompressed);

/**
 * Run a sequential batch compression job over the given files.
 */
export const runCompressJob = async (
    options: CompressJobOptions,
): Promise<CompressJobResult> => {
    const candidates = options.fileIds ?
        options.files.filter((file) => options.fileIds?.has(file.id)) :
        compressibleFiles(
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

    for (let index = 0; index < candidates.length; index++) {
        if (options.signal.aborted || options.shouldPause()) {
            break;
        }

        const file = candidates[index]!;
        const fileLabel = fileFileName(file);
        const current = index + 1;
        try {
            await options.compressFile(file.id, {
                quality: options.quality,
                videoCrf: options.videoCrf,
                minSizeBytes: options.minSizeBytes,
                maxLongEdge: options.maxLongEdge,
                onStage: (stage, ratio, encoder) => {
                    options.onProgress({
                        stage,
                        fileId: file.id,
                        fileLabel,
                        current,
                        total,
                        ratio,
                        encoder,
                    });
                },
            });
            result.completed += 1;
            options.onProgress({
                stage: "done",
                fileId: file.id,
                fileLabel,
                current,
                total,
                ratio: 1,
            });
        } catch (error: unknown) {
            if (error instanceof CompressionSkippedError) {
                result.skipped += 1;
                options.onProgress({
                    stage: "skip",
                    fileId: file.id,
                    fileLabel,
                    current,
                    total,
                });
            } else {
                result.failed += 1;
                result.errors.push(
                    error instanceof Error ?
                        `${file.id}: ${error.message}` :
                        `${file.id}: compress failed`,
                );
                options.onProgress({
                    stage: "error",
                    fileId: file.id,
                    fileLabel,
                    current,
                    total,
                });
            }
        }
    }

    return result;
};
