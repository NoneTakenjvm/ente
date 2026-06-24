import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { deriveFavoriteFileIDs, isFileFavorited } from "@/lib/favorites";

const userId = 1;
const favoritesCollectionId = 99;

const favoritesCollection = {
    id: favoritesCollectionId,
    type: "favorites",
    owner: { id: userId },
} as unknown as Collection;

const fileWithHash = (
    id: number,
    collectionID: number,
    hash: string,
): EnteFile =>
    ({
        id,
        ownerID: userId,
        collectionID,
        metadata: {
            hash,
            fileType: FileType.image,
        },
    }) as unknown as EnteFile;

describe("favorites", () => {
    it("marks user-owned gallery files as favourites when hash matches favourites collection", () => {
        const galleryFile = fileWithHash(10, 5, "abc");
        const favoriteCopy = fileWithHash(20, favoritesCollectionId, "abc");
        const collections = [favoritesCollection];
        const allFiles = [galleryFile, favoriteCopy];

        const { favoriteFileIds } = deriveFavoriteFileIDs(
            userId,
            collections,
            allFiles,
        );

        expect(favoriteFileIds.has(20)).toBe(true);
        expect(favoriteFileIds.has(10)).toBe(true);
        expect(isFileFavorited(galleryFile, userId, collections, allFiles)).toBe(
            true,
        );
    });
});
