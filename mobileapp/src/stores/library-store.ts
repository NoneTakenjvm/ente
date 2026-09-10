import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { EnteFile } from "ente-media/file";
import { getEnteCore, type Collection } from "@/core";
import { bindOrganizerDB } from "@/db";
import {
    loadEncryptedCollections,
    loadEncryptedFiles,
    loadEncryptedTagIndex,
    saveEncryptedCollections,
    saveEncryptedFiles,
} from "@/db/kv";
import { initSessionCacheKey, getSessionCacheKey } from "@/lib/cache-key";
import { pullCollections } from "@/lib/sync/pull-collections";
import { pullFiles } from "@/lib/sync/pull-files";
import { clearAllSyncCursors } from "@/db/cursors";
import {
    applyTagMutatorOnFiles,
    deleteTagOnFiles,
    mergeTagsOnFiles,
    renameTagOnFiles,
    type BatchTagResult,
} from "@/lib/tag-batch";
import {
    planDuplicateGroupPrune,
    pruneDuplicateGroups,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import type { CollectionFilesContext } from "@/core/api/collection-files";
import { planLibraryFilePatches, patchFileInLibrary, patchFileInPlace, patchFilesInLibrary } from "@/lib/library-file-patch";
import { buildFileIndexById } from "@/lib/library-file-index";
import { applyTagMutator, fileWithOrganizerTags, mergeTagNames, removeTagNames, replaceTagName, tagsForFile, type TagMutator } from "@/lib/tag-writes";
import { extractTags } from "@/lib/tags";
import {
    applyOutboxTagsToFiles,
    enqueueTagOutboxEntries,
    ensureTagOutboxHydrated,
    getTagOutboxEntries,
    getTagOutboxEntry,
    hydrateTagOutbox,
    mergeAheadOrganizerTags,
    reconcileTagOutboxWithFiles,
    remapTagOutboxFileId,
} from "@/lib/tag-outbox";
import { drainTagOutbox, requestTagOutboxFlush } from "@/lib/tag-outbox-runner";
import { enqueueDerivedReplace } from "@/lib/derived-replace-queue";
import {
    removeDerivedReplaceOutboxEntries,
    upsertDerivedReplaceOutboxEntry,
} from "@/lib/derived-replace-outbox";
import {
    clearEditHistory,
    getEditHistory,
    recordEditHistory,
    remapEditHistoryFileId,
    MAX_IN_MEMORY_EDIT_HISTORY_BYTES,
} from "@/lib/edit-history";
import {
    ensureFavoriteOutboxHydrated,
    hydrateFavoriteOutbox,
    reconcileFavoriteOutboxWithLibrary,
    removeFavoriteOutboxForFileIds,
    upsertFavoriteOutboxEntry,
    remapFavoriteOutboxFileId,
} from "@/lib/favorite-outbox";
import {
    upsertVisibilityOutboxEntry,
    remapVisibilityOutboxFileId,
    applyOutboxVisibilityToFiles,
    ensureVisibilityOutboxHydrated,
    reconcileVisibilityOutboxWithFiles,
    isFileArchivedLocally,
} from "@/lib/visibility-outbox";
import {
    isOrganizerConfigCollection,
    organizerAppConfigFromCollection,
} from "@/lib/organizer-config";
import { registerShuffleFileSubstitution } from "@/lib/shuffle-file-substitutions";
import {
    clearLocalMediaOverride,
    getLocalMediaOverride,
    setLocalMediaOverride,
} from "@/lib/local-media-overrides";
import {
    invalidateThumbnailCache,
    primeThumbnailFromBytes,
    primeVideoThumbnailFromBytes,
    requestThumbnail,
} from "@/lib/thumbnail-cache";
import {
    useFavoritesStore,
} from "./favorites-store";
import { useAlbumStore } from "./album-store";
import { useSettingsStore } from "./settings-store";
import { useTagStore } from "./tag-store";
import { useTrashStore } from "./trash-store";
import { useUIStore } from "./ui-store";
import {
    buildCompressedOrganizerTags,
    compressedReplaceTitle,
    CompressionSkippedError,
    isWorthReplacing,
} from "@/lib/compress";
import { buildCroppedOrganizerTags, croppedReplaceTitle } from "@/lib/crop";
import { isFileFavorited } from "@/lib/favorites";
import type { CompressMediaResult } from "@/lib/transcode/compress-media";
import type { RotationDegrees } from "@/lib/rotate";
import type { CroppedVideoResult, VideoCropRect } from "@/lib/video-edit";
import { mimeTypeForFile } from "@/lib/media-kind";
import { fileFileName, ItemVisibility } from "ente-media/file-metadata";

export type SyncStatus =
    | "idle" |
    "loadingFromCache" |
    "syncing" |
    "success" |
    "error" |
    "offline";

interface LibraryState {
    collections: Collection[];
    activeCollectionId: number | null;
    allFiles: EnteFile[];
    /** O(1) file-id → index into {@link allFiles}. */
    fileIndexById: Map<number, number>;
    /**
     * Bumps on every library mutation (including in-place slot swaps) so
     * React memos that depend on `allFiles` identity still refresh.
     */
    filesRevision: number;
    syncStatus: SyncStatus;
    syncProgress: { current: number; total: number };
    syncError: string | undefined;
    getFileById: (fileId: number) => EnteFile | undefined;
    bootstrapFromCache: () => Promise<boolean>;
    syncRemote: () => Promise<void>;
    /**
     * Clear sync cursors and re-pull collections + files from the server.
     * Use when the local library count looks truncated after a partial sync.
     */
    forceResyncLibrary: () => Promise<void>;
    setActiveCollection: (id: number | null) => void;
    /**
     * Merge verified remote file metadata into the local library.
     * Batches many files into one array walk and one scheduled encrypt.
     */
    patchFiles: (updated: EnteFile[]) => void;
    patchFile: (updated: EnteFile) => Promise<void>;
    applyLocalTagsOnFile: (fileId: number, intendedTags: string[]) => void;
    updateTagsOnFile: (fileId: number, mutator: TagMutator) => Promise<void>;
    renameTag: (
        oldName: string,
        newName: string,
        onProgress?: (completed: number, total: number) => void,
    ) => Promise<BatchTagResult>;
    deleteTag: (
        tagName: string,
        onProgress?: (completed: number, total: number) => void,
    ) => Promise<BatchTagResult>;
    mergeTags: (
        sourceNames: string[],
        targetName: string,
        onProgress?: (completed: number, total: number) => void,
    ) => Promise<BatchTagResult>;
    setFileFavorite: (file: EnteFile, isFavorite: boolean) => Promise<void>;
    setFileArchived: (file: EnteFile, archived: boolean) => Promise<void>;
    revertLastEdit: (
        fileId: number,
    ) =>
        | {
            optimisticFile: EnteFile;
            bytes: Uint8Array;
            finalize: Promise<EnteFile>;
        } |
        undefined;
    pruneDuplicateGroups: (
        groups: DedupGroupSelection[],
        options?: {
            dryRun?: boolean;
            onProgress?: (progress: number) => void;
        },
    ) => Promise<void>;
    compressAndUploadFile: (
        fileId: number,
        compressedBytes: Uint8Array,
        dimensions: { width: number; height: number },
    ) => Promise<EnteFile>;
    compressAndUploadMedia: (
        fileId: number,
        options?: {
            quality?: number;
            videoCrf?: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            onStage?: (
                stage: "download" | "compress" | "upload",
                ratio?: number,
                encoder?: CompressMediaResult["encoder"],
            ) => void;
        },
        precomputed?: CompressMediaResult,
    ) => Promise<EnteFile>;
    compressAndReplaceMediaOptimistic: (
        fileId: number,
        result: CompressMediaResult,
        originalByteLength: number,
        onUploadProgress?: (ratio: number) => void,
    ) => { optimisticFile: EnteFile; finalize: Promise<EnteFile> };
    rotateAndUploadFile: (
        fileId: number,
        degrees: RotationDegrees,
    ) => Promise<EnteFile>;
    cropVideoAndUploadFile: (
        fileId: number,
        crop: VideoCropRect,
    ) => Promise<EnteFile>;
    cropAndUploadFile: (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
    ) => Promise<EnteFile>;
    cropAndReplaceFileOptimistic: (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
        options?: { autoCropped?: boolean },
    ) => { optimisticFile: EnteFile; finalize: Promise<EnteFile> };
    editVideoAndReplaceFileOptimistic: (
        fileId: number,
        result: CroppedVideoResult,
    ) => { optimisticFile: EnteFile; finalize: Promise<EnteFile> };
    uploadImageFile: (
        collectionId: number,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        creationTime: number,
    ) => Promise<EnteFile>;
    uploadVideoFile: (
        collectionId: number,
        videoBytes: Uint8Array,
        dimensions: { width: number; height: number },
        duration: number,
        title: string,
        creationTime: number,
        mimeType: string,
    ) => Promise<EnteFile>;
    moveFilesToTrash: (fileIds: number[]) => Promise<void>;
    /** Re-add files restored from trash into the local library snapshot. */
    reinsertRestoredFiles: (files: EnteFile[]) => Promise<void>;
    batchUpdateTagsOnFiles: (
        fileIds: number[],
        mutator: TagMutator,
    ) => Promise<BatchTagResult>;
    batchSetFavorite: (fileIds: number[], isFavorite: boolean) => Promise<void>;
    batchSetArchived: (fileIds: number[], archived: boolean) => Promise<void>;
    reset: () => void;
}

const rebuildFavoritesFromLibrary = (
    userId: number,
    collections: Collection[],
    allFiles: EnteFile[],
): void => {
    useFavoritesStore.getState().rebuildFromLibrary(userId, collections, allFiles);
};

const excludeLocallyTrashedFiles = (
    files: EnteFile[],
    extraTrashedIds?: Iterable<number>,
): EnteFile[] => {
    const trashedIds = new Set(extraTrashedIds ?? []);
    for (const item of useTrashStore.getState().items) {
        trashedIds.add(item.file.id);
    }
    if (trashedIds.size === 0) {
        return files;
    }
    return files.filter((file) => !trashedIds.has(file.id));
};

/**
 * Coalesce full-library encrypt+IDB writes so tag commits stay off the
 * critical path. Trailing debounce; persists always re-read `allFiles` at
 * write time so a later patch cannot be overwritten by a stale encrypt.
 */
const ENCRYPTED_FILES_SAVE_DEBOUNCE_MS = 1500;

let encryptedFilesSaveTimer: ReturnType<typeof setTimeout> | undefined;
let encryptedFilesSaveGetter: (() => EnteFile[]) | undefined;
let encryptedFilesPersistChain: Promise<void> = Promise.resolve();

const enqueueEncryptedFilesPersist = (
    getAllFiles: () => EnteFile[],
): Promise<void> => {
    encryptedFilesPersistChain = encryptedFilesPersistChain
        .catch(() => undefined)
        .then(() => saveEncryptedFiles(getAllFiles(), getSessionCacheKey()));
    return encryptedFilesPersistChain;
};

const scheduleSaveEncryptedFiles = (getAllFiles: () => EnteFile[]): void => {
    encryptedFilesSaveGetter = getAllFiles;
    if (encryptedFilesSaveTimer !== undefined) {
        clearTimeout(encryptedFilesSaveTimer);
    }
    encryptedFilesSaveTimer = setTimeout(() => {
        encryptedFilesSaveTimer = undefined;
        const getter = encryptedFilesSaveGetter;
        encryptedFilesSaveGetter = undefined;
        if (!getter) {
            return;
        }
        void enqueueEncryptedFilesPersist(getter);
    }, ENCRYPTED_FILES_SAVE_DEBOUNCE_MS);
};

/** Flush any pending debounced library encrypt immediately (logout / hide). */
const flushScheduledEncryptedFilesSave = (): Promise<void> => {
    if (encryptedFilesSaveTimer !== undefined) {
        clearTimeout(encryptedFilesSaveTimer);
        encryptedFilesSaveTimer = undefined;
    }
    const getter = encryptedFilesSaveGetter;
    encryptedFilesSaveGetter = undefined;
    if (!getter) {
        return encryptedFilesPersistChain;
    }
    return enqueueEncryptedFilesPersist(getter);
};

const cancelScheduledEncryptedFilesSave = (): void => {
    if (encryptedFilesSaveTimer !== undefined) {
        clearTimeout(encryptedFilesSaveTimer);
        encryptedFilesSaveTimer = undefined;
    }
    encryptedFilesSaveGetter = undefined;
};

/**
 * Replace {@link LibraryState.allFiles}, refresh the id index, and bump
 * {@link LibraryState.filesRevision} so subscribers see the change.
 */
const commitAllFiles = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    nextFiles: EnteFile[],
    options?: { rebuildIndex?: boolean },
): void => {
    const rebuildIndex = options?.rebuildIndex !== false;
    set({
        allFiles: nextFiles,
        ...(rebuildIndex ?
            { fileIndexById: buildFileIndexById(nextFiles) } :
            {}),
        filesRevision: get().filesRevision + 1,
    });
};

