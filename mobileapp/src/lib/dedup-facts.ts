import type { EnteFile } from "ente-media/file";
import { fileCreationPhotoDate } from "ente-media/file-metadata";
import { fileUploadSortTime } from "@/core/metadata";
import { fileByteSize } from "@/lib/compress";
import type { DedupGroupItem } from "@/lib/dedup-prune";
import { filePixelSize } from "@/lib/file-aspect-ratio";
import { formatFileSize, formatTimeAgo } from "@/lib/format";
import { extractUserTags } from "@/lib/tags";

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
    /** When the photo was first uploaded, e.g. "3h ago". */
    uploadedAt: string;
    /** When the photo was last edited, if that was after its upload. */
    editedAt?: string;
    album: string;
    /** The photo's user tags; cleanup copies a trashed photo's to the keeper. */
    tags: DedupTag[];
    /** The group's strictly largest photo by pixel count. */
    hasMostPixels: boolean;
    /** The group's strictly largest file by byte size. */
    isLargestFile: boolean;
    /** The group's strictly highest-scored photo. */
    hasBestQuality: boolean;
}

interface DedupTag {
    name: string;
    /** No other photo in the group has this tag. */
    onlyHere: boolean;
}

/** Edits within this long of the upload are the upload itself (microseconds). */
const editAfterUploadMicros = 60 * 1000 * 1000;

/**
 * Facts for each of a group's photos, in order, flagging which photo leads on
 * each measure so close calls can be compared at a glance. A measure leads
 * only when it is known for every photo and one photo beats the rest.
 *
 * @param now epoch milliseconds that upload and edit ages count from
 */
export const dedupGroupFacts = (
    items: readonly DedupGroupItem[],
    favoriteFileIds: ReadonlySet<number>,
    qualityById: ReadonlyMap<number, number>,
    now: number = Date.now(),
): DedupItemFacts[] => {
    const files = items.map((item) => item.file);
    const pixels = files.map((file) => {
        const size = filePixelSize(file);
        return size ? size.width * size.height : undefined;
    });
    const bytes = files.map((file) => fileByteSize(file) || undefined);
    const qualities = files.map((file) => qualityById.get(file.id));
    const tags = files.map(extractUserTags);
    const pixelLeader = strictLeader(pixels);
    const byteLeader = strictLeader(bytes);
    const qualityLeader = strictLeader(qualities);

    return items.map(({ file, collectionName }, index) => {
        const size = filePixelSize(file);
        const byteSize = bytes[index];
        const quality = qualities[index];
        const uploadedAt = fileUploadSortTime(file);
        const editedAt = file.pubMagicMetadata?.data.editedAt;
        return {
            dimensions: size ? `${size.width} × ${size.height}` : undefined,
            size: byteSize ? formatFileSize(byteSize) : undefined,
            quality: quality === undefined ? undefined : Math.round(quality * 100),
            isFavorite: favoriteFileIds.has(file.id),
            takenAt: formatTakenAt(file),
            uploadedAt: formatTimeAgo(uploadedAt / 1000, now),
            editedAt:
                editedAt !== undefined &&
                editedAt - uploadedAt > editAfterUploadMicros ?
                    formatTimeAgo(editedAt / 1000, now) :
                    undefined,
            album: collectionName,
            tags: tags[index]!.map((name) => ({
                name,
                onlyHere: tags.every(
                    (otherTags, otherIndex) =>
                        otherIndex === index || !otherTags.includes(name),
                ),
            })),
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
