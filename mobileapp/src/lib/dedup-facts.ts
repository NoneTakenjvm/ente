import type { EnteFile } from "ente-media/file";
import { fileCreationPhotoDate } from "ente-media/file-metadata";
import { fileByteSize } from "@/lib/compress";
import { filePixelSize } from "@/lib/file-aspect-ratio";
import { formatFileSize } from "@/lib/format";

/** What a duplicate-review tile shows about one photo. */
export interface DedupItemFacts {
    /** "4032 × 3024", when the file records its pixel size. */
    dimensions?: string;
    /** Formatted file size, when known. */
    size?: string;
    /** Image quality as a percent, when the library scan has scored it. */
    quality?: number;
    isFavorite: boolean;
    takenAt: string;
    /** The group's strictly largest photo by pixel count. */
    hasMostPixels: boolean;
    /** The group's strictly largest file by byte size. */
    isLargestFile: boolean;
    /** The group's strictly highest-scored photo. */
    hasBestQuality: boolean;
}

/**
 * Facts for each of a group's files, in order, flagging which file leads on
 * each measure so close calls can be compared at a glance. A measure leads
 * only when it is known for every file and one file beats the rest.
 */
export const dedupGroupFacts = (
    files: readonly EnteFile[],
    favoriteFileIds: ReadonlySet<number>,
    qualityById: ReadonlyMap<number, number>,
): DedupItemFacts[] => {
    const pixels = files.map((file) => {
        const size = filePixelSize(file);
        return size ? size.width * size.height : undefined;
    });
    const bytes = files.map((file) => fileByteSize(file) || undefined);
    const qualities = files.map((file) => qualityById.get(file.id));
    const pixelLeader = strictLeader(pixels);
    const byteLeader = strictLeader(bytes);
    const qualityLeader = strictLeader(qualities);

    return files.map((file, index) => {
        const size = filePixelSize(file);
        const byteSize = bytes[index];
        const quality = qualities[index];
        return {
            dimensions: size ? `${size.width} × ${size.height}` : undefined,
            size: byteSize ? formatFileSize(byteSize) : undefined,
            quality: quality === undefined ? undefined : Math.round(quality * 100),
            isFavorite: favoriteFileIds.has(file.id),
            takenAt: formatTakenAt(file),
            hasMostPixels: pixelLeader === index,
            isLargestFile: byteLeader === index,
            hasBestQuality: qualityLeader === index,
        };
    });
};

/** Index of the one largest value, or `undefined` when any is unknown or the top is tied. */
const strictLeader = (
    values: ReadonlyArray<number | undefined>,
): number | undefined => {
    if (values.length < 2 || values.some((value) => value === undefined)) {
        return undefined;
    }
    const known = values as number[];
    const top = Math.max(...known);
    const leaders = known.flatMap((value, index) =>
        value === top ? [index] : []);
    return leaders.length === 1 ? leaders[0] : undefined;
};

const formatTakenAt = (file: EnteFile): string =>
    fileCreationPhotoDate(file).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
