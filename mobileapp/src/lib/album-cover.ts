import type { QueryAlbum } from "@/lib/query-albums";
import type { EnteFile } from "ente-media/file";

/**
 * Resolve the file to use as an album list thumbnail.
 *
 * Uses `coverFileId` when set and still in matches; otherwise the newest match.
 */
export const resolveAlbumCoverFile = (
    album: QueryAlbum,
    matchFiles: EnteFile[],
): EnteFile | undefined => {
    if (matchFiles.length === 0) {
        return undefined;
    }
    const matchIds = new Set(matchFiles.map((file) => file.id));
    if (
        album.coverFileId !== undefined &&
        matchIds.has(album.coverFileId)
    ) {
        return matchFiles.find((file) => file.id === album.coverFileId);
    }
    return matchFiles[0];
};

/**
 * Return a cover file id that is valid for the given match set, or undefined.
 */
export const validCoverFileIdForMatches = (
    coverFileId: number | undefined,
    matchFiles: EnteFile[],
): number | undefined => {
    if (coverFileId === undefined) {
        return undefined;
    }
    return matchFiles.some((file) => file.id === coverFileId) ?
        coverFileId :
        undefined;
};
