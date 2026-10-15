import { create } from "zustand";
import type { StateCreator } from "zustand";
import type { EnteFile } from "ente-media/file";
import { getEnteCore, type Collection } from "@/core";
import { bindOrganizerDB } from "@/db";
import { loadKv, saveKv } from "@/db/kv";
import {
    loadEncryptedFilesSharded,
    markLibraryCacheFilesDirty,
    saveEncryptedFilesSharded,
} from "@/db/file-shards";
import { initSessionCacheKey, getSessionCacheKey } from "@/lib/cache-key";
import { createDebouncedPersist } from "@/lib/debounced-persist";
import { registerFlush, registerReset } from "@/lib/session-lifecycle";
import { pullCollections } from "@/lib/sync/pull-collections";
import { pullFiles } from "@/lib/sync/pull-files";
import { clearAllSyncCursors } from "@/db/cursors";
import {
    planDuplicateGroupPrune,
    pruneDuplicateGroups,
    type DedupGroupSelection,
} from "@/lib/dedup-prune";
import type { CollectionFilesContext } from "@/core/api/collection-files";
import { planLibraryFilePatches, patchFilesInLibrary } from "@/lib/library-file-patch";
import { buildFileIndexById } from "@/lib/library-file-index";
import { applyTagMutator, fileWithOrganizerTags, mergeTagNames, removeTagNames, replaceTagName, tagsForFile, type TagMutator } from "@/lib/tag-writes";
import { extractTags } from "@/lib/tags";
import type { TagFilterGroup } from "@/lib/tag-filter";
import { removeTagFromTree, renameTagInTree } from "@/lib/tag-filter-mutations";
import {
    applyOutboxTagsToFiles,
    enqueueTagOutboxEntries,
    ensureTagOutboxHydrated,
    getTagOutboxEntries,
    getTagOutboxEntry,
    hydrateTagOutbox,
    mergeAheadOrganizerTags,
    queueTagMutation,
    reconcileTagOutboxWithFiles,
    remapTagOutboxFileId,
    removeTagOutboxEntries,
    type BatchTagResult,
} from "@/lib/tag-outbox";
import { drainTagOutbox, flushTagOutboxNow, requestTagOutboxFlush } from "@/lib/outbox-runner";
import {
    enqueueDerivedReplace,
    type DerivedReplaceSave,
    type EnqueueDerivedReplaceOptions,
} from "@/lib/derived-replace-queue";
import {
    remapDerivedReplaceOutboxFileId,
    type DerivedReplaceKind,
    removeDerivedReplaceOutboxEntries,
    removeDerivedReplaceOutboxEntryIfCurrent,
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
    getFavoriteOutboxEntries,
    hydrateFavoriteOutbox,
    reconcileFavoriteOutboxWithLibrary,
    removeFavoriteOutboxForFileIds,
    upsertFavoriteOutboxEntry,
    remapFavoriteOutboxFileId,
} from "@/lib/favorite-outbox";
import {
    ensureFavoriteMembershipHydrated,
    hydrateFavoriteMembership,
    remapFavoriteMembershipFileId,
    removeFavoriteMembershipForFileIds,
    resetFavoriteMembershipForFullSync,
} from "@/lib/favorite-membership";
import {
    upsertVisibilityOutboxEntry,
    remapVisibilityOutboxFileId,
    applyOutboxVisibilityToFiles,
    ensureVisibilityOutboxHydrated,
    getVisibilityOutboxEntries,
    reconcileVisibilityOutboxWithFiles,
    removeVisibilityOutboxEntries,
    isFileArchivedLocally,
} from "@/lib/visibility-outbox";
import {
    isOrganizerConfigCollection,
    organizerAppConfigFromCollection,
    type OrganizerAppConfig,
} from "@/lib/organizer-config";
import { getOrganizerConfigCollection } from "@/core/organizer-config";
import { flushOrganizerConfigQueueIfReady } from "@/lib/organizer-config-save-queue";
import { registerShuffleFileSubstitution } from "@/lib/shuffle-file-substitutions";
import type { UploadCryptoWorker } from "@/core/upload/upload-crypto-pool";
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
import { removePhashEntry } from "@/lib/similarity-job";
import {
    useFavoritesStore,
} from "./favorites-store";
import { useAlbumStore } from "./album-store";
import { useSettingsStore } from "./settings-store";
import { useTagSpeedStore } from "./tag-speed-store";
import { useTagStore } from "./tag-store";
import { useTrashStore } from "./trash-store";
import { useUIStore } from "./ui-store";
import { useViewSessionsStore } from "./view-sessions-store";
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
import type { CroppedVideoResult } from "@/lib/video-edit";
import { ItemVisibility } from "ente-media/file-metadata";
import { errorMessage } from "@/lib/format";

export type SyncStatus =
    | "idle" |
    "loadingFromCache" |
    "syncing" |
    "success" |
    "error" |
    "offline";

