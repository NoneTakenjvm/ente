import {
    createMagicMetadata,
    encryptMagicMetadata,
} from "ente-media/magic-metadata";
import type { Collection } from "ente-media/collection";

import type { HttpClient } from "./http";

export class CollectionMetadataUpdateError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "CollectionMetadataUpdateError";
    }
}

/**
 * Merge updates into a collection's private magic metadata and PUT to remote.
 */
export const updateCollectionPrivateMagicMetadata = async (
    http: HttpClient,
    collection: Collection,
    updates: Record<string, unknown>,
): Promise<void> => {
    const mergedData = {
        ...collection.magicMetadata?.data,
        ...updates,
    };
    const merged = createMagicMetadata(
        mergedData,
        collection.magicMetadata?.version,
    );
    const magicMetadata = await encryptMagicMetadata(merged, collection.key);

    const res = await http.authFetch("/collections/magic-metadata", undefined, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            id: collection.id,
            magicMetadata,
        }),
    });

    if (!res.ok) {
        throw new CollectionMetadataUpdateError(
            `Failed to update metadata for collection ${collection.id}`,
            res.status,
        );
    }

    collection.magicMetadata = {
        version: magicMetadata.version + 1,
        count: magicMetadata.count,
        data: merged.data,
    };
};
