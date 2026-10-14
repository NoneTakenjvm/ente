import { useEffect, useRef, useState } from "react";
import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "@/core";
import {
    pendingFavoriteFilesByHashAndType,
    useFavoritesStore,
} from "@/stores/favorites-store";
import { isSessionAuthenticated } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import {
    hydrateDerivedReplaceOutbox,
    loadDerivedReplaceOutboxBytes,
    removeDerivedReplaceOutboxEntries,
} from "@/lib/derived-replace-outbox";
import { favoriteOutboxEntryKey } from "@/lib/favorite-outbox";
import {
    addFavoriteMembershipIds,
    removeFavoriteMembershipIds,
} from "@/lib/favorite-membership";
import { startTagOutboxRunner } from "@/lib/tag-outbox-runner";
import { probeVideoDurationSec } from "@/lib/video-edit";
import { registerReset } from "@/lib/session-lifecycle";

const isFileIdInTrash = async (fileId: number): Promise<boolean> => {
    const { useTrashStore } = await import("@/stores/trash-store");
    return useTrashStore
        .getState()
        .items.some((item) => item.file.id === fileId);
};

const favoriteMutationContext = (
    library: ReturnType<typeof useLibraryStore.getState>,
) => ({
    collections: library.collections,
    allFiles: library.allFiles,
    pendingByHashAndType: pendingFavoriteFilesByHashAndType,
});

export interface UseLibraryBootstrapOptions {
    /** Extra work after cache load and remote sync (e.g. phash hydrate). */
    afterSync?: () => Promise<void>;
}

/**
 * [Note: One library bootstrap per session]
 *
 * Every page mounts {@link useLibraryBootstrap}. The cache decrypt, outbox
 * hydrate, runner start and first sync run once per session and later pages
 * await the same promise (then refresh with a background sync) instead of
 * re-decrypting the whole library on each navigation. Logout and lock clear
 * it through {@link resetLibraryBootstrap}.
 */
let sessionBootstrap: Promise<void> | undefined;

/** Forget the session bootstrap so the next page mount loads from scratch. */
export const resetLibraryBootstrap = (): void => {
    sessionBootstrap = undefined;
};

/**
 * Load encrypted cache then sync from Ente once per authenticated session.
 */