interface LibraryState {
    collections: Collection[];
    allFiles: EnteFile[];
    /** O(1) file-id → index into {@link allFiles}. */
    fileIndexById: Map<number, number>;
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
    /**
     * Merge verified remote file metadata into the local library.
     * Batches many files into one array walk and one scheduled encrypt.
     */
    patchFiles: (updated: EnteFile[]) => void;
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
    compressAndUploadMedia: (
        fileId: number,
        bytes: Uint8Array,
        options?: {
            quality?: number;
            videoCrf?: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            /** Aborts the compression between stages (pause / stop). */
            signal?: AbortSignal;
            onStage?: (
                stage: "compress" | "upload",
                ratio?: number,
                encoder?: CompressMediaResult["encoder"],
            ) => void;
        },
    ) => Promise<{ finalize: Promise<EnteFile> }>;
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
    cropAndReplaceFileOptimistic: (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
        options?: { autoCropped?: boolean; sourceBytes?: Uint8Array },
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
        crypto?: UploadCryptoWorker,
    ) => Promise<EnteFile>;
    uploadVideoFile: (
        collectionId: number,
        video: Blob,
        dimensions: { width: number; height: number },
        duration: number,
        title: string,
        creationTime: number,
        mimeType: string,
        crypto?: UploadCryptoWorker,
    ) => Promise<EnteFile>;
    moveFilesToTrash: (fileIds: number[]) => Promise<void>;
    /** Re-add files restored from trash into the local library snapshot. */
    reinsertRestoredFiles: (files: EnteFile[]) => Promise<void>;
    batchUpdateTagsOnFiles: (
        fileIds: number[],
        mutator: TagMutator,
    ) => Promise<BatchTagResult>;
    /**
     * Overwrite each file's tags in one local commit and queue the writes
     * (e.g. bulk undo). Returns how many files were still in the library.
     */
    setTagsOnFiles: (tagsByFileId: Map<number, string[]>) => number;
    batchSetFavorite: (fileIds: number[], isFavorite: boolean) => Promise<void>;
    batchSetArchived: (fileIds: number[], archived: boolean) => Promise<void>;
    reset: () => void;
}

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
 * Keep files appended locally (uploads, derived replaces) while a pull was in
 * flight — the pull started from a snapshot that predates them.
 */
const withFilesAddedDuringPull = (
    pulled: EnteFile[],
    snapshot: EnteFile[],
    live: EnteFile[],
): EnteFile[] => {
    const knownIds = new Set<number>();
    for (const file of snapshot) {
        knownIds.add(file.id);
    }
    for (const file of pulled) {
        knownIds.add(file.id);
    }
    const added = live.filter((file) => !knownIds.has(file.id));
    return added.length ? [...pulled, ...added] : pulled;
};

/**
 * Coalesce full-library encrypt+IDB writes so tag commits stay off the
 * critical path. Trailing debounce; persists always re-read `allFiles` at
 * write time so a later patch cannot be overwritten by a stale encrypt.
 */
const ENCRYPTED_FILES_SAVE_DEBOUNCE_MS = 1500;

const encryptedFilesSaver = createDebouncedPersist(
    (getAllFiles: () => EnteFile[]) =>
        saveEncryptedFilesSharded(getAllFiles(), getSessionCacheKey()),
    ENCRYPTED_FILES_SAVE_DEBOUNCE_MS,
);

registerFlush(encryptedFilesSaver.flush);

const scheduleSaveEncryptedFiles = (
    getAllFiles: () => EnteFile[],
    dirtyFileIds?: Iterable<number>,
): void => {
    if (dirtyFileIds) {
        markLibraryCacheFilesDirty(dirtyFileIds);
    }
    encryptedFilesSaver.schedule(getAllFiles);
};

/**
 * Replace {@link LibraryState.allFiles} with a new array and refresh the id
 * index, so memo consumers of `allFiles` see the change.
 *
 * @param options.rebuildIndex pass `false` when ids and order are unchanged
 * @param options.alsoSet other state to set in the same update
 */
const commitAllFiles = (
    set: (partial: Partial<LibraryState>) => void,
    nextFiles: EnteFile[],
    options?: { rebuildIndex?: boolean; alsoSet?: Partial<LibraryState> },
): void => {
    set({
        ...options?.alsoSet,
        allFiles: nextFiles,
        ...(options?.rebuildIndex !== false ?
            { fileIndexById: buildFileIndexById(nextFiles) } :
            {}),
    });
};

/**
 * Swap library slots for the patched files (copy-on-write, ids and order
 * unchanged) and schedule the cache write.
 *
 * @returns whether any slot changed
 */
const commitFilePatches = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    patches: ReadonlyMap<number, EnteFile>,
): boolean => {
    const { allFiles, fileIndexById } = get();
    const nextFiles = patchFilesInLibrary(allFiles, patches, fileIndexById);
    if (!nextFiles) {
        return false;
    }
    commitAllFiles(set, nextFiles, { rebuildIndex: false });
    scheduleSaveEncryptedFiles(() => get().allFiles, patches.keys());
    return true;
};

/**
 * Apply new tags locally (library + index) without waiting on encrypt or network.
 */
