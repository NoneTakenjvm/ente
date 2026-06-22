import type { EnteFile } from "ente-media/file";
import { compressManageCandidates } from "@/lib/compress";

export interface CompressJobOptions {
    files: EnteFile[];
    fileIds?: Set<number>;
    includePreviouslyCompressed?: boolean;
    quality: number;
    videoCrf: number;
    signal: AbortSignal;
    shouldPause: () => boolean;
    onProgress: (current: number, total: number) => void;
    compressFile: (
        fileId: number,
        options: { quality: number; videoCrf: number },
    ) => Promise<unknown>;
}

export interface CompressJobResult {
    completed: number;
    failed: number;
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
        errors: [],
    };

    options.onProgress(0, candidates.length);

    for (let index = 0; index < candidates.length; index++) {
        if (options.signal.aborted || options.shouldPause()) {
            break;
        }

        const file = candidates[index];
        try {
            await options.compressFile(file.id, {
                quality: options.quality,
                videoCrf: options.videoCrf,
            });
            result.completed += 1;
        } catch (error: unknown) {
            result.failed += 1;
            result.errors.push(
                error instanceof Error ?
                    `${file.id}: ${error.message}` :
                    `${file.id}: compress failed`,
            );
        }

        options.onProgress(index + 1, candidates.length);
    }

    return result;
};
