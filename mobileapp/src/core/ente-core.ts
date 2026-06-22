import { fileCreationTime } from "ente-media/file-metadata";
import { loginSRP } from "./auth/srp";
import {
    addToFavoritesCollection,
    removeFromFavoritesCollection,
    type FavoritesContext,
} from "./api/favorites";
import type {
    CollectionFilesContext,
} from "./api/collection-files";
import {
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
    fetchEncryptedThumbnail,
    getDecryptedFile,
    getDecryptedThumbnail,
    type ServerCiphertext,
} from "./download";
import { getPublicMetadata, updatePublicMetadata } from "./metadata";
import { moveToTrash } from "./api/trash";
import {
    uploadCompressedImage as uploadCompressedImageToRemote,
    uploadCroppedImage as uploadCroppedImageToRemote,
    uploadLocalImage as uploadLocalImageToRemote,
    uploadRotatedImage as uploadRotatedImageToRemote,
    type UploadLocalImageOptions,
} from "./upload/upload-image";
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

const sortFilesNewestFirst = (files: EnteFile[]): EnteFile[] =>
    [...files].sort((a, b) => fileCreationTime(b) - fileCreationTime(a));

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
        clearSession(this.session);
    }

    /** Restore an in-memory session from persisted credentials. */
    restoreSession(authToken: string, masterKey: string, userID: number): void {
        setSessionData(this.session, authToken, masterKey, userID);
    }

    async login(credentials: LoginCredentials): Promise<Session> {
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
            return sortFilesNewestFirst(allFiles);
        }
        return sortFilesNewestFirst(dedupeFilesById(allFiles));
    }

    getCollectionChanges(sinceTime: number): Promise<CollectionChange[]> {
        return getCollectionChanges(this.http, this.session, sinceTime);
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

    getDecryptedFile(file: EnteFile): Promise<Uint8Array> {
        return getDecryptedFile(this.http, this.session, file);
    }

    getPublicMetadata(file: EnteFile): FilePublicMagicMetadataData {
        return getPublicMetadata(file);
    }

    updatePublicMetadata(
        file: EnteFile,
        updates: Partial<FilePublicMagicMetadataData>,
    ): Promise<void> {
        return updatePublicMetadata(this.http, file, updates);
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
    ): Promise<void> {
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
    ): Promise<void> {
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
    uploadCompressedImage(
        sourceFile: EnteFile,
        compressedBytes: Uint8Array,
        collection: Collection,
        dimensions: { width: number; height: number },
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
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
    uploadCroppedImage(
        sourceFile: EnteFile,
        croppedBytes: Uint8Array,
        collection: Collection,
        dimensions: { width: number; height: number },
        title: string,
        organizerTags: string[],
    ): Promise<EnteFile> {
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
    uploadLocalImage(
        collection: Collection,
        jpegBytes: Uint8Array,
        options: UploadLocalImageOptions,
    ): Promise<EnteFile> {
        return uploadLocalImageToRemote(
            this.http,
            collection,
            jpegBytes,
            options,
        );
    }

    async uploadCompressedMedia(
        sourceFile: EnteFile,
        result: CompressMediaResult,
        collection: Collection,
        title: string,
        organizerTags: string[],
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
        );
    }

    uploadRotatedImage(
        sourceFile: EnteFile,
        jpegBytes: Uint8Array,
        collection: Collection,
        dimensions: { width: number; height: number },
        title: string,
    ): Promise<EnteFile> {
        return uploadRotatedImageToRemote(
            this.http,
            sourceFile,
            jpegBytes,
            collection,
            dimensions,
            title,
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
                duration: sourceFile.metadata.duration,
                mimeType: "video/mp4",
                extension: "mp4",
            },
            collection,
            title,
            organizerTags,
        );
    }

    /**
     * Move files to Ente trash (recoverable in the official app).
     */
    moveFilesToTrash(files: EnteFile[]): Promise<void> {
        return moveToTrash(this.http, files);
    }
}

export type { Collection } from "ente-media/collection";
export type { EnteFile } from "ente-media/file";
export type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
export type { LoginCredentials, Session, EnteCoreConfig } from "./types";