const applyOptimisticBatchTags = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    fileIds: Set<number>,
    tagsFor: (file: EnteFile) => string[],
): void => {
    if (fileIds.size === 0) {
        return;
    }
    const tagUpdates: Array<{
        fileId: number;
        tags: string[];
        previousTags: string[];
    }> = [];
    const patches = new Map<number, EnteFile>();
    for (const fileId of fileIds) {
        const file = get().getFileById(fileId);
        if (!file) {
            continue;
        }
        const tags = tagsFor(file);
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
    if (!commitFilePatches(set, get, patches)) {
        return;
    }
    useTagStore.getState().applyFilesTags(tagUpdates);
};

const requireFile = (get: () => LibraryState, fileId: number): EnteFile => {
    const file = get().allFiles.find((entry) => entry.id === fileId);
    if (!file) {
        throw new Error(`File ${fileId} not found`);
    }
    return file;
};

const requireCollection = (
    get: () => LibraryState,
    collectionId: number,
): Collection => {
    const collection = get().collections.find(
        (entry) => entry.id === collectionId,
    );
    if (!collection) {
        throw new Error(`Collection ${collectionId} not found`);
    }
    return collection;
};

/**
 * Swap `file` for a copy carrying `intendedTags`, then update the tag index and
 * schedule the cache write. Returns the optimistic file, or `undefined` when
 * the file is no longer in the library.
 */
const applyOptimisticFileTags = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    file: EnteFile,
    intendedTags: string[],
): EnteFile | undefined => {
    const optimisticFile = fileWithOrganizerTags(file, intendedTags);
    if (!commitFilePatches(set, get, new Map([[file.id, optimisticFile]]))) {
        return undefined;
    }
    useTagStore
        .getState()
        .applyFileTags(file.id, intendedTags, extractTags(file));
    return optimisticFile;
};

/**
 * Rewrite tags across the library: update the tag index, files, pinned/kit
 * tags and query albums locally, then queue the file writes and wait for them.
 * `applyToTagStore` must run after the affected files are collected, because
 * it changes the tag index they come from.
 */
const rewriteTags = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    rewrite: {
        sourceNames: string[];
        mutator: TagMutator;
        applyToTagStore: () => void;
        rewriteTree: (root: TagFilterGroup) => TagFilterGroup;
    },
    onProgress?: (completed: number, total: number) => void,
): Promise<BatchTagResult> => {
    const { sourceNames, mutator, applyToTagStore, rewriteTree } = rewrite;
    const { fileIdsByTag } = useTagStore.getState();
    const affectedIds = new Set<number>();
    for (const source of sourceNames) {
        for (const id of fileIdsByTag.get(source) ?? []) {
            affectedIds.add(id);
        }
    }
    const files = get().allFiles.filter((file) => affectedIds.has(file.id));

    applyToTagStore();
    applyOptimisticBatchTags(set, get, affectedIds, (file) =>
        tagsForFile(file, mutator));
    useTagSpeedStore.getState().rewritePresetTags(sourceNames, mutator);
    useAlbumStore.getState().rewriteAlbumTags(sourceNames, rewriteTree);

    return queueTagMutation(files, mutator, { wait: true, onProgress });
};

const initialState: Pick<
    LibraryState,
    | "collections" |
    "allFiles" |
    "fileIndexById" |
    "syncStatus" |
    "syncProgress" |
    "syncError"
> = {
    collections: [],
    allFiles: [],
    fileIndexById: new Map(),
    syncStatus: "idle",
    syncProgress: { current: 0, total: 0 },
    syncError: undefined,
};

/** Push a cloud organizer config into the stores that mirror it. */
const applyOrganizerConfig = (config: OrganizerAppConfig): void => {
    useTagStore.getState().hydrateTagTypes(config.tagTypes);
    useTagStore.getState().hydrateRegisteredTags(config.registeredTags);
    useTagSpeedStore.getState().hydrateFromOrganizerConfig(config);
    useAlbumStore.getState().hydrateFromOrganizerConfig(config.queryAlbums);
    useSettingsStore.getState().hydrateFromOrganizerConfig(config);
};

/** Window over which finished uploads are folded into one library commit. */
const UPLOADED_FILES_COMMIT_DELAY_MS = 500;

let pendingUploadedFiles: EnteFile[] = [];
let uploadedFilesCommitTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Add a freshly uploaded file to the library.
 *
 * Each commit copies the library, rebuilds the id and tag indexes, and
 * re-renders the gallery, so a 100-file batch committing per file did ~100
 * full-library rebuilds on the main thread. Uploads finishing within
 * {@link UPLOADED_FILES_COMMIT_DELAY_MS} share one commit, and the encrypted
 * cache write goes through the usual debounce (logout still flushes it).
 */
const appendUploadedFile = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    uploaded: EnteFile,
): EnteFile => {
    pendingUploadedFiles.push(uploaded);
    uploadedFilesCommitTimer ??= setTimeout(() => {
        uploadedFilesCommitTimer = undefined;
        const { allFiles, fileIndexById } = get();
        // A sync pass may already have pulled a file uploaded in this window.
        const uploadedFiles = pendingUploadedFiles.filter(
            (file) => !fileIndexById.has(file.id),
        );
        pendingUploadedFiles = [];
        if (!uploadedFiles.length) {
            return;
        }
        const nextFiles = [...allFiles, ...uploadedFiles];
        commitAllFiles(set, nextFiles);
        useTagStore.getState().applyLibraryFilesChange({
            removedFileIds: [],
            addedFiles: uploadedFiles,
        });
        uploadedFiles.forEach(requestThumbnail);
        scheduleSaveEncryptedFiles(
            () => get().allFiles,
            uploadedFiles.map((file) => file.id),
        );
    }, UPLOADED_FILES_COMMIT_DELAY_MS);
    return uploaded;
};