export const useLibraryBootstrap = (
    options: UseLibraryBootstrapOptions = {},
): boolean => {
    const bootstrapFromCache = useLibraryStore(
        (state) => state.bootstrapFromCache,
    );
    const syncRemote = useLibraryStore((state) => state.syncRemote);
    // Callers pass afterSync inline; a ref keeps it out of the effect deps so
    // re-renders don't cancel the load before initialLoadDone is set.
    const afterSyncRef = useRef(options.afterSync);
    useEffect(() => {
        afterSyncRef.current = options.afterSync;
    });

    const [initialLoadDone, setInitialLoadDone] = useState(false);

    useEffect(() => {
        if (!isSessionAuthenticated()) {
            return () => {};
        }

        let cancelled = false;

        const bootstrap = async (): Promise<void> => {
            // bootstrapFromCache hydrates the tag/favourite/visibility outboxes.
            await bootstrapFromCache();
            await hydrateDerivedReplaceOutbox();
            startTagOutboxRunner({
                getFileById: (fileId) =>
                    useLibraryStore.getState().getFileById(fileId),
                getCollections: () =>
                    useLibraryStore.getState().collections,
                patchFile: (file) =>
                    useLibraryStore.getState().patchFile(file),
                patchFiles: (files) => {
                    useLibraryStore.getState().patchFiles(files);
                },
                applyFavoriteMutations: async (entries) => {
                    const library = useLibraryStore.getState();
                    const core = getEnteCore();
                    const ctx = favoriteMutationContext(library);

                    const ackedKeys: string[] = [];
                    const toAdd: EnteFile[] = [];
                    const toRemove: EnteFile[] = [];
                    const addKeys: string[] = [];
                    const removeKeys: string[] = [];

                    for (const entry of entries) {
                        const key = favoriteOutboxEntryKey(entry);
                        const file = library.allFiles.find(
                            (candidate) => candidate.id === entry.fileId,
                        );
                        if (!file) {
                            if (await isFileIdInTrash(entry.fileId)) {
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
                        const membershipIds =
                            await core.addToFavorites(toAdd, ctx);
                        await addFavoriteMembershipIds(membershipIds);
                        ackedKeys.push(...addKeys);
                    }
                    if (toRemove.length) {
                        const membershipIds =
                            await core.removeFromFavorites(toRemove, ctx);
                        await removeFavoriteMembershipIds(membershipIds);
                        ackedKeys.push(...removeKeys);
                    }
                    return { ackedKeys };
                },
                applyFavoriteMutation: async (entry) => {
                    const library = useLibraryStore.getState();
                    const file = library.allFiles.find(
                        (candidate) => candidate.id === entry.fileId,
                    );
                    if (!file) {
                        if (await isFileIdInTrash(entry.fileId)) {
                            return;
                        }
                        throw new Error(
                            `File ${entry.fileId} not in library`,
                        );
                    }
                    const core = getEnteCore();
                    const ctx = favoriteMutationContext(library);
                    if (entry.isFavorite) {
                        const membershipIds = await core.addToFavorites(
                            [file],
                            ctx,
                        );
                        await addFavoriteMembershipIds(membershipIds);
                    } else {
                        const membershipIds =
                            await core.removeFromFavorites([file], ctx);
                        await removeFavoriteMembershipIds(membershipIds);
                    }
                },
                syncFavorites: async () => {
                    // Membership already patched after API success; rebuild
                    // UI sets from oracle + remaining outbox overlays.
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
                    const file = library.allFiles.find(
                        (candidate) => candidate.id === entry.fileId,
                    );
                    if (!file) {
                        return;
                    }
                    const collection = library.collections.find(
                        (candidate) => candidate.id === file.collectionID,
                    );
                    if (!collection?.key) {
                        return;
                    }
                    const updated = await getEnteCore().updateFileVisibility(
                        file,
                        collection.key,
                        entry.visibility,
                    );
                    await library.patchFile(updated);
                },
                retryDerivedReplace: async (entry) => {
                    const bytes = await loadDerivedReplaceOutboxBytes(entry.fileId);
                    if (!bytes) {
                        console.warn(
                            "Derived replace payload missing; dropping outbox entry",
                            entry.fileId,
                        );
                        await removeDerivedReplaceOutboxEntries([
                            entry.fileId,
                        ]);
                        return;
                    }
                    const library = useLibraryStore.getState();
                    if (!library.getFileById(entry.fileId)) {
                        // Trashed or already replaced: there is nothing left
                        // to apply the edit to. A file that is merely not
                        // loaded yet (not in trash) stays queued.
                        if (await isFileIdInTrash(entry.fileId)) {
                            await removeDerivedReplaceOutboxEntries([
                                entry.fileId,
                            ]);
                        }
                        return;
                    }
                    if (entry.kind === "video-edit") {
                        const duration = await probeVideoDurationSec(
                            bytes,
                            "video/mp4",
                        );
                        const { finalize } =
                            library.editVideoAndReplaceFileOptimistic(
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
                        const source = library.allFiles.find(
                            (candidate) => candidate.id === entry.fileId,
                        );
                        const originalByteLength =
                            source?.info?.fileSize &&
                            source.info.fileSize > bytes.length ?
                                source.info.fileSize :
                                bytes.length * 2;
                        const { mediaKindForFile } = await import("@/lib/media-kind");
                        const kind =
                            (source ? mediaKindForFile(source) : undefined) ??
                            "image";
                        const mimeType =
                            kind === "video" ?
                                "video/mp4" :
                                kind === "gif" ?
                                    "image/gif" :
                                    "image/jpeg";
                        const { finalize } =
                            library.compressAndReplaceMediaOptimistic(
                                entry.fileId,
                                {
                                    bytes,
                                    width: entry.width,
                                    height: entry.height,
                                    mimeType,
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
                    const { finalize } =
                        library.cropAndReplaceFileOptimistic(
                            entry.fileId,
                            bytes,
                            {
                                width: entry.width,
                                height: entry.height,
                            },
                        );
                    await finalize;
                },
            });
            await syncRemote().catch(() => {
                // syncRemote records the error; later page mounts sync again.
            });
        };

        const load = async () => {
            try {
                if (sessionBootstrap) {
                    await sessionBootstrap;
                    void syncRemote().catch(() => {
                        // syncRemote records the error in the library store.
                    });
                } else {
                    sessionBootstrap = bootstrap().catch((error: unknown) => {
                        // Let the next page mount retry a failed bootstrap.
                        sessionBootstrap = undefined;
                        throw error;
                    });
                    await sessionBootstrap;
                }
                await afterSyncRef.current?.();
            } catch (error) {
                console.warn("[library] bootstrap failed", error);
            } finally {
                if (!cancelled) {
                    setInitialLoadDone(true);
                }
            }
        };

        void load();
        return () => {
            cancelled = true;
        };
    }, [bootstrapFromCache, syncRemote]);
    return initialLoadDone;
};

registerReset(resetLibraryBootstrap);
