import { decryptBox, encryptBox, generateKey } from "ente-base/crypto/libsodium";
import {
    createMagicMetadata,
    encryptMagicMetadata,
} from "ente-media/magic-metadata";
import {
    decryptRemoteCollection,
    RemoteCollection,
    type Collection,
} from "ente-media/collection";
import { z } from "zod";
import type { HttpClient } from "./http";
import { requireAuth, type CoreSession } from "../session";

const CollectionsResponse = z.object({
    collections: z.array(RemoteCollection),
});

const CollectionResponse = z.object({
    collection: RemoteCollection,
});

export interface CollectionChange {
    id: number;
    updationTime: number;
    isDeleted: boolean;
    collection?: Collection;
}

const decryptCollectionKey = async (
    collection: RemoteCollection,
    masterKey: string,
): Promise<string> =>
    decryptBox(
        {
            encryptedData: collection.encryptedKey,
            nonce: collection.keyDecryptionNonce!,
        },
        masterKey,
    );

const remoteToCollection = async (
    remote: RemoteCollection,
    masterKey: string,
): Promise<Collection> => {
    const collectionKey = await decryptCollectionKey(remote, masterKey);
    return decryptRemoteCollection(remote, collectionKey);
};

/**
 * Fetch collection changes since {@link sinceTime}.
 */
export const getCollectionChanges = async (
    http: HttpClient,
    session: CoreSession,
    sinceTime: number,
): Promise<CollectionChange[]> => {
    const { masterKey, userID } = requireAuth(session);

    const { collections } = CollectionsResponse.parse(
        await http.authFetchJSON("/collections/v2", { sinceTime }),
    );

    return Promise.all(
        collections.map(async (remote) => ({
            id: remote.id,
            updationTime: remote.updationTime,
            isDeleted: remote.isDeleted === true,
            collection:
                remote.isDeleted || remote.owner.id !== userID ?
                    undefined :
                    await remoteToCollection(remote, masterKey),
        })),
    );
};

/**
 * Fetch and decrypt collections owned by the logged-in user.
 */
export const listOwnedCollections = async (
    http: HttpClient,
    session: CoreSession,
    sinceTime = 0,
): Promise<Collection[]> => {
    const changes = await getCollectionChanges(http, session, sinceTime);
    return changes
        .filter((change) => !change.isDeleted && change.collection)
        .map((change) => change.collection!);
};

/**
 * Merge remote collection changes into a local list.
 */
export const mergeCollectionChanges = (
    existing: Collection[],
    changes: CollectionChange[],
): Collection[] => {
    const byId = new Map(existing.map((collection) => [collection.id, collection]));
    for (const change of changes) {
        if (change.isDeleted || !change.collection) {
            byId.delete(change.id);
        } else {
            byId.set(change.id, change.collection);
        }
    }
    return [...byId.values()];
};

export interface CreateRemoteCollectionOptions {
    magicMetadataData?: Record<string, unknown>;
}

/**
 * Create a collection on remote and return its decrypted local representation.
 */
export const createRemoteCollection = async (
    http: HttpClient,
    session: CoreSession,
    name: string,
    type: string,
    options?: CreateRemoteCollectionOptions,
): Promise<Collection> => {
    const { masterKey } = requireAuth(session);
    const collectionKey = await generateKey();
    const { encryptedData: encryptedKey, nonce: keyDecryptionNonce } =
        await encryptBox(collectionKey, masterKey);
    const { encryptedData: encryptedName, nonce: nameDecryptionNonce } =
        await encryptBox(new TextEncoder().encode(name), collectionKey);
    const magicMetadata = options?.magicMetadataData ?
        await encryptMagicMetadata(
            createMagicMetadata(options.magicMetadataData),
            collectionKey,
        ) :
        undefined;

    const res = await http.authFetch("/collections", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            encryptedKey,
            keyDecryptionNonce,
            encryptedName,
            nameDecryptionNonce,
            type,
            ...(magicMetadata && { magicMetadata }),
        }),
    });
    const { collection: remoteCollection } = CollectionResponse.parse(
        await res.json(),
    );
    return decryptRemoteCollection(remoteCollection, collectionKey);
};