/**
 * Apply a tag mutator locally (library + index) without waiting on encrypt or network.
 */
const applyOptimisticBatchTags = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    fileIds: Set<number>,
    mutator: TagMutator,
): void => {
    if (fileIds.size === 0) {
        return;
    }
    const { allFiles } = get();
    const tagUpdates: Array<{
        fileId: number;
        tags: string[];
        previousTags: string[];
    }> = [];
    const patches = new Map<number, EnteFile>();
    for (const file of allFiles) {
        if (!fileIds.has(file.id)) {
            continue;
        }
        const tags = tagsForFile(file, mutator);
        tagUpdates.push({
            fileId: file.id,
            tags,
            previousTags: extractTags(file),
        });
        patches.set(file.id, fileWithOrganizerTags(file, tags));
    }
    if (!tagUpdates.length) {
        return;
    }
    const optimisticFiles = patchFilesInLibrary(allFiles, patches);
    if (!optimisticFiles) {
        return;
    }
    commitAllFiles(set, get, optimisticFiles);
    useTagStore.getState().applyFilesTags(tagUpdates);
    scheduleSaveEncryptedFiles(() => get().allFiles);
};

const initialState: Pick<
    LibraryState,
    | "collections" |
    "activeCollectionId" |
    "allFiles" |
    "fileIndexById" |
    "filesRevision" |
    "syncStatus" |
    "syncProgress" |
    "syncError"
