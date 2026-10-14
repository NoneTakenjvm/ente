import { useDeferredValue, useMemo } from "react";
import {
    countFavoritesInCandidates,
    countFileKindsInCandidates,
    countTaggedInCandidates,
    type CroppedScope,
    type FavoritesScope,
    type MediaScope,
    type RotatedScope,
    type TagScope,
} from "@/lib/tag-filter";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useTagStore } from "@/stores/tag-store";
import type { EnteFile } from "ente-media/file";

/** Files per scope value; the rotate scope has no counts. */
export type ScopeCounts = Partial<
    Record<
        Exclude<
            TagScope | FavoritesScope | MediaScope | CroppedScope | RotatedScope,
            "all"
        >,
        number
    >
>;

/**
 * How many of {@link candidateFiles} each scope option would keep, for the
 * counts shown beside scope filter options.
 */
export const useScopeCounts = (candidateFiles: EnteFile[]): ScopeCounts => {
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    // Defer so starring stays snappy; the counts can lag a frame.
    const deferredFavoriteFileIds = useDeferredValue(favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );

    const candidateFileIds = useMemo(
        (): Set<number> => new Set(candidateFiles.map((file) => file.id)),
        [candidateFiles],
    );

    return useMemo((): ScopeCounts => {
        const total = candidateFileIds.size;
        const tagged = countTaggedInCandidates(
            candidateFileIds,
            fileIdsByTag,
            includeInEffectsPresenceByName,
        );
        const favorites = countFavoritesInCandidates(
            candidateFileIds,
            deferredFavoriteFileIds,
        );
        const kinds = countFileKindsInCandidates(
            candidateFileIds,
            candidateFiles,
        );
        return {
            tagged,
            untagged: total - tagged,
            favorites,
            "not-favorites": total - favorites,
            photo: kinds.photos,
            video: kinds.videos,
            cropped: kinds.cropped,
            "not-cropped": kinds.notCropped,
        };
    }, [
        candidateFileIds,
        candidateFiles,
        deferredFavoriteFileIds,
        fileIdsByTag,
        includeInEffectsPresenceByName,
    ]);
};
