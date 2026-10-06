import {
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { EnteFile } from "ente-media/file";
import { getEnteCore, type Collection, type EnteCore } from "@/core";
import {
    pendingFavoriteFilesByHashAndType,
    useFavoritesStore,
} from "@/stores/favorites-store";
import { isSessionAuthenticated } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import {
    hydrateDerivedReplaceOutbox,
    loadDerivedReplaceOutboxBytes,
    type DerivedReplaceOutboxEntry,
} from "@/lib/derived-replace-outbox";
import {
    hydrateFavoriteOutbox,
    type FavoriteOutboxEntry,
} from "@/lib/favorite-outbox";
import {
    addFavoriteMembershipIds,
    hydrateFavoriteMembership,
    removeFavoriteMembershipIds,
} from "@/lib/favorite-membership";
import { hydrateTagOutbox } from "@/lib/tag-outbox";
import {
    startTagOutboxRunner,
    type FavoriteMutationsResult,
} from "@/lib/tag-outbox-runner";
import {
    hydrateVisibilityOutbox,
    type VisibilityOutboxEntry,
} from "@/lib/visibility-outbox";
import { probeVideoDurationSec } from "@/lib/video-edit";

const favoriteEntryKey: (entry: FavoriteOutboxEntry) => string = (
    entry: FavoriteOutboxEntry,
): string => entry.fileHashAndTypeKey ?? String(entry.fileId);

const isFileIdInTrash: (fileId: number) => Promise<boolean> = async (
    fileId: number,
): Promise<boolean> => {
    const trashStoreModule: {
        useTrashStore: {
            getState: () => {
                items: Array<{ file: { id: number } }>;
            };
        };
    } = await import("@/stores/trash-store");
    return trashStoreModule.useTrashStore
        .getState()
        .items.some(
            (item: { file: { id: number } }): boolean =>
                item.file.id === fileId,
        );
};

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
export const useLibraryBootstrap: (
    options?: UseLibraryBootstrapOptions,
) => boolean = (options: UseLibraryBootstrapOptions = {}): boolean => {
    const bootstrapFromCache: () => Promise<boolean> = useLibraryStore(
        (state: { bootstrapFromCache: () => Promise<boolean> }): (() => Promise<boolean>) =>
            state.bootstrapFromCache,
    );
    const syncRemote: () => Promise<void> = useLibraryStore(
        (state: { syncRemote: () => Promise<void> }): (() => Promise<void>) =>
            state.syncRemote,
    );
    // Callers pass afterSync inline; a ref keeps it out of the effect deps so
    // re-renders don't cancel the load before initialLoadDone is set.
    const afterSyncRef = useRef(options.afterSync);
    useEffect(() => {
        afterSyncRef.current = options.afterSync;
    });

    const [initialLoadDone, setInitialLoadDone]: [
        boolean,
        Dispatch<SetStateAction<boolean>>,
    ] = useState<boolean>(false);

    useEffect((): (() => void) => {
        if (!isSessionAuthenticated()) {
            return (): void => {};
        }

        let cancelled: boolean = false;

        const bootstrap: () => Promise<void> = async (): Promise<void> => {
            await bootstrapFromCache();
            await Promise.all([
                hydrateTagOutbox(),
                hydrateFavoriteOutbox(),
                hydrateFavoriteMembership(),
                hydrateVisibilityOutbox(),
                hydrateDerivedReplaceOutbox(),
            ]);
            startTagOutboxRunner({
                getFiles: (): EnteFile[] =>
                    useLibraryStore.getState().allFiles,
                getCollections: (): Collection[] =>
                    useLibraryStore.getState().collections,
                patchFile: (file: EnteFile): Promise<void> =>
                    useLibraryStore.getState().patchFile(file),
                patchFiles: (files: EnteFile[]): void => {
                    useLibraryStore.getState().patchFiles(files);
                },
                applyFavoriteMutations: async (
                    entries: FavoriteOutboxEntry[],
                ): Promise<FavoriteMutationsResult> => {
                    const library: ReturnType<
                        typeof useLibraryStore.getState
                    > = useLibraryStore.getState();
                    const core: EnteCore = getEnteCore();
                    const ctx: {
                        collections: Collection[];
                        allFiles: EnteFile[];
                        pendingByHashAndType: typeof pendingFavoriteFilesByHashAndType;
                    } = {
                        collections: library.collections,
                        allFiles: library.allFiles,
                        pendingByHashAndType:
                            pendingFavoriteFilesByHashAndType,
                    };

                    const ackedKeys: string[] = [];
                    const toAdd: EnteFile[] = [];
                    const toRemove: EnteFile[] = [];
                    const addKeys: string[] = [];
                    const removeKeys: string[] = [];

                    for (const entry of entries) {
                        const key: string = favoriteEntryKey(entry);
                        const file: EnteFile | undefined =
                            library.allFiles.find(
                                (candidate: EnteFile): boolean =>
                                    candidate.id === entry.fileId,
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
                applyFavoriteMutation: async (
                    entry: FavoriteOutboxEntry,
                ): Promise<void> => {
                    const library: ReturnType<
                        typeof useLibraryStore.getState
                    > = useLibraryStore.getState();
                    const file: EnteFile | undefined =
                        library.allFiles.find(
                            (candidate: EnteFile): boolean =>
                                candidate.id === entry.fileId,
                        );
                    if (!file) {
                        if (await isFileIdInTrash(entry.fileId)) {
                            return;
                        }
                        throw new Error(
                            `File ${entry.fileId} not in library`,
                        );
                    }
                    const core: EnteCore = getEnteCore();
                    const ctx: {
                        collections: Collection[];
                        allFiles: EnteFile[];
                        pendingByHashAndType: typeof pendingFavoriteFilesByHashAndType;
                    } = {
                        collections: library.collections,
                        allFiles: library.allFiles,
                        pendingByHashAndType:
                            pendingFavoriteFilesByHashAndType,
                    };
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
                syncFavorites: async (): Promise<void> => {
                    // Membership already patched after API success; rebuild
                    // UI sets from oracle + remaining outbox overlays.
                    const library: ReturnType<
                        typeof useLibraryStore.getState
                    > = useLibraryStore.getState();
                    useFavoritesStore
                        .getState()
                        .rebuildFromLibrary(
                            getEnteCore().getUserID(),
                            library.collections,
                            library.allFiles,
                        );
                },
                applyVisibilityMutation: async (
                    entry: VisibilityOutboxEntry,
                ): Promise<void> => {
                    const library: ReturnType<
                        typeof useLibraryStore.getState
                    > = useLibraryStore.getState();
                    const file: EnteFile | undefined =
                        library.allFiles.find(
                            (candidate: EnteFile): boolean =>
                                candidate.id === entry.fileId,
                        );
                    if (!file) {
                        return;
                    }
                    const collection: Collection | undefined =
                        library.collections.find(
                            (candidate: Collection): boolean =>
                                candidate.id === file.collectionID,
                        );
                    if (!collection?.key) {
                        return;
                    }
                    const updated: EnteFile =
                        await getEnteCore().updateFileVisibility(
                            file,
                            collection.key,
                            entry.visibility,
                        );
                    await library.patchFile(updated);
                },
                retryDerivedReplace: async (
                    entry: DerivedReplaceOutboxEntry,
                ): Promise<void> => {
                    const bytes: Uint8Array | undefined =
                        await loadDerivedReplaceOutboxBytes(entry.fileId);
                    if (!bytes) {
                        const removeModule: {
                            removeDerivedReplaceOutboxEntries: (
                                fileIds: number[],
                            ) => Promise<void>;
                        } = await import("@/lib/derived-replace-outbox");
                        await removeModule.removeDerivedReplaceOutboxEntries([
                            entry.fileId,
                        ]);
                        return;
                    }
                    const library: ReturnType<
                        typeof useLibraryStore.getState
                    > = useLibraryStore.getState();
                    if (entry.kind === "video-edit") {
                        const duration: number =
                            await probeVideoDurationSec(bytes, "video/mp4");
                        const { finalize }: {
                            finalize: Promise<EnteFile>;
                        } = library.editVideoAndReplaceFileOptimistic(
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
                        const source: EnteFile | undefined =
                            library.allFiles.find(
                                (candidate: EnteFile): boolean =>
                                    candidate.id === entry.fileId,
                            );
                        const originalByteLength: number =
                            source?.info?.fileSize &&
                            source.info.fileSize > bytes.length ?
                                source.info.fileSize :
                                bytes.length * 2;
                        const mediaKindModule: {
                            mediaKindForFile: (
                                file: EnteFile,
                            ) => "image" | "gif" | "video" | null;
                        } = await import("@/lib/media-kind");
                        const kind: "image" | "gif" | "video" =
                            (source ?
                                mediaKindModule.mediaKindForFile(source) :
                                undefined) ?? "image";
                        const mimeType: string =
                            kind === "video" ?
                                "video/mp4" :
                                kind === "gif" ?
                                    "image/gif" :
                                    "image/jpeg";
                        const { finalize }: {
                            finalize: Promise<EnteFile>;
                        } =
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
                    const { finalize }: { finalize: Promise<EnteFile> } =
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
            await syncRemote().catch((): void => {
                // syncRemote records the error; later page mounts sync again.
            });
        };

        const load = async (): Promise<void> => {
            try {
                if (sessionBootstrap) {
                    await sessionBootstrap;
                    void syncRemote().catch((): void => {
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
        return (): void => {
            cancelled = true;
        };
    }, [bootstrapFromCache, syncRemote]);
    return initialLoadDone;
};