> = {
    collections: [],
    activeCollectionId: null,
    allFiles: [],
    fileIndexById: new Map(),
    filesRevision: 0,
    syncStatus: "idle",
    syncProgress: { current: 0, total: 0 },
    syncError: undefined,
};

const appendUploadedFile = async (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    uploaded: EnteFile,
): Promise<EnteFile> => {
    const nextFiles = [...get().allFiles, uploaded];
    commitAllFiles(set, get, nextFiles);
    await saveEncryptedFiles(nextFiles, getSessionCacheKey());
    useTagStore.getState().rebuildFromFiles(nextFiles);
    requestThumbnail(uploaded);
    return uploaded;
};

const replaceSourceWithCompressed = async (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    sourceFile: EnteFile,
    uploaded: EnteFile,
): Promise<EnteFile> => {
    const core = getEnteCore();
    const userId = core.getUserID();
    const { collections, allFiles } = get();
    const favoritesStore = useFavoritesStore.getState();
    const shouldFavorite = isFileFavorited(
        sourceFile,
        userId,
        collections,
        allFiles,
        favoritesStore.unsyncedFavoriteUpdates,
    );

    await core.moveFilesToTrash([sourceFile]);

    const sourceId = sourceFile.id;
    await useTrashStore.getState().seedTrashedFiles([sourceFile]);
    await remapOutboxesAfterReplace(sourceId, uploaded.id);
    registerShuffleFileSubstitution(sourceId, uploaded.id);
    useUIStore.getState().substituteMediaShuffleFileId(sourceId, uploaded.id);
    const withoutSource = get().allFiles.filter((file) => file.id !== sourceId);
    const sourceIndex = get().allFiles.findIndex((file) => file.id === sourceId);
    const nextFiles =
        sourceIndex >= 0 ?
            [
                ...withoutSource.slice(0, sourceIndex),
                uploaded,
                ...withoutSource.slice(sourceIndex),
            ] :
            [...withoutSource, uploaded];
    commitAllFiles(set, get, nextFiles);
    await saveEncryptedFiles(nextFiles, getSessionCacheKey());
    useTagStore.getState().rebuildFromFiles(nextFiles);
    useFavoritesStore.getState().removeTrashedFileIds([sourceId]);
    await invalidateThumbnailCache(sourceId);
    const {
        clearVideoDiskCache,
        transferSessionVideoUrl,
    } = await import("@/lib/video-media-cache");
    transferSessionVideoUrl(sourceId, uploaded.id);
    clearVideoDiskCache(sourceId);
    requestThumbnail(uploaded);

    if (shouldFavorite) {
        await get().setFileFavorite(uploaded, true);
    }

    return uploaded;
};

const uploadCroppedAndReplace = async (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    sourceFile: EnteFile,
    croppedBytes: Uint8Array,
    dimensions: { width: number; height: number },
): Promise<EnteFile> => {
    const { collections } = get();
    const collection = collections.find(
        (entry) => entry.id === sourceFile.collectionID,
    );
    if (!collection) {
        throw new Error(`Collection ${sourceFile.collectionID} not found`);
    }

    const uploaded = await getEnteCore().uploadCroppedImage(
        sourceFile,
        croppedBytes,
        collection,
        dimensions,
        croppedReplaceTitle(sourceFile),
        buildCroppedOrganizerTags(sourceFile),
    );

    return replaceSourceWithCompressed(
        set,
        get,
        sourceFile,
        uploaded,
    );
};

const videoDimensionsFromFile = (
    file: EnteFile,
): { width: number; height: number } => ({
    width: Number(file.pubMagicMetadata?.data?.w) || 0,
    height: Number(file.pubMagicMetadata?.data?.h) || 0,
});

const uploadEditedVideoAndReplace = async (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    sourceFile: EnteFile,
    result: CroppedVideoResult,
): Promise<EnteFile> => {
    const { collections } = get();
    const collection = collections.find(
        (entry) => entry.id === sourceFile.collectionID,
    );
    if (!collection) {
        throw new Error(`Collection ${sourceFile.collectionID} not found`);
    }

    const uploaded = await getEnteCore().uploadCroppedVideo(
        sourceFile,
        result,
        collection,
        compressedReplaceTitle(sourceFile),
        buildCroppedOrganizerTags(sourceFile),
    );

    return replaceSourceWithCompressed(
        set,
        get,
        sourceFile,
        uploaded,
    );
};

const applyOptimisticVisibility = (
    file: EnteFile,
    visibility: typeof ItemVisibility.visible | typeof ItemVisibility.archived,
): EnteFile => ({
    ...file,
    magicMetadata: {
        version: file.magicMetadata?.version ?? 1,
        count: file.magicMetadata?.count ?? 0,
        data: {
            ...file.magicMetadata?.data,
            visibility,
        },
    },
});

const remapOutboxesAfterReplace = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    remapEditHistoryFileId(fromFileId, toFileId);
    const { useViewSessionsStore } = await import(
        "@/stores/view-sessions-store"
    );
    useViewSessionsStore.getState().remapFileId(fromFileId, toFileId);
    await Promise.all([
        remapFavoriteOutboxFileId(fromFileId, toFileId),
        remapVisibilityOutboxFileId(fromFileId, toFileId),
        remapTagOutboxFileId(fromFileId, toFileId),
        removeDerivedReplaceOutboxEntries([fromFileId]),
    ]);
};

/**
 * Single-flight remote sync. Concurrent callers share one run so overlapping
 * bootstrap / outbox drains cannot race cursors against encrypted file writes.
 */
let syncRemoteInFlight: Promise<void> | undefined;

