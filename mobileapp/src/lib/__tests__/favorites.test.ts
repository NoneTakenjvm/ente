import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    applyFavoriteUpdateToIds,
    createUnsyncedFavoriteUpdate,
    deriveFavoriteFileIDs,
    isFileFavorited,
    mergePendingFavoriteUpdates,
} from "@/lib/favorites";

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

    it("mergePendingFavoriteUpdates keeps unconfirmed intents and drops matches", () => {
        const existing = new Map([
            [10, { fileID: 10, isFavorite: true }],
            [11, { fileID: 11, isFavorite: true }],
        ]);
        const fromOutbox = new Map([
            [12, { fileID: 12, isFavorite: false }],
        ]);
        const confirmed = new Set([11, 12]);

        const merged = mergePendingFavoriteUpdates(
            existing,
            fromOutbox,
            confirmed,
        );

        expect([...merged.keys()].sort()).toEqual([10, 12]);
        expect(merged.get(10)?.isFavorite).toBe(true);
        expect(merged.get(12)?.isFavorite).toBe(false);
    });

    it("applyFavoriteUpdateToIds patches owned files without touching siblings", () => {
        const galleryFile = fileWithHash(10, 5, "abc");
        const other = fileWithHash(11, 5, "def");
        const baseline = new Set([11]);
        const { update } = createUnsyncedFavoriteUpdate(
            galleryFile,
            userId,
            true,
        );

        const next = applyFavoriteUpdateToIds(
            baseline,
            update,
            userId,
            [galleryFile, other],
        );

        expect(next.has(10)).toBe(true);
        expect(next.has(11)).toBe(true);
        expect(baseline.has(10)).toBe(false);
    });

    it("applyFavoriteUpdateToIds clears owned favourite on unfavourite", () => {
        const galleryFile = fileWithHash(10, 5, "abc");
        const { update } = createUnsyncedFavoriteUpdate(
            galleryFile,
            userId,
            false,
        );

        const next = applyFavoriteUpdateToIds(
            new Set([10, 20]),
            update,
            userId,
            [galleryFile],
        );

        expect(next.has(10)).toBe(false);
        expect(next.has(20)).toBe(true);
    });
});
