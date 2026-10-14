import { sortFilesByUpload } from "@/lib/sort-files";
import {
    addToFavoritesCollection,
    removeFromFavoritesCollection,
    type FavoritesContext,
} from "./api/favorites";
import type {
    CollectionFilesContext,
} from "./api/collection-files";
import {
    getCollectionByID,
    getCollectionChanges,
    listOwnedCollections,
    type CollectionChange,
} from "./api/collections";
import {
    getCollectionFileDiff,
    syncCollectionFiles,
    type CollectionDiffResult,
} from "./api/files";
import { HttpClient, resolveApiOrigin } from "./api/http";
import {
    decryptFileCiphertext,
    fetchEncryptedFile,
    fetchEncryptedThumbnail,
    getDecryptedFile,
    getDecryptedThumbnail,
    type BytesProgressCallback,
    type ServerCiphertext,
} from "./download";
import { getPublicMetadata, updateFileVisibility } from "./metadata";
import type { ItemVisibility } from "ente-media/file-metadata";
import {
    bootstrapOrganizerConfig,
    patchOrganizerConfig,
    refreshOrganizerConfigCollection,
    resetOrganizerConfigState,
    type BootstrapOrganizerConfigResult,
} from "./organizer-config";
import {
    deleteFromTrash,
    emptyTrash,
    moveToTrash,
    restoreToCollection,
} from "./api/trash";
import type { UploadLocalImageOptions } from "./upload/upload-image";
import type { UploadLocalVideoOptions } from "./upload/upload-video";
import type { CompressMediaResult } from "@/lib/transcode/compress-media";
import type { CroppedVideoResult } from "@/lib/video-edit";
import {
    clearSession,
    createEmptySession,
    requireAuth,
    setSessionData,
    type CoreSession,
} from "./session";
import type { EnteCoreConfig, LoginCredentials, Session } from "./types";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import type { OrganizerAppConfig } from "@/lib/organizer-config";

export interface SyncLibraryOptions {
    collectionId?: number;
    sinceTime?: number;
    onProgress?: (current: number, total: number) => void;
}

const collectionSyncConcurrency = 2;

const dedupeFilesById = (files: EnteFile[]): EnteFile[] => {
    const byId = new Map<number, EnteFile>();
    for (const file of files) {
        byId.set(file.id, file);
    }
    return [...byId.values()];
};

export class EnteCore {
    private readonly session: CoreSession;
    private readonly http: HttpClient;

    constructor(config?: EnteCoreConfig) {
        this.session = createEmptySession();
        this.http = new HttpClient(resolveApiOrigin(config?.apiOrigin), this.session);
    }

    isAuthenticated(): boolean {
        const { authToken, masterKey, userID } = this.session;
        return Boolean(authToken && masterKey && userID !== undefined);
    }

    logout(): void {
        resetOrganizerConfigState();
        clearSession(this.session);
    }

    /** Restore an in-memory session from persisted credentials. */
    restoreSession(authToken: string, masterKey: string, userID: number): void {
        setSessionData(this.session, authToken, masterKey, userID);
    }

    async login(credentials: LoginCredentials): Promise<Session> {
        // Lazy so SRP (and its node crypto polyfills) stay out of the app shell.
        const { loginSRP } = await import("./auth/srp");
        const userID = await loginSRP(this.http, this.session, credentials);
        return { userID };
    }

    async listCollections(): Promise<Collection[]> {
        return listOwnedCollections(this.http, this.session);
    }

    async syncCollectionFiles(
        collectionId: number,
        sinceTime = 0,
        collection?: Collection,
    ): Promise<EnteFile[]> {
        const resolved =
            collection ??
            (await this.listCollections()).find((c) => c.id === collectionId);
        if (!resolved) {
            throw new Error(`Collection ${collectionId} not found`);
        }
        return syncCollectionFiles(
            this.http,
            collectionId,
            resolved.key,
            sinceTime,
        );
    }

    async syncLibrary(options?: SyncLibraryOptions): Promise<EnteFile[]> {
        const collections = await this.listCollections();
        const sinceTime = options?.sinceTime ?? 0;
        const targets = options?.collectionId ?
            collections.filter((c) => c.id === options.collectionId) :
            collections;

        if (options?.collectionId && targets.length === 0) {
            throw new Error(`Collection ${options.collectionId} not found`);
        }

        const allFiles: EnteFile[] = [];
        const total = targets.length;

        for (let i = 0; i < targets.length; i += collectionSyncConcurrency) {
            const batch = targets.slice(i, i + collectionSyncConcurrency);
            const batchResults = await Promise.all(
                batch.map(async (collection, batchIndex) => {
                    const index = i + batchIndex;
                    options?.onProgress?.(index + 1, total);
                    return syncCollectionFiles(
                        this.http,
                        collection.id,
                        collection.key,
                        sinceTime,
                    );
                }),
            );
            for (const files of batchResults) {
                allFiles.push(...files);
            }
        }

        if (options?.collectionId) {
            return sortFilesByUpload(allFiles);
        }
        return sortFilesByUpload(dedupeFilesById(allFiles));
    }

