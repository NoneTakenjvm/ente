import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import {
    removeDerivedReplaceOutboxEntries,
    loadDerivedReplaceOutboxBytes,
} from "@/lib/derived-replace-outbox";
import { favoriteOutboxEntryKey } from "@/lib/favorite-outbox";
import {
    addFavoriteMembershipIds,
    removeFavoriteMembershipIds,
} from "@/lib/favorite-membership";
import { mediaKindForFile } from "@/lib/media-kind";
import type { OutboxRunnerContext } from "@/lib/outbox-runner";
import { probeVideoDurationSec } from "@/lib/video-edit";
import {
    pendingFavoriteFilesByHashAndType,
    useFavoritesStore,
} from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTrashStore } from "@/stores/trash-store";

/**
 * Outbox runner context wired to the library, favourites and trash stores.
 *
 * Lives apart from the runner so the runner stays free of store imports (the
 * library store itself imports the runner).
 */
export const libraryOutboxContext: OutboxRunnerContext = {
    getFileById: (fileId) => useLibraryStore.getState().getFileById(fileId),
    getCollections: () => useLibraryStore.getState().collections,
    patchFiles: (files) => {
        useLibraryStore.getState().patchFiles(files);
    },
    applyFavoriteMutations: async (entries) => {
        const library = useLibraryStore.getState();
        const core = getEnteCore();
        const ctx = {
            collections: library.collections,
            allFiles: library.allFiles,
            pendingByHashAndType: pendingFavoriteFilesByHashAndType,
        };

        const ackedKeys: string[] = [];
        const toAdd: EnteFile[] = [];
        const toRemove: EnteFile[] = [];
        const addKeys: string[] = [];
        const removeKeys: string[] = [];
        let trashedIds: Set<number> | undefined;

        for (const entry of entries) {
            const key = favoriteOutboxEntryKey(entry);
            const file = library.getFileById(entry.fileId);
            if (!file) {
                // Trashed files have nothing left to favourite: discard.
                trashedIds ??= trashedFileIds();
                if (trashedIds.has(entry.fileId)) {
                    ackedKeys.push(key);
                }
                continue;
            }
            if (entry.isFavorite) {
                toAdd.push(file);
                addKeys.push(key);
            } else {
                toRemove.push(file);
                removeKeys.push(key);
            }
        }
        if (toAdd.length) {
            await addFavoriteMembershipIds(
                await core.addToFavorites(toAdd, ctx),
            );
            ackedKeys.push(...addKeys);
        }
        if (toRemove.length) {
            await removeFavoriteMembershipIds(
                await core.removeFromFavorites(toRemove, ctx),
            );
            ackedKeys.push(...removeKeys);
        }
        return { ackedKeys };
    },
    syncFavorites: async () => {
        // Membership already patched after API success; rebuild UI sets from
        // oracle + remaining outbox overlays.
        const library = useLibraryStore.getState();
        useFavoritesStore
            .getState()
            .rebuildFromLibrary(
                getEnteCore().getUserID(),
                library.collections,
                library.allFiles,
            );
    },
    applyVisibilityMutation: async (entry) => {
        const library = useLibraryStore.getState();
        const file = library.getFileById(entry.fileId);
        if (!file) {
            return;
        }
        const collection = library.collections.find(
            (candidate) => candidate.id === file.collectionID,
        );
        if (!collection?.key) {
            return;
        }
        // Write on a clone: the core assigns the accepted metadata onto the
        // file it is given, which must not be the library's own object.
        library.patchFiles([
            await getEnteCore().updateFileVisibility(
                { ...file },
                collection.key,
                entry.visibility,
            ),
        ]);
    },
    retryDerivedReplace: async (entry) => {
        const bytes = await loadDerivedReplaceOutboxBytes(entry.fileId);
        if (!bytes) {
            console.warn(
                "Derived replace payload missing; dropping outbox entry",
                entry.fileId,
            );
            await removeDerivedReplaceOutboxEntries([entry.fileId]);
            return;
        }
        const library = useLibraryStore.getState();
        const source = library.getFileById(entry.fileId);
        if (!source) {
            // Trashed or already replaced: there is nothing left to apply the
            // edit to. A file that is merely not loaded yet (not in trash)
            // stays queued.
            if (trashedFileIds().has(entry.fileId)) {
                await removeDerivedReplaceOutboxEntries([entry.fileId]);
            }
            return;
        }
        if (entry.kind === "video-edit") {
            const duration = await probeVideoDurationSec(bytes, "video/mp4");
            const { finalize } = library.editVideoAndReplaceFileOptimistic(
                entry.fileId,
                {
                    bytes,
                    width: entry.width,
                    height: entry.height,
                    duration,
                },
            );
            await finalize;
            return;
        }
        if (entry.kind === "compress") {
            const originalByteLength =
                source.info?.fileSize && source.info.fileSize > bytes.length ?
                    source.info.fileSize :
                    bytes.length * 2;
            const kind = mediaKindForFile(source) ?? "image";
            const { finalize } = library.compressAndReplaceMediaOptimistic(
                entry.fileId,
                {
                    bytes,
                    width: entry.width,
                    height: entry.height,
                    mimeType:
                        kind === "video" ?
                            "video/mp4" :
                            kind === "gif" ?
                                "image/gif" :
                                "image/jpeg",
                    extension:
                        kind === "video" ?
                            "mp4" :
                            kind === "gif" ?
                                "gif" :
                                "jpg",
                    encoder:
                        kind === "video" || kind === "gif" ?
                            "ffmpeg" :
                            "photohoard",
                    audio: "none",
                },
                originalByteLength,
            );
            await finalize;
            return;
        }
        const { finalize } = library.cropAndReplaceFileOptimistic(
            entry.fileId,
            bytes,
            { width: entry.width, height: entry.height },
        );
        await finalize;
    },
};

const trashedFileIds = (): Set<number> =>
    new Set(useTrashStore.getState().items.map((item) => item.file.id));