const createLibraryStore: StateCreator<LibraryState> = (set, get) => ({
    ...initialState,

    getFileById: (fileId: number): EnteFile | undefined => {
        const { allFiles, fileIndexById } = get();
        const index = fileIndexById.get(fileId);
        return index === undefined ? undefined : allFiles[index];
    },

    bootstrapFromCache: async (): Promise<boolean> => {
        const core = getEnteCore();
        const userId = core.getUserID();
        const masterKey = core.getMasterKey();

        bindOrganizerDB(userId);
        const cacheKey = await initSessionCacheKey(masterKey);

        set({ syncStatus: "loadingFromCache", syncError: undefined });

        const [collections, files, tagIndex] = await Promise.all([
            loadEncryptedCollections(cacheKey),
            loadEncryptedFiles(cacheKey),
            loadEncryptedTagIndex(cacheKey),
        ]);

        await import("@/stores/view-sessions-store").then(
            ({ useViewSessionsStore }) =>
                useViewSessionsStore.getState().hydrateFromCache(),
        );

        if (!files?.length && !collections?.length) {
            set({ syncStatus: "idle" });
            return false;
        }

        await hydrateTagOutbox();
        await hydrateFavoriteOutbox();
        await ensureVisibilityOutboxHydrated();
        await useTrashStore.getState().hydrateFromCache();
        const filesWithOutbox = excludeLocallyTrashedFiles(
            applyOutboxVisibilityToFiles(applyOutboxTagsToFiles(files ?? [])),
        );

        set({
            collections: collections ?? [],
            allFiles: filesWithOutbox,
            fileIndexById: buildFileIndexById(filesWithOutbox),
            filesRevision: get().filesRevision + 1,
            syncStatus: "success",
        });

        if (tagIndex && getTagOutboxEntries().length === 0) {
            useTagStore.getState().hydrateFromPersisted(tagIndex);
        } else {
            useTagStore.getState().rebuildFromFiles(filesWithOutbox);
        }

        rebuildFavoritesFromLibrary(userId, collections ?? [], filesWithOutbox);

        const organizerCollection = (collections ?? []).find((collection) =>
            isOrganizerConfigCollection(collection));
        if (organizerCollection) {
            const config = organizerAppConfigFromCollection(organizerCollection);
            useSettingsStore.getState().hydrateFromOrganizerConfig(config);
            void import("@/stores/tag-speed-store").then(({ useTagSpeedStore }) => {
                useTagSpeedStore.getState().hydrateFromOrganizerConfig({
                    tagPresets: config.tagPresets,
                    pinnedTags: config.pinnedTags,
                });
            });
        }

        return Boolean(files?.length);
    },

    syncRemote: async (): Promise<void> => {
        if (syncRemoteInFlight) {
            return syncRemoteInFlight;
        }

        syncRemoteInFlight = (async (): Promise<void> => {
            set({
                syncStatus: "syncing",
                syncError: undefined,
                syncProgress: { current: 0, total: 0 },
            });

            try {
                let { collections, allFiles } = get();

                const collectionsPull = await pullCollections(collections);
                collections = collectionsPull.collections;

                const core = getEnteCore();
                const organizerBootstrap = await core.bootstrapOrganizerConfig(
                    collections,
                );
                if (organizerBootstrap.created) {
                    collections = [
                        ...collections.filter(
                            (collection) =>
                                collection.id !==
                                organizerBootstrap.collection.id,
                        ),
                        organizerBootstrap.collection,
                    ];
                    await saveEncryptedCollections(
                        collections,
                        getSessionCacheKey(),
                    );
                }
                useTagStore.getState().hydrateTagTypes(
                    organizerBootstrap.config.tagTypes,
                );
                useTagStore.getState().hydrateRegisteredTags(
                    organizerBootstrap.config.registeredTags,
                );
                void import("@/stores/tag-speed-store").then(
                    ({ useTagSpeedStore }) => {
                        useTagSpeedStore.getState().hydrateFromOrganizerConfig({
                            tagPresets: organizerBootstrap.config.tagPresets,
                            pinnedTags: organizerBootstrap.config.pinnedTags,
                        });
                    },
                );
                useAlbumStore.getState().hydrateFromOrganizerConfig(
                    organizerBootstrap.config.queryAlbums,
                );
                useSettingsStore.getState().hydrateFromOrganizerConfig(
                    organizerBootstrap.config,
                );

                const filesPull = await pullFiles({
                    collections,
                    files: allFiles,
                    onProgress: (current, total) => {
                        set({ syncProgress: { current, total } });
                    },
                });

                const liveFiles = get().allFiles;
                allFiles = filesPull.files;
                await ensureTagOutboxHydrated();
                await ensureFavoriteOutboxHydrated();
                await ensureVisibilityOutboxHydrated();
                await reconcileTagOutboxWithFiles(allFiles);
                await reconcileFavoriteOutboxWithLibrary(
                    getEnteCore().getUserID(),
                    collections,
                    allFiles,
                );
                await reconcileVisibilityOutboxWithFiles(allFiles);
                allFiles = applyOutboxTagsToFiles(allFiles);
                allFiles = mergeAheadOrganizerTags(allFiles, liveFiles);
                allFiles = applyOutboxVisibilityToFiles(allFiles);
                allFiles = excludeLocallyTrashedFiles(allFiles);
                useTagStore.getState().rebuildFromFiles(allFiles);
                rebuildFavoritesFromLibrary(
                    getEnteCore().getUserID(),
                    collections,
                    allFiles,
                );
                // Re-read trash immediately before commit so a delete that
                // finished during rebuild cannot be resurrected by this pull.
                allFiles = excludeLocallyTrashedFiles(allFiles);

                set({
                    collections,
                    allFiles,
                    fileIndexById: buildFileIndexById(allFiles),
                    filesRevision: get().filesRevision + 1,
                    syncStatus: "success",
                    syncProgress: { current: 0, total: 0 },
                });
                await saveEncryptedFiles(allFiles, getSessionCacheKey());

                void import("@/stores/trash-store").then(({ useTrashStore }) => {
                    void useTrashStore.getState().syncTrash(collections);
                });
            } catch (error) {
                const offline =
                    typeof navigator !== "undefined" && !navigator.onLine;
                set({
                    syncStatus: offline ? "offline" : "error",
                    syncError:
                        error instanceof Error ? error.message : "Sync failed",
                });
                if (!offline) {
                    throw error;
                }
            }
        })().finally(() => {
            syncRemoteInFlight = undefined;
        });

        return syncRemoteInFlight;
    },

    forceResyncLibrary: async (): Promise<void> => {
        // Wait out any in-flight sync so it cannot rewrite cursors after we clear.
        if (syncRemoteInFlight) {
            try {
                await syncRemoteInFlight;
            } catch {
                // Ignore; Force resync will pull from scratch next.
            }
        }
        await clearAllSyncCursors();
        await get().syncRemote();
    },

    setActiveCollection: (id: number | null): void => {
        set({ activeCollectionId: id });
    },

    patchFiles: (updated: EnteFile[]): void => {
        if (!updated.length) {
            return;
        }
        const resolvedById = new Map<number, EnteFile>();
        for (const remote of updated) {
            const outboxEntry = getTagOutboxEntry(remote.id);
            resolvedById.set(
                remote.id,
                outboxEntry ?
                    fileWithOrganizerTags(remote, outboxEntry.intendedTags) :
                    remote,
            );
        }

        const { allFiles } = get();
        const { nextFiles, notifyNeeded, persistNeeded } = planLibraryFilePatches(
            allFiles,
            resolvedById,
        );

        if (!persistNeeded) {
            return;
        }

        if (notifyNeeded) {
            commitAllFiles(set, get, nextFiles);
        } else {
            // [Note: quiet version patch] Mutate slots in place so React does
            // not re-render the gallery for metadata-version-only updates.
            for (let index = 0; index < allFiles.length; index += 1) {
                allFiles[index] = nextFiles[index]!;
            }
        }
        scheduleSaveEncryptedFiles(() => get().allFiles);
    },

    patchFile: async (updated: EnteFile): Promise<void> => {
        get().patchFiles([updated]);
    },

    applyLocalTagsOnFile: (fileId: number, intendedTags: string[]): void => {
        const { allFiles, fileIndexById } = get();
        const file = get().getFileById(fileId);
        if (!file) {
            return;
        }
        const previousTags = extractTags(file);
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        if (!patchFileInPlace(allFiles, fileId, optimisticFile, fileIndexById)) {
            return;
        }
        commitAllFiles(set, get, allFiles, { rebuildIndex: false });
        useTagStore.getState().applyFileTags(
            fileId,
            intendedTags,
            previousTags,
        );
        scheduleSaveEncryptedFiles(() => get().allFiles);
    },

    updateTagsOnFile: async (
        fileId: number,
        mutator: TagMutator,
    ): Promise<void> => {
        const { allFiles, fileIndexById } = get();
        const file = get().getFileById(fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const previousTags = extractTags(file);
        const intendedTags = applyTagMutator(mutator, previousTags);
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        if (!patchFileInPlace(allFiles, fileId, optimisticFile, fileIndexById)) {
            return;
        }

        commitAllFiles(set, get, allFiles, { rebuildIndex: false });
        useTagStore.getState().applyFileTags(
            fileId,
            intendedTags,
            previousTags,
        );
        scheduleSaveEncryptedFiles(() => get().allFiles);

        enqueueTagOutboxEntries([{ fileId, intendedTags }]);
        requestTagOutboxFlush();
    },

    renameTag: async (
        oldName: string,
        newName: string,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<BatchTagResult> => {
        const { allFiles, collections } = get();
        const fileIds =
            useTagStore.getState().fileIdsByTag.get(oldName) ?? new Set();
        const files = allFiles.filter((file) => fileIds.has(file.id));
        const mutator: TagMutator = (tags) =>
            replaceTagName(tags, oldName, newName);

        useTagStore.getState().applyTagRename(oldName, newName);
        applyOptimisticBatchTags(set, get, fileIds, mutator);

        return renameTagOnFiles(
            getEnteCore().getHttpClient(),
            files,
            collections,
            oldName,
            newName,
            (file) => get().patchFile(file),
            onProgress,
        );
    },

    deleteTag: async (
        tagName: string,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<BatchTagResult> => {
        const { allFiles, collections } = get();
        const fileIds =
            useTagStore.getState().fileIdsByTag.get(tagName) ?? new Set();
        const files = allFiles.filter((file) => fileIds.has(file.id));
        const mutator: TagMutator = (tags) => removeTagNames(tags, tagName);

        useTagStore.getState().applyTagDelete(tagName);
        applyOptimisticBatchTags(set, get, fileIds, mutator);

        return deleteTagOnFiles(
            getEnteCore().getHttpClient(),
            files,
            collections,
            tagName,
            (file) => get().patchFile(file),
            onProgress,
        );
    },

    mergeTags: async (
        sourceNames: string[],
        targetName: string,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<BatchTagResult> => {
        const { allFiles, collections } = get();
        const affectedIds = new Set<number>();
        for (const source of sourceNames) {
            const ids = useTagStore.getState().fileIdsByTag.get(source);
            if (ids) {
                for (const id of ids) {
                    affectedIds.add(id);
                }
            }
        }
        const files = allFiles.filter((file) => affectedIds.has(file.id));
        const mutator: TagMutator = (tags) =>
            mergeTagNames(tags, sourceNames, targetName);

        useTagStore.getState().applyTagMerge(sourceNames, targetName);
        applyOptimisticBatchTags(set, get, affectedIds, mutator);

        return mergeTagsOnFiles(
            getEnteCore().getHttpClient(),
            files,
            collections,
            sourceNames,
            targetName,
            (file) => get().patchFile(file),
            onProgress,
        );
    },

    setFileFavorite: async (
        file: EnteFile,
        isFavorite: boolean,
    ): Promise<void> => {
        const core = getEnteCore();
        const userId = core.getUserID();
        const { collections, allFiles } = get();
        const favoritesStore = useFavoritesStore.getState();

        favoritesStore.applyOptimisticFavorite(
            file,
            userId,
            isFavorite,
            collections,
            allFiles,
        );

        void upsertFavoriteOutboxEntry(file, userId, isFavorite)
            .then(() => {
                favoritesStore.removePending(file.id);
                return drainTagOutbox();
            })
            .catch(() => {
                favoritesStore.removePending(file.id);
            });
    },

    setFileArchived: async (
        file: EnteFile,
        archived: boolean,
    ): Promise<void> => {
        const visibility = archived ?
            ItemVisibility.archived :
            ItemVisibility.visible;
        const optimisticFile = applyOptimisticVisibility(file, visibility);
        const { allFiles: library, fileIndexById } = get();
        const allFiles = patchFileInLibrary(
            library,
            file.id,
            optimisticFile,
            fileIndexById,
        );
        if (!allFiles) {
            return;
        }
        commitAllFiles(set, get, allFiles);
        scheduleSaveEncryptedFiles(() => get().allFiles);

        void upsertVisibilityOutboxEntry(file.id, visibility)
            .then(() => drainTagOutbox())
            .catch(() => {
                // Outbox persist failed; optimistic local state remains.
            });
    },

    revertLastEdit: (
        fileId: number,
    ):
        | {
            optimisticFile: EnteFile;
            bytes: Uint8Array;
            finalize: Promise<EnteFile>;
        } |
        undefined => {
        const history = getEditHistory(fileId);
        if (!history) {
            return undefined;
        }
        // Consume this undo slot; the replace path may record a new one for redo.
        clearEditHistory(fileId);
        const { optimisticFile, finalize } = get().cropAndReplaceFileOptimistic(
            fileId,
            history.previousBytes,
            { width: history.width, height: history.height },
        );
        return {
            optimisticFile,
            bytes: history.previousBytes,
            finalize,
        };
    },

    pruneDuplicateGroups: async (
        groups: DedupGroupSelection[],
        options?: {
            dryRun?: boolean;
            onProgress?: (progress: number) => void;
        },
    ): Promise<void> => {
        const core = getEnteCore();
        const { collections, allFiles } = get();
        const ctx: CollectionFilesContext = core.getCollectionFilesContext(
            collections,
            allFiles,
        );

        const plan = planDuplicateGroupPrune(
            groups.filter((group) => group.isSelected),
        );
        if (!plan.filesToTrash.length) {
            return;
        }

        await pruneDuplicateGroups({
            ctx,
            groups,
            dryRun: options?.dryRun,
            onProgress: options?.onProgress,
        });

        if (!options?.dryRun) {
            await useTrashStore.getState().seedTrashedFiles(plan.filesToTrash);
            const trashedIds = plan.filesToTrash.map((file) => file.id);
            await removeFavoriteOutboxForFileIds(trashedIds);
            const trashedIdSet = new Set(trashedIds);
            const nextFiles = get().allFiles.filter(
                (file) => !trashedIdSet.has(file.id),
            );
            commitAllFiles(set, get, nextFiles);
            await saveEncryptedFiles(nextFiles, getSessionCacheKey());
            useTagStore.getState().rebuildFromFiles(nextFiles);
            useFavoritesStore.getState().removeTrashedFileIds(trashedIds);
            await get().syncRemote();
        }
    },

    compressAndUploadFile: async (
        fileId: number,
        compressedBytes: Uint8Array,
        dimensions: { width: number; height: number },
    ): Promise<EnteFile> => {
        const { allFiles, collections } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const collection = collections.find(
            (entry) => entry.id === file.collectionID,
        );
        if (!collection) {
            throw new Error(`Collection ${file.collectionID} not found`);
        }

        const originalSize = file.info?.fileSize;
        if (
            originalSize !== undefined &&
            !isWorthReplacing(originalSize, compressedBytes.length)
        ) {
            throw new CompressionSkippedError();
        }
        const uploaded = await getEnteCore().uploadCompressedImage(
            file,
            compressedBytes,
            collection,
            dimensions,
            compressedReplaceTitle(file),
            buildCompressedOrganizerTags(file),
        );

        return replaceSourceWithCompressed(
            set,
            get,
            file,
            uploaded,
        );
    },

    compressAndUploadMedia: async (
        fileId: number,
        options?: {
            quality?: number;
            videoCrf?: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            onStage?: (
                stage: "download" | "compress" | "upload",
                ratio?: number,
                encoder?: CompressMediaResult["encoder"],
            ) => void;
        },
        precomputed?: CompressMediaResult,
    ): Promise<EnteFile> => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        let result = precomputed;
        let originalByteLength: number;
        if (result) {
            originalByteLength =
                file.info?.fileSize && file.info.fileSize > 0 ?
                    file.info.fileSize :
                    result.bytes.length;
        } else {
            const { loadMediaBytesForEdit } = await import(
                "@/lib/load-media-bytes"
            );
            const { compressMediaBytes } = await import(
                "@/lib/transcode/compress-media"
            );
            options?.onStage?.("download", 0);
            const bytes = await loadMediaBytesForEdit(file, (progress) => {
                const total = progress.total > 0 ? progress.total : progress.loaded;
                options?.onStage?.(
                    "download",
                    total > 0 ? progress.loaded / total : undefined,
                );
            });
            originalByteLength = bytes.length;
            options?.onStage?.("download", 1);
            options?.onStage?.("compress", 0);
            result = await compressMediaBytes(file, bytes, {
                quality: options?.quality,
                videoCrf: options?.videoCrf,
                minSizeBytes: options?.minSizeBytes,
                maxLongEdge: options?.maxLongEdge,
                onProgress: (ratio) => {
                    options?.onStage?.("compress", ratio);
                },
            });
            options?.onStage?.("compress", 1, result.encoder);
        }
        if (!isWorthReplacing(originalByteLength, result.bytes.length)) {
            throw new CompressionSkippedError();
        }
        options?.onStage?.("upload", 0, result.encoder);
        const { finalize } = get().compressAndReplaceMediaOptimistic(
            fileId,
            result,
            originalByteLength,
            (ratio) => {
                options?.onStage?.("upload", ratio, result?.encoder);
            },
        );
        return finalize;
    },

    compressAndReplaceMediaOptimistic: (
        fileId: number,
        result: CompressMediaResult,
        originalByteLength: number,
        onUploadProgress?: (ratio: number) => void,
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const { allFiles, collections } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }
        if (!collections.some((entry) => entry.id === file.collectionID)) {
            throw new Error(`Collection ${file.collectionID} not found`);
        }
        if (!isWorthReplacing(originalByteLength, result.bytes.length)) {
            throw new CompressionSkippedError();
        }

        const previousTags = extractTags(file);
        const intendedTags = buildCompressedOrganizerTags(file);
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        if (!patchFileInPlace(
            allFiles,
            fileId,
            optimisticFile,
            get().fileIndexById,
        )) {
            throw new Error(`File ${fileId} not found`);
        }

        commitAllFiles(set, get, allFiles, { rebuildIndex: false });
        useTagStore.getState().applyFileTags(
            fileId,
            intendedTags,
            previousTags,
        );
        scheduleSaveEncryptedFiles(() => get().allFiles);
        setLocalMediaOverride(fileId, result.bytes);
        if (result.mimeType.startsWith("video/")) {
            queueMicrotask(() => {
                primeVideoThumbnailFromBytes(fileId, result.bytes);
            });
        } else {
            primeThumbnailFromBytes(fileId, result.bytes, result.mimeType);
        }

        const finalize = (async (): Promise<EnteFile> => {
            await upsertDerivedReplaceOutboxEntry(
                fileId,
                result.bytes,
                result.width,
                result.height,
                "compress",
            );

            let remapFromId = fileId;
            const uploaded = await enqueueDerivedReplace(
                fileId,
                result.bytes,
                { width: result.width, height: result.height },
                async (bytes, dimensions, replaceFileId) => {
                    const source = get().allFiles.find(
                        (entry) => entry.id === replaceFileId,
                    );
                    if (!source) {
                        throw new Error(`File ${replaceFileId} not found`);
                    }
                    const sourceCollection = get().collections.find(
                        (entry) => entry.id === source.collectionID,
                    );
                    if (!sourceCollection) {
                        throw new Error(
                            `Collection ${source.collectionID} not found`,
                        );
                    }
                    const uploadedMedia = await getEnteCore().uploadCompressedMedia(
                        source,
                        {
                            ...result,
                            bytes,
                            width: dimensions.width,
                            height: dimensions.height,
                        },
                        sourceCollection,
                        compressedReplaceTitle(source, result.extension),
                        buildCompressedOrganizerTags(source),
                        onUploadProgress,
                    );
                    return replaceSourceWithCompressed(
                        set,
                        get,
                        source,
                        uploadedMedia,
                    );
                },
                {
                    onCompleted: async (finalFile) => {
                        clearLocalMediaOverride(fileId);
                        await remapOutboxesAfterReplace(
                            remapFromId,
                            finalFile.id,
                        );
                        remapFromId = finalFile.id;
                    },
                },
            );
            return uploaded;
        })();

        return { optimisticFile, finalize };
    },

    rotateAndUploadFile: async (
        fileId: number,
        degrees: RotationDegrees,
    ): Promise<EnteFile> => {
        const { allFiles, collections } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const collection = collections.find(
            (entry) => entry.id === file.collectionID,
        );
        if (!collection) {
            throw new Error(`Collection ${file.collectionID} not found`);
        }

        const bytes = await getEnteCore().getDecryptedFile(file);
        const { toRenderableImageBlob } = await import(
            "@/lib/renderable-image"
        );
        const renderable = await toRenderableImageBlob(file, bytes);
        const sourceBytes = new Uint8Array(await renderable.arrayBuffer());
        const { rotateImageBytes, rotatedUploadTitle } = await import(
            "@/lib/rotate"
        );
        const rotated = await rotateImageBytes(
            sourceBytes,
            renderable.type || "image/jpeg",
            degrees,
        );
        const uploaded = await getEnteCore().uploadRotatedImage(
            file,
            rotated.bytes,
            collection,
            { width: rotated.width, height: rotated.height },
            rotatedUploadTitle(fileFileName(file)),
        );

        return appendUploadedFile(set, get, uploaded);
    },

    cropVideoAndUploadFile: async (
        fileId: number,
        crop: VideoCropRect,
    ): Promise<EnteFile> => {
        const { allFiles, collections } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const collection = collections.find(
            (entry) => entry.id === file.collectionID,
        );
        if (!collection) {
            throw new Error(`Collection ${file.collectionID} not found`);
        }

        const bytes = await getEnteCore().getDecryptedFile(file);
        const { cropVideoBytes } = await import("@/lib/video-edit");
        const cropped = await cropVideoBytes(
            bytes,
            mimeTypeForFile(file),
            crop,
            videoDimensionsFromFile(file),
        );
        const uploaded = await getEnteCore().uploadCroppedVideo(
            file,
            cropped,
            collection,
            compressedReplaceTitle(file),
            buildCroppedOrganizerTags(file),
        );

        return replaceSourceWithCompressed(
            set,
            get,
            file,
            uploaded,
        );
    },

    cropAndUploadFile: async (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
    ): Promise<EnteFile> => {
        const file = get().allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }
        return uploadCroppedAndReplace(
            set,
            get,
            file,
            croppedBytes,
            dimensions,
        );
    },

    cropAndReplaceFileOptimistic: (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
        options?: { autoCropped?: boolean },
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const previousOverride = getLocalMediaOverride(fileId)?.slice();
        const previousTags = extractTags(file);
        const intendedTags = buildCroppedOrganizerTags(file, {
            autoCropped: options?.autoCropped,
        });
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        if (!patchFileInPlace(
            allFiles,
            fileId,
            optimisticFile,
            get().fileIndexById,
        )) {
            throw new Error(`File ${fileId} not found`);
        }

        commitAllFiles(set, get, allFiles, { rebuildIndex: false });
        useTagStore.getState().applyFileTags(
            fileId,
            intendedTags,
            previousTags,
        );
        scheduleSaveEncryptedFiles(() => get().allFiles);
        setLocalMediaOverride(fileId, croppedBytes);
        primeThumbnailFromBytes(fileId, croppedBytes);

        const finalize = (async (): Promise<EnteFile> => {
            let previousBytes: Uint8Array | undefined = previousOverride;
            if (!previousBytes) {
                try {
                    previousBytes = new Uint8Array(
                        await getEnteCore().getDecryptedFile(file),
                    );
                } catch {
                    previousBytes = undefined;
                }
            }
            if (previousBytes) {
                const priorDims = videoDimensionsFromFile(file);
                recordEditHistory({
                    fileId,
                    previousBytes,
                    width: priorDims.width || dimensions.width,
                    height: priorDims.height || dimensions.height,
                    createdAt: Date.now(),
                    kind: "crop",
                });
            }

            await upsertDerivedReplaceOutboxEntry(
                fileId,
                croppedBytes,
                dimensions.width,
                dimensions.height,
                "crop",
            );

            let remapFromId = fileId;
            const uploaded = await enqueueDerivedReplace(
                fileId,
                croppedBytes,
                dimensions,
                async (bytes, dims, replaceFileId) => {
                    const source = get().allFiles.find(
                        (entry) => entry.id === replaceFileId,
                    );
                    if (!source) {
                        throw new Error(`File ${replaceFileId} not found`);
                    }
                    return uploadCroppedAndReplace(
                        set,
                        get,
                        source,
                        bytes,
                        dims,
                    );
                },
                {
                    onCompleted: async (finalFile) => {
                        clearLocalMediaOverride(fileId);
                        await remapOutboxesAfterReplace(
                            remapFromId,
                            finalFile.id,
                        );
                        remapFromId = finalFile.id;
                    },
                },
            );
            return uploaded;
        })();

        return { optimisticFile, finalize };
    },

    editVideoAndReplaceFileOptimistic: (
        fileId: number,
        result: CroppedVideoResult,
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        // Prefer an existing override reference — do not .slice() (doubles RAM).
        const previousOverride = getLocalMediaOverride(fileId);
        const previousTags = extractTags(file);
        const intendedTags = buildCroppedOrganizerTags(file);
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        if (!patchFileInPlace(
            allFiles,
            fileId,
            optimisticFile,
            get().fileIndexById,
        )) {
            throw new Error(`File ${fileId} not found`);
        }

        commitAllFiles(set, get, allFiles, { rebuildIndex: false });
        useTagStore.getState().applyFileTags(
            fileId,
            intendedTags,
            previousTags,
        );
        scheduleSaveEncryptedFiles(() => get().allFiles);
        setLocalMediaOverride(fileId, result.bytes);
        // Defer poster extract so it does not overlap ffmpeg WASM + source video.
        queueMicrotask(() => {
            primeVideoThumbnailFromBytes(fileId, result.bytes);
        });

        const finalize = (async (): Promise<EnteFile> => {
            // Only keep undo when we already have small override bytes in RAM —
            // never re-decrypt a full video just for history.
            if (
                previousOverride &&
                previousOverride.byteLength <= MAX_IN_MEMORY_EDIT_HISTORY_BYTES
            ) {
                const priorDims = videoDimensionsFromFile(file);
                recordEditHistory({
                    fileId,
                    previousBytes: previousOverride,
                    width: priorDims.width || result.width,
                    height: priorDims.height || result.height,
                    createdAt: Date.now(),
                    kind: "video-edit",
                });
            }

            await upsertDerivedReplaceOutboxEntry(
                fileId,
                result.bytes,
                result.width,
                result.height,
                "video-edit",
            );

            let remapFromId = fileId;
            const uploaded = await enqueueDerivedReplace(
                fileId,
                result.bytes,
                { width: result.width, height: result.height },
                async (bytes, dimensions, replaceFileId) => {
                    const source = get().allFiles.find(
                        (entry) => entry.id === replaceFileId,
                    );
                    if (!source) {
                        throw new Error(`File ${replaceFileId} not found`);
                    }
                    const { probeVideoDurationSec } = await import("@/lib/video-edit");
                    const duration = await probeVideoDurationSec(bytes, "video/mp4");
                    return uploadEditedVideoAndReplace(set, get, source, {
                        bytes,
                        width: dimensions.width,
                        height: dimensions.height,
                        duration,
                    });
                },
                {
                    onCompleted: async (finalFile) => {
                        clearLocalMediaOverride(fileId);
                        await remapOutboxesAfterReplace(
                            remapFromId,
                            finalFile.id,
                        );
                        remapFromId = finalFile.id;
                    },
                },
            );
            return uploaded;
        })();

        return { optimisticFile, finalize };
    },

    uploadImageFile: async (
        collectionId: number,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        creationTime: number,
    ): Promise<EnteFile> => {
        const collection = get().collections.find(
            (entry) => entry.id === collectionId,
        );
        if (!collection) {
            throw new Error(`Collection ${collectionId} not found`);
        }

        const uploaded = await getEnteCore().uploadLocalImage(
            collection,
            jpegBytes,
            {
                title,
                creationTime,
                width: dimensions.width,
                height: dimensions.height,
            },
        );

        return appendUploadedFile(set, get, uploaded);
    },

    uploadVideoFile: async (
        collectionId: number,
        videoBytes: Uint8Array,
        dimensions: { width: number; height: number },
        duration: number,
        title: string,
        creationTime: number,
        mimeType: string,
    ): Promise<EnteFile> => {
        const collection = get().collections.find(
            (entry) => entry.id === collectionId,
        );
        if (!collection) {
            throw new Error(`Collection ${collectionId} not found`);
        }

        const uploaded = await getEnteCore().uploadLocalVideo(
            collection,
            videoBytes,
            {
                title,
                creationTime,
                width: dimensions.width,
                height: dimensions.height,
                duration,
                mimeType,
            },
        );

        return appendUploadedFile(set, get, uploaded);
    },

    moveFilesToTrash: async (fileIds: number[]): Promise<void> => {
        const uniqueIds = [...new Set(fileIds)];
        if (!uniqueIds.length) {
            return;
        }

        const { allFiles } = get();
        const files = allFiles.filter((file) => uniqueIds.includes(file.id));
        if (!files.length) {
            throw new Error("No matching files to trash");
        }

        await getEnteCore().moveFilesToTrash(files);

        const trashedIds = new Set(files.map((file) => file.id));
        // Seed trash before dropping library rows so an in-flight syncRemote
        // cannot resurrect files the server already accepted.
        await useTrashStore.getState().seedTrashedFiles(files);
        const nextFiles = get().allFiles.filter(
            (file) => !trashedIds.has(file.id),
        );
        commitAllFiles(set, get, nextFiles);
        await saveEncryptedFiles(nextFiles, getSessionCacheKey());
        useTagStore.getState().rebuildFromFiles(nextFiles);
        useFavoritesStore.getState().removeTrashedFileIds([...trashedIds]);
        await removeFavoriteOutboxForFileIds([...trashedIds]);
    },

    reinsertRestoredFiles: async (files: EnteFile[]): Promise<void> => {
        if (!files.length) {
            return;
        }
        const byId = new Map(get().allFiles.map((file) => [file.id, file]));
        for (const file of files) {
            byId.set(file.id, file);
        }
        const nextFiles = [...byId.values()];
        commitAllFiles(set, get, nextFiles);
        await saveEncryptedFiles(nextFiles, getSessionCacheKey());
        useTagStore.getState().rebuildFromFiles(nextFiles);
        rebuildFavoritesFromLibrary(
            getEnteCore().getUserID(),
            get().collections,
            nextFiles,
        );
        for (const file of files) {
            requestThumbnail(file);
        }
    },

    batchUpdateTagsOnFiles: async (
        fileIds: number[],
        mutator: TagMutator,
    ): Promise<BatchTagResult> => {
        const uniqueIds = [...new Set(fileIds)];
        if (!uniqueIds.length) {
            return { succeeded: 0, failed: 0, errors: [] };
        }

        const { allFiles, collections } = get();
        const idSet = new Set(uniqueIds);
        const files = allFiles.filter((file) => idSet.has(file.id));
        if (!files.length) {
            return { succeeded: 0, failed: 0, errors: [] };
        }

        applyOptimisticBatchTags(set, get, idSet, mutator);

        return applyTagMutatorOnFiles(
            getEnteCore().getHttpClient(),
            files,
            collections,
            mutator,
            (verified) => get().patchFile(verified),
        );
    },

    batchSetFavorite: async (
        fileIds: number[],
        isFavorite: boolean,
    ): Promise<void> => {
        const uniqueIds = [...new Set(fileIds)];
        if (!uniqueIds.length) {
            return;
        }

        const core = getEnteCore();
        const userId = core.getUserID();
        const { collections, allFiles } = get();
        const favoritesStore = useFavoritesStore.getState();
        const favoriteFileIds = favoritesStore.favoriteFileIds;

        const files = allFiles.filter(
            (file) =>
                uniqueIds.includes(file.id) &&
                favoriteFileIds.has(file.id) !== isFavorite,
        );
        if (!files.length) {
            return;
        }

        for (const file of files) {
            favoritesStore.applyOptimisticFavorite(
                file,
                userId,
                isFavorite,
                collections,
                allFiles,
            );
        }

        void Promise.all(
            files.map((file) =>
                upsertFavoriteOutboxEntry(file, userId, isFavorite).finally(() => {
                    favoritesStore.removePending(file.id);
                })),
        ).then(() => drainTagOutbox());
    },

    batchSetArchived: async (
        fileIds: number[],
        archived: boolean,
    ): Promise<void> => {
        const uniqueIds = [...new Set(fileIds)];
        if (!uniqueIds.length) {
            return;
        }
        const files = get().allFiles.filter(
            (file) =>
                uniqueIds.includes(file.id) &&
                isFileArchivedLocally(file) !== archived,
        );
        if (!files.length) {
            return;
        }
        await Promise.all(
            files.map((file) => get().setFileArchived(file, archived)),
        );
    },

    reset: (): void => {
        cancelScheduledEncryptedFilesSave();
        useFavoritesStore.getState().reset();
        set(initialState);
    },
});

export const useLibraryStore = create<LibraryState>(createLibraryStore);

/** Flush debounced encrypted library cache (page hide / before unload). */
export const flushLibraryCachePersist = (): Promise<void> =>
    flushScheduledEncryptedFilesSave();

if (typeof window !== "undefined") {
    const flushOnHide = (): void => {
        void flushScheduledEncryptedFilesSave();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
}