    getCollectionChanges(sinceTime: number): Promise<CollectionChange[]> {
        return getCollectionChanges(this.http, this.session, sinceTime);
    }

    getCollectionByID(collectionID: number): Promise<Collection> {
        return getCollectionByID(this.http, this.session, collectionID);
    }

    getCollectionFileDiff(
        collectionId: number,
        sinceTime: number,
    ): Promise<CollectionDiffResult> {
        return getCollectionFileDiff(this.http, collectionId, sinceTime);
    }

    fetchEncryptedThumbnail(file: EnteFile): Promise<ServerCiphertext> {
        return fetchEncryptedThumbnail(this.http, this.session, file);
    }

    fetchEncryptedFile(
        file: EnteFile,
        onProgress?: BytesProgressCallback,
        signal?: AbortSignal,
    ): Promise<ServerCiphertext> {
        return fetchEncryptedFile(
            this.http,
            this.session,
            file,
            onProgress,
            signal,
        );
    }

    decryptFileCiphertext(
        ciphertext: ServerCiphertext,
        fileKey: string,
    ): Promise<Uint8Array> {
        return decryptFileCiphertext(ciphertext, fileKey);
    }

    getDecryptedThumbnail(file: EnteFile): Promise<Uint8Array> {
        return getDecryptedThumbnail(this.http, this.session, file);
    }

    getMasterKey(): string {
        return requireAuth(this.session).masterKey;
    }

    getSessionCredentials(): {
        authToken: string;
        masterKey: string;
        userID: number;
    } {
        return requireAuth(this.session);
    }

    getDecryptedFile(
        file: EnteFile,
        onProgress?: BytesProgressCallback,
        signal?: AbortSignal,
    ): Promise<Uint8Array> {
        return getDecryptedFile(
            this.http,
            this.session,
            file,
            onProgress,
            signal,
        );
    }

    getPublicMetadata(file: EnteFile): FilePublicMagicMetadataData {
        return getPublicMetadata(file);
    }

    /**
     * Set file visibility (archive / visible) via private magic metadata.
     */
    updateFileVisibility(
        file: EnteFile,
        collectionKey: string,
        visibility: ItemVisibility,
    ): Promise<EnteFile> {
        return updateFileVisibility(
            this.http,
            file,
            collectionKey,
            visibility,
        );
    }

    getHttpClient(): HttpClient {
        return this.http;
    }

    getCollectionFilesContext(
        collections: Collection[],
        allFiles: EnteFile[],
    ): CollectionFilesContext {
        return {
            http: this.http,
            session: this.session,
            userId: this.getUserID(),
            collections,
            allFiles,
        };
    }

    async findFileById(fileId: number): Promise<EnteFile | undefined> {
        const collections = await this.listCollections();
        for (const collection of collections) {
            const files = await syncCollectionFiles(
                this.http,
                collection.id,
                collection.key,
            );
            const match = files.find((f) => f.id === fileId);
            if (match) {
                return match;
            }
        }
        return undefined;
    }

    /** Exposed for CLI — returns authenticated user ID. */
    getUserID(): number {
        return requireAuth(this.session).userID;
    }

    addToFavorites(
        files: EnteFile[],
        ctx: Omit<FavoritesContext, "http" | "session" | "userId">,
    ): Promise<number[]> {
        return addToFavoritesCollection(
            {
                http: this.http,
                session: this.session,
                userId: this.getUserID(),
                ...ctx,
            },
            files,
        );
    }

    removeFromFavorites(
        files: EnteFile[],
        ctx: Omit<FavoritesContext, "http" | "session" | "userId">,
    ): Promise<number[]> {
        return removeFromFavoritesCollection(
            {
                http: this.http,
                session: this.session,
                userId: this.getUserID(),
                ...ctx,
            },
            files,
        );
    }

    /**
     * Upload a compressed JPEG replacement for an existing file into its collection.
     */
    async uploadCompressedImage(
        sourceFile: EnteFile,
        compressedBytes: Uint8Array,
        collection: Collection,
        dimensions: { width: number; height: number },
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
        const { uploadCompressedImage: uploadCompressedImageToRemote } =
            await import("./upload/upload-image");
        return uploadCompressedImageToRemote(
            this.http,
            sourceFile,
            compressedBytes,
            collection,
            dimensions,
            title,
            organizerTags,
        );
    }