/**
 * Drop files from the library, then clear the local state that refers to them:
 * tag index, favourites and the favourite, tag, visibility and derived-replace
 * outboxes. Seed the trash store first so a concurrent sync cannot resurrect
 * the files.
 *
 * @param replacement file that takes the removed file's slot. Its derived-replace
 * entry is left alone: the edit that produced it is still completing.
 */
const removeFilesFromLibrary = async (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    fileIds: number[],
    replacement?: EnteFile,
): Promise<void> => {
    const removedIds = new Set(fileIds);
    const { allFiles } = get();
    const nextFiles = allFiles.filter((file) => !removedIds.has(file.id));
    if (replacement) {
        const slot = allFiles.findIndex((file) => removedIds.has(file.id));
        nextFiles.splice(slot >= 0 ? slot : nextFiles.length, 0, replacement);
    }
    commitAllFiles(set, nextFiles);
    await saveEncryptedFilesSharded(nextFiles, getSessionCacheKey());
    useTagStore.getState().applyLibraryFilesChange({
        removedFileIds: removedIds,
        addedFiles: replacement ? [replacement] : [],
    });
    useFavoritesStore.getState().removeTrashedFileIds(fileIds);
    await Promise.all([
        removeFavoriteOutboxForFileIds(fileIds),
        removeFavoriteMembershipForFileIds(fileIds),
        removeTagOutboxEntries(fileIds),
        removeVisibilityOutboxEntries(fileIds),
        replacement ? undefined : removeDerivedReplaceOutboxEntries(fileIds),
    ]);
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
    await removeFilesFromLibrary(set, get, [sourceId], uploaded);
    await invalidateThumbnailCache(sourceId);
    const {
        clearVideoDiskCache,
        transferSessionVideoUrl,
    } = await import("@/lib/video-media-cache");
    transferSessionVideoUrl(sourceId, uploaded.id);
    clearVideoDiskCache(sourceId);
    requestThumbnail(uploaded);

    if (shouldFavorite) {
        await get().batchSetFavorite([uploaded.id], true);
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
    const uploaded = await getEnteCore().uploadCroppedImage(
        sourceFile,
        croppedBytes,
        requireCollection(get, sourceFile.collectionID),
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
    const uploaded = await getEnteCore().uploadCroppedVideo(
        sourceFile,
        result,
        requireCollection(get, sourceFile.collectionID),
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
    useViewSessionsStore.getState().remapFileId(fromFileId, toFileId);
    await Promise.all([
        remapFavoriteOutboxFileId(fromFileId, toFileId),
        remapFavoriteMembershipFileId(fromFileId, toFileId),
        remapVisibilityOutboxFileId(fromFileId, toFileId),
        remapTagOutboxFileId(fromFileId, toFileId),
    ]);
};

/**
 * Queue options for a derived replace whose outbox entry was saved with
 * {@link enqueuedAt}. Completion removes the entry only if no newer edit
 * replaced it; a failed save after an earlier one moves the entry (and the
 * local override) to the upload that replaced the source, so retry still
 * finds a live file.
 */
const derivedReplaceQueueOptions = (
    fileId: number,
    enqueuedAt: number,
): EnqueueDerivedReplaceOptions => {
    let remapFromId = fileId;
    return {
        onCompleted: async (finalFile) => {
            if (
                await removeDerivedReplaceOutboxEntryIfCurrent(
                    fileId,
                    enqueuedAt,
                )
            ) {
                clearLocalMediaOverride(fileId);
            }
            await remapOutboxesAfterReplace(remapFromId, finalFile.id);
            remapFromId = finalFile.id;
        },
        onFailed: async (_error, lastUploaded) => {
            await remapDerivedReplaceOutboxFileId(fileId, lastUploaded.id);
            const override = getLocalMediaOverride(fileId);
            if (override) {
                setLocalMediaOverride(lastUploaded.id, override);
            }
            clearLocalMediaOverride(fileId);
        },
    };
};

/** Save the outbox entry, then queue the replace with matching completion hooks. */
const queueDerivedReplace = async (
    fileId: number,
    bytes: Uint8Array,
    dimensions: { width: number; height: number },
    kind: DerivedReplaceKind,
    save: DerivedReplaceSave,
): Promise<EnteFile> => {
    const enqueuedAt = await upsertDerivedReplaceOutboxEntry(
        fileId,
        bytes,
        dimensions.width,
        dimensions.height,
        kind,
    );
    return enqueueDerivedReplace(
        fileId,
        bytes,
        dimensions,
        save,
        derivedReplaceQueueOptions(fileId, enqueuedAt),
    );
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

        // Independent IDB reads + decrypts; outboxes and trash are hydrated
        // even for an empty cache so the bootstrap hook need not re-read them.
        const [collections, files, tagIndex] = await Promise.all([
            loadKv("collections"),
            loadEncryptedFilesSharded(cacheKey),
            loadKv("tagIndex"),
            useViewSessionsStore.getState().hydrateFromCache(),
            hydrateTagOutbox(),
            hydrateFavoriteOutbox(),
            hydrateFavoriteMembership(),
            ensureVisibilityOutboxHydrated(),
            useTrashStore.getState().hydrateFromCache(),
        ]);

        if (!files?.length && !collections?.length) {
            set({ syncStatus: "idle" });
            return false;
        }

        const filesWithOutbox = excludeLocallyTrashedFiles(
            applyOutboxVisibilityToFiles(applyOutboxTagsToFiles(files ?? [])),
        );

        commitAllFiles(set, filesWithOutbox, {
            alsoSet: { collections: collections ?? [], syncStatus: "success" },
        });

        if (tagIndex && getTagOutboxEntries().length === 0) {
            useTagStore.getState().hydrateFromPersisted(tagIndex);
        } else {
            useTagStore.getState().rebuildFromFiles(filesWithOutbox);
        }

        useFavoritesStore.getState().rebuildFromLibrary(
            userId,
            collections ?? [],
            filesWithOutbox,
        );

        const organizerCollection = (collections ?? []).find((collection) =>
            isOrganizerConfigCollection(collection));
        if (organizerCollection) {
            const config = organizerAppConfigFromCollection(organizerCollection);
            applyOrganizerConfig(config);
            useViewSessionsStore.getState().hydrateFromCloud(config.viewSessions);
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
                    await saveKv("collections", collections);
                }
                applyOrganizerConfig(organizerBootstrap.config);
                await flushOrganizerConfigQueueIfReady();
                // Re-read config after flush so hydrate merges against the
                // post-write in-memory collection when a local push landed.
                const remoteOrganizer = getOrganizerConfigCollection();
                const cloudViewSessions = remoteOrganizer ?
                    organizerAppConfigFromCollection(remoteOrganizer)
                        .viewSessions :
                    organizerBootstrap.config.viewSessions;
                useViewSessionsStore.getState().hydrateFromCloud(cloudViewSessions);

                const filesBeforePull = allFiles;
                const filesPull = await pullFiles({
                    collections,
                    files: filesBeforePull,
                    onProgress: (current, total) => {
                        set({ syncProgress: { current, total } });
                    },
                });

                await Promise.all([
                    ensureTagOutboxHydrated(),
                    ensureFavoriteOutboxHydrated(),
                    ensureFavoriteMembershipHydrated(),
                    ensureVisibilityOutboxHydrated(),
                ]);

                // [Note: No-op sync skips the library recompute]
                //
                // With no pulled collection/file/favourite changes and empty
                // outboxes, everything below (outbox overlays, tag and
                // favourite rebuilds, the commit and the full save) is a pure
                // function of the live state, which already reflects it.
                const libraryUnchanged =
                    !collectionsPull.didUpdate &&
                    !organizerBootstrap.created &&
                    !filesPull.didUpdate &&
                    !filesPull.favoritesMembershipTouched &&
                    getTagOutboxEntries().length === 0 &&
                    getFavoriteOutboxEntries().length === 0 &&
                    getVisibilityOutboxEntries().length === 0;
                if (libraryUnchanged) {
                    allFiles = get().allFiles;
                    set({
                        syncStatus: "success",
                        syncProgress: { current: 0, total: 0 },
                    });
                } else {
                    allFiles = filesPull.files;
                    await reconcileTagOutboxWithFiles(allFiles);
                    await reconcileFavoriteOutboxWithLibrary(
                        getEnteCore().getUserID(),
                        collections,
                        allFiles,
                    );
                    await reconcileVisibilityOutboxWithFiles(allFiles);
                    // Read live state after the awaits above so uploads and acked
                    // tag writes that landed during the pull are kept.
                    const liveFiles = get().allFiles;
                    allFiles = applyOutboxTagsToFiles(allFiles);
                    allFiles = mergeAheadOrganizerTags(allFiles, liveFiles);
                    allFiles = withFilesAddedDuringPull(
                        allFiles,
                        filesBeforePull,
                        liveFiles,
                    );
                    allFiles = applyOutboxVisibilityToFiles(allFiles);
                    allFiles = excludeLocallyTrashedFiles(allFiles);
                    useTagStore.getState().rebuildFromFiles(allFiles);
                    useFavoritesStore.getState().rebuildFromLibrary(
                        getEnteCore().getUserID(),
                        collections,
                        allFiles,
                    );
                    // Re-read trash immediately before commit so a delete that
                    // finished during rebuild cannot be resurrected by this pull.
                    allFiles = excludeLocallyTrashedFiles(allFiles);

                    commitAllFiles(set, allFiles, {
                        alsoSet: {
                            collections,
                            syncStatus: "success",
                            syncProgress: { current: 0, total: 0 },
                        },
                    });
                    await saveEncryptedFilesSharded(allFiles, getSessionCacheKey());
                }

                void useTrashStore.getState().syncTrash(collections);

                // Pull organizer_clip mldata into local embedding cache (non-blocking).
                void import("@/lib/organizer-clip-sync").then(
                    async ({
                        pullOrganizerClipSync,
                        backfillOrganizerClipUploads,
                    }) => {
                        try {
                            const applied = await pullOrganizerClipSync(allFiles);
                            const { useEmbeddingIndexStore } = await import(
                                "@/stores/embedding-index-store"
                            );
                            // [Note: Post-sync CLIP merge needs a hydrated index]
                            //
                            // The pull already appended its vectors to the IDB
                            // chunks, so an unhydrated store picks them up when a
                            // consumer calls ensureHydrated(). Merging into it here would
                            // pin it to only the pulled vectors (setEntries marks
                            // it hydrated), and hydrating here would decrypt the
                            // whole index after every sync. The upload backfill
                            // reads the in-memory vectors, so it waits too.
                            if (!useEmbeddingIndexStore.getState().isHydrated) {
                                return;
                            }
                            if (applied.size > 0) {
                                const next = new Map(
                                    useEmbeddingIndexStore.getState().entries,
                                );
                                for (const [id, vector] of applied) {
                                    next.set(id, vector);
                                }
                                useEmbeddingIndexStore.getState().setEntries(next);
                            }
                            const local = useEmbeddingIndexStore.getState().entries;
                            if (local.size > 0) {
                                void backfillOrganizerClipUploads(
                                    allFiles,
                                    local,
                                );
                            }
                        } catch (error) {
                            console.warn(
                                "[organizer-clip] pull/backfill failed",
                                error,
                            );
                        }
                    },
                );
            } catch (error) {
                const offline =
                    typeof navigator !== "undefined" && !navigator.onLine;
                set({
                    syncStatus: offline ? "offline" : "error",
                    syncError:
                        errorMessage(error, "Sync failed"),
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
        resetFavoriteMembershipForFullSync();
        await get().syncRemote();
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

        const { allFiles, fileIndexById } = get();
        commitFilePatches(
            set,
            get,
            planLibraryFilePatches(allFiles, resolvedById, fileIndexById),
        );
    },

    updateTagsOnFile: async (
        fileId: number,
        mutator: TagMutator,
    ): Promise<void> => {
        const file = get().getFileById(fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const intendedTags = applyTagMutator(mutator, extractTags(file));
        if (!applyOptimisticFileTags(set, get, file, intendedTags)) {
            return;
        }

        enqueueTagOutboxEntries([{ fileId, intendedTags }]);
        requestTagOutboxFlush();
    },

    renameTag: (oldName, newName, onProgress) =>
        rewriteTags(
            set,
            get,
            {
                sourceNames: [oldName],
                mutator: (tags) => replaceTagName(tags, oldName, newName),
                applyToTagStore: () =>
                    useTagStore.getState().applyTagRename(oldName, newName),
                rewriteTree: (root) => renameTagInTree(root, oldName, newName),
            },
            onProgress,
        ),

    deleteTag: (tagName, onProgress) =>
        rewriteTags(
            set,
            get,
            {
                sourceNames: [tagName],
                mutator: (tags) => removeTagNames(tags, tagName),
                applyToTagStore: () =>
                    useTagStore.getState().applyTagDelete(tagName),
                rewriteTree: (root) => removeTagFromTree(root, tagName),
            },
            onProgress,
        ),

    mergeTags: (sourceNames, targetName, onProgress) =>
        rewriteTags(
            set,
            get,
            {
                sourceNames,
                mutator: (tags) => mergeTagNames(tags, sourceNames, targetName),
                applyToTagStore: () =>
                    useTagStore
                        .getState()
                        .applyTagMerge(sourceNames, targetName),
                rewriteTree: (root) =>
                    sourceNames.reduce(
                        (next, source) =>
                            renameTagInTree(next, source, targetName),
                        root,
                    ),
            },
            onProgress,
        ),

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
            await removeFilesFromLibrary(
                set,
                get,
                plan.filesToTrash.map((file) => file.id),
            );
            await get().syncRemote();
        }
    },

    compressAndUploadMedia: async (
        fileId: number,
        bytes: Uint8Array,
        options?: {
            quality?: number;
            videoCrf?: number;
            minSizeBytes?: number;
            maxLongEdge?: number;
            /** Aborts the compression between stages (pause / stop). */
            signal?: AbortSignal;
            onStage?: (
                stage: "compress" | "upload",
                ratio?: number,
                encoder?: CompressMediaResult["encoder"],
            ) => void;
        },
    ): Promise<{ finalize: Promise<EnteFile> }> => {
        const file = requireFile(get, fileId);

        const { compressMediaBytes } = await import(
            "@/lib/transcode/compress-media"
        );
        options?.onStage?.("compress", 0);
        const result = await compressMediaBytes(file, bytes, {
            quality: options?.quality,
            videoCrf: options?.videoCrf,
            minSizeBytes: options?.minSizeBytes,
            maxLongEdge: options?.maxLongEdge,
            signal: options?.signal,
            onProgress: (ratio) => {
                options?.onStage?.("compress", ratio);
            },
        });
        options?.onStage?.("compress", 1, result.encoder);
        if (!isWorthReplacing(bytes.length, result.bytes.length)) {
            throw new CompressionSkippedError();
        }
        options?.onStage?.("upload", 0, result.encoder);
        const { finalize } = get().compressAndReplaceMediaOptimistic(
            fileId,
            result,
            bytes.length,
            (ratio) => {
                options?.onStage?.("upload", ratio, result.encoder);
            },
        );
        return { finalize };
    },

    compressAndReplaceMediaOptimistic: (
        fileId: number,
        result: CompressMediaResult,
        originalByteLength: number,
        onUploadProgress?: (ratio: number) => void,
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const file = requireFile(get, fileId);
        requireCollection(get, file.collectionID);
        if (!isWorthReplacing(originalByteLength, result.bytes.length)) {
            throw new CompressionSkippedError();
        }

        const optimisticFile = applyOptimisticFileTags(
            set,
            get,
            file,
            buildCompressedOrganizerTags(file),
        );
        if (!optimisticFile) {
            throw new Error(`File ${fileId} not found`);
        }
        setLocalMediaOverride(fileId, result.bytes);
        if (result.mimeType.startsWith("video/")) {
            queueMicrotask(() => {
                primeVideoThumbnailFromBytes(fileId, result.bytes);
            });
        } else {
            primeThumbnailFromBytes(fileId, result.bytes, result.mimeType);
        }

        const finalize = queueDerivedReplace(
            fileId,
            result.bytes,
            { width: result.width, height: result.height },
            "compress",
            async (bytes, dimensions, replaceFileId) => {
                const source = requireFile(get, replaceFileId);
                const sourceCollection = requireCollection(
                    get,
                    source.collectionID,
                );
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
        );

        return { optimisticFile, finalize };
    },

    rotateAndUploadFile: async (
        fileId: number,
        degrees: RotationDegrees,
    ): Promise<EnteFile> => {
        const file = requireFile(get, fileId);

        const core = getEnteCore();
        const userId = core.getUserID();
        if (file.ownerID !== userId) {
            throw new Error("Can only rotate files you own");
        }

        const bytes = await core.getDecryptedFile(file);
        const { toRenderableImageBlob } = await import(
            "@/lib/renderable-image"
        );
        const renderable = await toRenderableImageBlob(file, bytes);
        const sourceBytes = new Uint8Array(await renderable.arrayBuffer());
        const {
            buildRotatedOrganizerTags,
            rotateImageBytes,
            rotatedReplaceTitle,
        } = await import("@/lib/rotate");
        const rotated = await rotateImageBytes(
            sourceBytes,
            renderable.type || "image/jpeg",
            degrees,
        );
        const updated = await core.updateRotatedImageInPlace(
            file,
            rotated.bytes,
            { width: rotated.width, height: rotated.height },
            rotatedReplaceTitle(file),
            buildRotatedOrganizerTags(file),
        );

        const previousTags = extractTags(file);
        const intendedTags = extractTags(updated);
        commitFilePatches(set, get, new Map([[updated.id, updated]]));
        useTagStore.getState().applyFileTags(
            updated.id,
            intendedTags,
            previousTags,
        );
        await invalidateThumbnailCache(updated.id);
        await removePhashEntry(updated.id);
        const { usePhashIndexStore } = await import("@/stores/phash-index-store");
        const { entries, setEntries } = usePhashIndexStore.getState();
        if (entries.has(updated.id)) {
            const next = new Map(entries);
            next.delete(updated.id);
            setEntries(next);
        }
        primeThumbnailFromBytes(updated.id, rotated.bytes);
        return updated;
    },

    cropAndReplaceFileOptimistic: (
        fileId: number,
        croppedBytes: Uint8Array,
        dimensions: { width: number; height: number },
        options?: { autoCropped?: boolean; sourceBytes?: Uint8Array },
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const file = requireFile(get, fileId);

        // Callers that already decoded the source pass it to skip a re-download.
        const previousOverride =
            getLocalMediaOverride(fileId)?.slice() ?? options?.sourceBytes;
        const optimisticFile = applyOptimisticFileTags(
            set,
            get,
            file,
            buildCroppedOrganizerTags(file, {
                autoCropped: options?.autoCropped,
            }),
        );
        if (!optimisticFile) {
            throw new Error(`File ${fileId} not found`);
        }
        setLocalMediaOverride(fileId, croppedBytes);
        primeThumbnailFromBytes(fileId, croppedBytes);

        const finalize = (async (): Promise<EnteFile> => {
            // Mass auto-crop keeps no undo bytes: one entry per file would grow
            // without bound over a long run (the source stays in Trash).
            let previousBytes: Uint8Array | undefined =
                options?.autoCropped ? undefined : previousOverride;
            if (!previousBytes && !options?.autoCropped) {
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

            return queueDerivedReplace(
                fileId,
                croppedBytes,
                dimensions,
                "crop",
                async (bytes, dims, replaceFileId) =>
                    uploadCroppedAndReplace(
                        set,
                        get,
                        requireFile(get, replaceFileId),
                        bytes,
                        dims,
                    ),
            );
        })();

        return { optimisticFile, finalize };
    },

    editVideoAndReplaceFileOptimistic: (
        fileId: number,
        result: CroppedVideoResult,
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const file = requireFile(get, fileId);

        // Prefer an existing override reference — do not .slice() (doubles RAM).
        const previousOverride = getLocalMediaOverride(fileId);
        const optimisticFile = applyOptimisticFileTags(
            set,
            get,
            file,
            buildCroppedOrganizerTags(file),
        );
        if (!optimisticFile) {
            throw new Error(`File ${fileId} not found`);
        }
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

            return queueDerivedReplace(
                fileId,
                result.bytes,
                { width: result.width, height: result.height },
                "video-edit",
                async (bytes, dimensions, replaceFileId) => {
                    const source = requireFile(get, replaceFileId);
                    const { probeVideoDurationSec } = await import("@/lib/video-edit");
                    const duration = await probeVideoDurationSec(bytes, "video/mp4");
                    return uploadEditedVideoAndReplace(set, get, source, {
                        bytes,
                        width: dimensions.width,
                        height: dimensions.height,
                        duration,
                    });
                },
            );
        })();

        return { optimisticFile, finalize };
    },

    uploadImageFile: async (
        collectionId: number,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        creationTime: number,
        crypto?: UploadCryptoWorker,
    ): Promise<EnteFile> => {
        const uploaded = await getEnteCore().uploadLocalImage(
            requireCollection(get, collectionId),
            jpegBytes,
            {
                title,
                creationTime,
                width: dimensions.width,
                height: dimensions.height,
                crypto,
            },
        );

        return appendUploadedFile(set, get, uploaded);
    },

    uploadVideoFile: async (
        collectionId: number,
        video: Blob,
        dimensions: { width: number; height: number },
        duration: number,
        title: string,
        creationTime: number,
        mimeType: string,
        crypto?: UploadCryptoWorker,
    ): Promise<EnteFile> => {
        const uploaded = await getEnteCore().uploadLocalVideo(
            requireCollection(get, collectionId),
            video,
            {
                title,
                creationTime,
                width: dimensions.width,
                height: dimensions.height,
                duration,
                mimeType,
                crypto,
            },
        );

        return appendUploadedFile(set, get, uploaded);
    },

    moveFilesToTrash: async (fileIds: number[]): Promise<void> => {
        const idSet = new Set(fileIds);
        if (!idSet.size) {
            return;
        }

        const { allFiles } = get();
        const files = allFiles.filter((file) => idSet.has(file.id));
        if (!files.length) {
            throw new Error("No matching files to trash");
        }

        await getEnteCore().moveFilesToTrash(files);

        // Seed trash before dropping library rows so an in-flight syncRemote
        // cannot resurrect files the server already accepted.
        await useTrashStore.getState().seedTrashedFiles(files);
        await removeFilesFromLibrary(
            set,
            get,
            files.map((file) => file.id),
        );
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
        commitAllFiles(set, nextFiles);
        await saveEncryptedFilesSharded(nextFiles, getSessionCacheKey());
        useTagStore.getState().applyLibraryFilesChange({
            removedFileIds: [],
            addedFiles: files,
        });
        useFavoritesStore.getState().rebuildFromLibrary(
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

        const { allFiles } = get();
        const idSet = new Set(uniqueIds);
        const files = allFiles.filter((file) => idSet.has(file.id));
        if (!files.length) {
            return { succeeded: 0, failed: 0, errors: [] };
        }

        applyOptimisticBatchTags(set, get, idSet, (file) =>
            tagsForFile(file, mutator));

        return queueTagMutation(files, mutator, { wait: false });
    },

    setTagsOnFiles: (tagsByFileId: Map<number, string[]>): number => {
        const entries = [...tagsByFileId]
            .filter(([fileId]) => get().getFileById(fileId))
            .map(([fileId, intendedTags]) => ({ fileId, intendedTags }));
        applyOptimisticBatchTags(
            set,
            get,
            new Set(entries.map((entry) => entry.fileId)),
            (file) => tagsByFileId.get(file.id) ?? extractTags(file),
        );
        enqueueTagOutboxEntries(entries);
        requestTagOutboxFlush();
        return entries.length;
    },

    batchSetFavorite: async (
        fileIds: number[],
        isFavorite: boolean,
    ): Promise<void> => {
        const idSet = new Set(fileIds);
        if (!idSet.size) {
            return;
        }

        const core = getEnteCore();
        const userId = core.getUserID();
        const { collections, allFiles } = get();
        const favoritesStore = useFavoritesStore.getState();
        const favoriteFileIds = favoritesStore.favoriteFileIds;

        const files = allFiles.filter(
            (file) =>
                idSet.has(file.id) &&
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
                upsertFavoriteOutboxEntry(file, userId, isFavorite)
                    .catch(() => {
                        favoritesStore.revertOptimisticFavorite(
                            file,
                            userId,
                            !isFavorite,
                            collections,
                            allFiles,
                        );
                        console.warn(
                            "Favourite outbox persist failed; reverted UI",
                        );
                    })
                    .finally(() => {
                        favoritesStore.removePending(file.id);
                    })),
        ).then(() => flushTagOutboxNow());
    },

    batchSetArchived: async (
        fileIds: number[],
        archived: boolean,
    ): Promise<void> => {
        const visibility = archived ?
            ItemVisibility.archived :
            ItemVisibility.visible;
        const { getFileById } = get();
        const patches = new Map<number, EnteFile>();
        for (const fileId of new Set(fileIds)) {
            const file = getFileById(fileId);
            if (file && isFileArchivedLocally(file) !== archived) {
                patches.set(fileId, applyOptimisticVisibility(file, visibility));
            }
        }
        if (!patches.size) {
            return;
        }
        if (!commitFilePatches(set, get, patches)) {
            return;
        }

        const outboxWrites = [...patches.keys()].map((fileId) =>
            upsertVisibilityOutboxEntry(fileId, visibility));
        void Promise.all(outboxWrites)
            .then(() => drainTagOutbox())
            .catch(() => {
                // Outbox persist failed; optimistic local state remains.
            });
    },

    reset: (): void => {
        // Prefer flush over cancel — callers that need durability await
        // flushAll before reset (logout/lock).
        void encryptedFilesSaver.flush();
        // Uploads still waiting to commit belong to the session being closed.
        clearTimeout(uploadedFilesCommitTimer);
        uploadedFilesCommitTimer = undefined;
        pendingUploadedFiles = [];
        useFavoritesStore.getState().reset();
        set(initialState);
    },
});

export const useLibraryStore = create<LibraryState>(createLibraryStore);

registerReset(() => {
    useLibraryStore.getState().reset();
});
