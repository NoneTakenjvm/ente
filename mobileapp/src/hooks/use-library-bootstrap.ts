import {
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { EnteFile } from "ente-media/file";
import { getEnteCore, type Collection, type EnteCore } from "@/core";
import { pendingFavoriteFilesByHashAndType } from "@/stores/favorites-store";
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
import { hydrateTagOutbox } from "@/lib/tag-outbox";
import {
    startTagOutboxRunner,
    stopTagOutboxRunner,
} from "@/lib/tag-outbox-runner";
import {
    hydrateVisibilityOutbox,
    type VisibilityOutboxEntry,
} from "@/lib/visibility-outbox";
import { probeVideoDurationSec } from "@/lib/video-edit";

export interface UseLibraryBootstrapOptions {
    /** Extra work after cache load and remote sync (e.g. phash hydrate). */
    afterSync?: () => Promise<void>;
}

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
    const afterSync: (() => Promise<void>) | undefined = options.afterSync;

    const [initialLoadDone, setInitialLoadDone]: [
        boolean,
        Dispatch<SetStateAction<boolean>>,
    ] = useState<boolean>(false);
    const bootstrapStarted: { current: boolean } = useRef<boolean>(false);

    useEffect((): (() => void) => {
        if (!isSessionAuthenticated() || bootstrapStarted.current) {
            return (): void => {};
        }
        bootstrapStarted.current = true;

        let cancelled: boolean = false;

        const bootstrap: () => Promise<void> = async (): Promise<void> => {
            try {
                await bootstrapFromCache();
                await Promise.all([
                    hydrateTagOutbox(),
                    hydrateFavoriteOutbox(),
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
                            return;
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
                            await core.addToFavorites([file], ctx);
                        } else {
                            await core.removeFromFavorites([file], ctx);
                        }
                    },
                    syncFavorites: (): Promise<void> =>
                        useLibraryStore.getState().syncRemote(),
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
                await syncRemote();
                await afterSync?.();
            } finally {
                if (!cancelled) {
                    setInitialLoadDone(true);
                }
            }
        };

        void bootstrap();
        return (): void => {
            cancelled = true;
            stopTagOutboxRunner();
        };
    }, [afterSync, bootstrapFromCache, syncRemote]);
    return initialLoadDone;
};
