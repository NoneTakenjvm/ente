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
import {
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
import { applyTagMutator, fileWithOrganizerTags, mergeTagNames, removeTagNames, replaceTagName, tagsForFile, type TagMutator } from "@/lib/tag-writes";
import { extractTags } from "@/lib/tags";
import { scheduleTagBackgroundSync } from "@/lib/tag-background-sync";
import {
    applyOutboxTagsToFiles,
    getTagOutboxEntries,
    hydrateTagOutbox,
    upsertTagOutboxEntry,
} from "@/lib/tag-outbox";
import { enqueueDerivedReplace } from "@/lib/derived-replace-queue";
import {
    clearLocalMediaOverride,
    setLocalMediaOverride,
} from "@/lib/local-media-overrides";
import { deleteThumbnailCiphertext } from "@/db/thumbnails";
import { primeThumbnailFromBytes, requestThumbnail } from "@/lib/thumbnail-cache";
import {
    pendingFavoriteFilesByHashAndType,
    useFavoritesStore,
} from "./favorites-store";
import { useTagStore } from "./tag-store";
import {
    buildCompressedOrganizerTags,
    compressedReplaceTitle,
    CompressionSkippedError,
    isWorthReplacing,
} from "@/lib/compress";
import { buildCroppedOrganizerTags, croppedReplaceTitle } from "@/lib/crop";
import type { RotationDegrees } from "@/lib/rotate";
import type { VideoCropRect } from "@/lib/video-edit";
import { mimeTypeForFile } from "@/lib/media-kind";
import { fileFileName } from "ente-media/file-metadata";

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
    syncStatus: SyncStatus;
    syncProgress: { current: number; total: number };
    syncError: string | undefined;
    bootstrapFromCache: () => Promise<boolean>;
    syncRemote: () => Promise<void>;
    setActiveCollection: (id: number | null) => void;
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
        options?: { quality?: number; videoCrf?: number },
    ) => Promise<EnteFile>;
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
    ) => { optimisticFile: EnteFile; finalize: Promise<EnteFile> };
    uploadImageFile: (
        collectionId: number,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        creationTime: number,
    ) => Promise<EnteFile>;
    moveFilesToTrash: (fileIds: number[]) => Promise<void>;
    reset: () => void;
}

const rebuildFavoritesFromLibrary = (
    userId: number,
    collections: Collection[],
    allFiles: EnteFile[],
): void => {
    useFavoritesStore.getState().rebuildFromLibrary(userId, collections, allFiles);
};

const createTagSyncContext = (
    get: () => LibraryState,
): Parameters<typeof scheduleTagBackgroundSync>[2] => ({
    getHttp: () => getEnteCore().getHttpClient(),
    getFile: (fileId: number) =>
        get().allFiles.find((entry) => entry.id === fileId),
    getCollections: () => get().collections,
    patchFile: (file: EnteFile) => get().patchFile(file),
});

const applyOptimisticBatchTags = (
    set: (partial: Partial<LibraryState>) => void,
    get: () => LibraryState,
    fileIds: Set<number>,
    mutator: TagMutator,
): void => {
    const { allFiles } = get();
    const optimisticFiles = allFiles.map((file) => {
        if (!fileIds.has(file.id)) {
            return file;
        }
        return fileWithOrganizerTags(file, tagsForFile(file, mutator));
    });
    set({ allFiles: optimisticFiles });
    void saveEncryptedFiles(optimisticFiles, getSessionCacheKey());
    for (const file of optimisticFiles) {
        if (fileIds.has(file.id)) {
            void upsertTagOutboxEntry(file.id, extractTags(file));
        }
    }
};

const initialState: Pick<
    LibraryState,
    | "collections" |
    "activeCollectionId" |
    "allFiles" |
    "syncStatus" |
    "syncProgress" |
    "syncError"