    /**
     * Upload a cropped JPEG copy of an existing file into its collection.
     */
    async uploadCroppedImage(
        sourceFile: EnteFile,
        croppedBytes: Uint8Array,
        collection: Collection,
        dimensions: { width: number; height: number },
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
        const { uploadCroppedImage: uploadCroppedImageToRemote } =
            await import("./upload/upload-image");
        return uploadCroppedImageToRemote(
            this.http,
            sourceFile,
            croppedBytes,
            collection,
            dimensions,
            title,
            organizerTags,
        );
    }

    /**
     * Upload a new JPEG from the device into the given collection.
     */
    async uploadLocalImage(
        collection: Collection,
        jpegBytes: Uint8Array,
        options: UploadLocalImageOptions,
    ): Promise<EnteFile> {
        const { uploadLocalImage: uploadLocalImageToRemote } =
            await import("./upload/upload-image");
        return uploadLocalImageToRemote(
            this.http,
            collection,
            jpegBytes,
            options,
        );
    }

    /**
     * Upload a new video from the device into the given collection.
     */
    async uploadLocalVideo(
        collection: Collection,
        video: Blob,
        options: UploadLocalVideoOptions,
    ): Promise<EnteFile> {
        const { uploadLocalVideo: uploadLocalVideoToRemote } =
            await import("./upload/upload-video");
        return uploadLocalVideoToRemote(
            this.http,
            collection,
            video,
            options,
        );
    }

    async uploadCompressedMedia(
        sourceFile: EnteFile,
        result: CompressMediaResult,
        collection: Collection,
        title: string,
        organizerTags: string[],
        onProgress?: (ratio: number) => void,
    ): Promise<EnteFile> {
        const { uploadCompressedMedia: uploadCompressedMediaToRemote } =
            await import("./upload/upload-compressed-media");
        return uploadCompressedMediaToRemote(
            this.http,
            sourceFile,
            result,
            collection,
            title,
            organizerTags,
            onProgress,
        );
    }

    /**
     * Replace image bytes on the same file id (no trash / no new id).
     */
    async updateRotatedImageInPlace(
        sourceFile: EnteFile,
        jpegBytes: Uint8Array,
        dimensions: { width: number; height: number },
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
        const { updateRotatedImageInPlace: updateRotatedImageInPlaceToRemote } =
            await import("./upload/upload-image");
        return updateRotatedImageInPlaceToRemote(
            this.http,
            sourceFile,
            jpegBytes,
            dimensions,
            title,
            organizerTags,
        );
    }

    async uploadCroppedVideo(
        sourceFile: EnteFile,
        result: CroppedVideoResult,
        collection: Collection,
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
        const { uploadCompressedMedia: uploadCompressedMediaToRemote } =
            await import("./upload/upload-compressed-media");
        return uploadCompressedMediaToRemote(
            this.http,
            sourceFile,
            {
                bytes: result.bytes,
                width: result.width,
                height: result.height,
                duration: result.duration ?? sourceFile.metadata.duration,
                mimeType: "video/mp4",
                extension: "mp4",
                encoder: "ffmpeg",
                audio: "kept",
            },
            collection,
            title,
            organizerTags,
        );
    }

    /**
     * Move files to Ente trash (recoverable for ~30 days).
     */
    moveFilesToTrash(files: EnteFile[]): Promise<void> {
        return moveToTrash(this.http, files);
    }

    /**
     * Restore trashed files into {@link collection}.
     */
    restoreFilesFromTrash(
        collection: Collection,
        files: EnteFile[],
    ): Promise<void> {
        return restoreToCollection(this.http, collection, files);
    }

    /**
     * Permanently delete files that are already in trash.
     */
    deleteFilesFromTrash(fileIDs: number[]): Promise<void> {
        return deleteFromTrash(this.http, fileIDs);
    }

    /**
     * Permanently empty trash up through {@link lastUpdatedAt}.
     */
    emptyTrash(lastUpdatedAt: number): Promise<void> {
        return emptyTrash(this.http, lastUpdatedAt);
    }

    /**
     * Locate or create the hidden organizer config collection.
     */
    bootstrapOrganizerConfig(
        collections: Collection[],
    ): Promise<BootstrapOrganizerConfigResult> {
        const userId = this.getUserID();
        refreshOrganizerConfigCollection(collections, userId);
        return bootstrapOrganizerConfig(
            this.http,
            this.session,
            collections,
            userId,
        );
    }

    /**
     * Merge a partial update into remote app config.
     */
    patchOrganizerConfig(
        patch: Partial<OrganizerAppConfig>,
    ): Promise<OrganizerAppConfig> {
        return patchOrganizerConfig(this.http, this.session, patch);
    }
}

export type { Collection } from "ente-media/collection";
export type { EnteFile } from "ente-media/file";
export type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
export type { LoginCredentials, Session, EnteCoreConfig } from "./types";
export type { BootstrapOrganizerConfigResult } from "./organizer-config";
export type { OrganizerAppConfig,
} from "@/lib/organizer-config";