> = {
    collections: [],
    activeCollectionId: null,
    allFiles: [],
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
    set({ allFiles: nextFiles });
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
    wasFavorite: boolean,
): Promise<EnteFile> => {
    await getEnteCore().moveFilesToTrash([sourceFile]);

    const sourceId = sourceFile.id;
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
    set({ allFiles: nextFiles });
    await saveEncryptedFiles(nextFiles, getSessionCacheKey());
    useTagStore.getState().rebuildFromFiles(nextFiles);
    useFavoritesStore.getState().removeTrashedFileIds([sourceId]);
    await deleteThumbnailCiphertext(sourceId);
    requestThumbnail(uploaded);

    if (wasFavorite) {
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

    const wasFavorite = useFavoritesStore
        .getState()
        .favoriteFileIds.has(sourceFile.id);
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
        wasFavorite,
    );
};

const createLibraryStore: StateCreator<LibraryState> = (set, get) => ({
    ...initialState,

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

        if (!files?.length && !collections?.length) {
            set({ syncStatus: "idle" });
            return false;
        }

        await hydrateTagOutbox();
        const filesWithOutbox = applyOutboxTagsToFiles(files ?? []);

        set({
            collections: collections ?? [],
            allFiles: filesWithOutbox,
            syncStatus: "success",
        });

        if (tagIndex && getTagOutboxEntries().length === 0) {
            useTagStore.getState().hydrateFromPersisted(tagIndex);
        } else {
            useTagStore.getState().rebuildFromFiles(filesWithOutbox);
        }

        rebuildFavoritesFromLibrary(userId, collections ?? [], files ?? []);

        return Boolean(files?.length);
    },

    syncRemote: async (): Promise<void> => {
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
                            collection.id !== organizerBootstrap.collection.id,
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

            const filesPull = await pullFiles({
                collections,
                files: allFiles,
                onProgress: (current, total) => {
                    set({ syncProgress: { current, total } });
                },
            });

            allFiles = filesPull.files;
            await hydrateTagOutbox();
            allFiles = applyOutboxTagsToFiles(allFiles);
            useTagStore.getState().rebuildFromFiles(allFiles);
            rebuildFavoritesFromLibrary(
                getEnteCore().getUserID(),
                collections,
                allFiles,
            );

            set({
                collections,
                allFiles,
                syncStatus: "success",
                syncProgress: { current: 0, total: 0 },
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
    },

    setActiveCollection: (id: number | null): void => {
        set({ activeCollectionId: id });
    },

    patchFile: async (updated: EnteFile): Promise<void> => {
        const allFiles = get().allFiles.map((file) => (file.id === updated.id ? updated : file));
        set({ allFiles });
        await saveEncryptedFiles(allFiles, getSessionCacheKey());
    },

    applyLocalTagsOnFile: (fileId: number, intendedTags: string[]): void => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            return;
        }
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        const optimisticFiles = allFiles.map((entry) => (
            entry.id === fileId ? optimisticFile : entry
        ));
        set({ allFiles: optimisticFiles });
        useTagStore.getState().applyFileTags(fileId, intendedTags);
        void saveEncryptedFiles(optimisticFiles, getSessionCacheKey());
    },

    updateTagsOnFile: async (
        fileId: number,
        mutator: TagMutator,
    ): Promise<void> => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const intendedTags = applyTagMutator(mutator, extractTags(file));
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        const optimisticFiles = allFiles.map((entry) => (
            entry.id === fileId ? optimisticFile : entry
        ));

        set({ allFiles: optimisticFiles });
        useTagStore.getState().applyFileTags(fileId, intendedTags);
        void saveEncryptedFiles(optimisticFiles, getSessionCacheKey());

        await upsertTagOutboxEntry(fileId, intendedTags);
        scheduleTagBackgroundSync(
            fileId,
            intendedTags,
            createTagSyncContext(get),
        );
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
        const wasFavorite = favoritesStore.favoriteFileIds.has(file.id);

        favoritesStore.addPending(file.id);
        favoritesStore.applyOptimisticFavorite(
            file,
            userId,
            isFavorite,
            collections,
            allFiles,
        );

        try {
            const ctx = {
                collections,
                allFiles,
                pendingByHashAndType: pendingFavoriteFilesByHashAndType,
            };
            if (isFavorite) {
                await core.addToFavorites([file], ctx);
            } else {
                await core.removeFromFavorites([file], ctx);
            }
            await get().syncRemote();
        } catch (error) {
            favoritesStore.revertOptimisticFavorite(
                file,
                userId,
                wasFavorite,
                collections,
                allFiles,
            );
            throw error;
        } finally {
            favoritesStore.removePending(file.id);
        }
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

        const wasFavorite = useFavoritesStore
            .getState()
            .favoriteFileIds.has(fileId);
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
            wasFavorite,
        );
    },

    compressAndUploadMedia: async (
        fileId: number,
        options?: { quality?: number; videoCrf?: number },
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

        const wasFavorite = useFavoritesStore
            .getState()
            .favoriteFileIds.has(fileId);
        const bytes = await getEnteCore().getDecryptedFile(file);
        const { compressMediaBytes } = await import("@/lib/transcode/compress-media");
        const result = await compressMediaBytes(file, bytes, options);
        if (!isWorthReplacing(bytes.length, result.bytes.length)) {
            throw new CompressionSkippedError();
        }
        const uploaded = await getEnteCore().uploadCompressedMedia(
            file,
            result,
            collection,
            compressedReplaceTitle(file),
            buildCompressedOrganizerTags(file),
        );

        return replaceSourceWithCompressed(
            set,
            get,
            file,
            uploaded,
            wasFavorite,
        );
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
        const { rotateImageBytes, rotatedUploadTitle } = await import("@/lib/rotate");
        const rotated = await rotateImageBytes(
            bytes,
            mimeTypeForFile(file),
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

        const wasFavorite = useFavoritesStore
            .getState()
            .favoriteFileIds.has(fileId);
        const bytes = await getEnteCore().getDecryptedFile(file);
        const { cropVideoBytes } = await import("@/lib/video-edit");
        const cropped = await cropVideoBytes(
            bytes,
            mimeTypeForFile(file),
            crop,
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
            wasFavorite,
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
    ): { optimisticFile: EnteFile; finalize: Promise<EnteFile> } => {
        const { allFiles } = get();
        const file = allFiles.find((entry) => entry.id === fileId);
        if (!file) {
            throw new Error(`File ${fileId} not found`);
        }

        const snapshotTags = extractTags(file);
        const intendedTags = buildCroppedOrganizerTags(file);
        const optimisticFile = fileWithOrganizerTags(file, intendedTags);
        const optimisticFiles = allFiles.map((entry) => (
            entry.id === fileId ? optimisticFile : entry
        ));

        set({ allFiles: optimisticFiles });
        useTagStore.getState().applyFileTags(fileId, intendedTags);
        void saveEncryptedFiles(optimisticFiles, getSessionCacheKey());
        setLocalMediaOverride(fileId, croppedBytes);
        primeThumbnailFromBytes(fileId, croppedBytes);

        const finalize = enqueueDerivedReplace(
            fileId,
            croppedBytes,
            dimensions,
            async (bytes, dims) => uploadCroppedAndReplace(
                set,
                get,
                file,
                bytes,
                dims,
            ),
        ).then((uploaded) => {
            clearLocalMediaOverride(fileId);
            return uploaded;
        }).catch(async (error) => {
            const revertedFiles = get().allFiles.map((entry) => (
                entry.id === fileId ?
                    fileWithOrganizerTags(file, snapshotTags) :
                    entry
            ));
            set({ allFiles: revertedFiles });
            useTagStore.getState().applyFileTags(fileId, snapshotTags);
            void saveEncryptedFiles(revertedFiles, getSessionCacheKey());
            clearLocalMediaOverride(fileId);
            requestThumbnail(file);
            throw error;
        });

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
        const nextFiles = allFiles.filter((file) => !trashedIds.has(file.id));
        set({ allFiles: nextFiles });
        await saveEncryptedFiles(nextFiles, getSessionCacheKey());
        useTagStore.getState().rebuildFromFiles(nextFiles);
        useFavoritesStore.getState().removeTrashedFileIds([...trashedIds]);
        await Promise.all(
            [...trashedIds].map((fileId) => deleteThumbnailCiphertext(fileId)),
        );
    },

    reset: (): void => {
        useFavoritesStore.getState().reset();
        set(initialState);
    },
});

export const useLibraryStore = create<LibraryState>(createLibraryStore);
