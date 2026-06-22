import type { Collection } from "ente-media/collection";
import { ItemVisibility } from "ente-media/file-metadata";
import {
    createRemoteCollection,
} from "./api/collections";
import { updateCollectionPrivateMagicMetadata } from "./api/collection-metadata";
import type { HttpClient } from "./api/http";
import type { CoreSession } from "./session";
import {
    defaultOrganizerAppConfig,
    isOrganizerConfigCollection,
    mergeOrganizerAppConfig,
    ORGANIZER_APP_CONFIG_KEY,
    ORGANIZER_COLLECTION_NAME,
    ORGANIZER_ROLE,
    ORGANIZER_ROLE_KEY,
    organizerAppConfigFromCollection,
    type OrganizerAppConfig,
} from "@/lib/organizer-config";

export interface BootstrapOrganizerConfigResult {
    config: OrganizerAppConfig;
    collection: Collection;
    created: boolean;
}

let organizerCollection: Collection | undefined;

export const resetOrganizerConfigState = (): void => {
    organizerCollection = undefined;
};

const findOrganizerConfigCollection = (
    collections: Collection[],
    userId: number,
): Collection | undefined =>
    collections.find(
        (collection) =>
            collection.owner.id === userId &&
            isOrganizerConfigCollection(collection),
    );

const createOrganizerConfigCollection = async (
    http: HttpClient,
    session: CoreSession,
): Promise<Collection> =>
    createRemoteCollection(
        http,
        session,
        ORGANIZER_COLLECTION_NAME,
        "album",
        {
            magicMetadataData: {
                visibility: ItemVisibility.hidden,
                [ORGANIZER_ROLE_KEY]: ORGANIZER_ROLE,
                [ORGANIZER_APP_CONFIG_KEY]: defaultOrganizerAppConfig(),
            },
        },
    );

/**
 * Locate or create the hidden organizer config collection and return its config.
 */
export const bootstrapOrganizerConfig = async (
    http: HttpClient,
    session: CoreSession,
    collections: Collection[],
    userId: number,
): Promise<BootstrapOrganizerConfigResult> => {
    let collection = findOrganizerConfigCollection(collections, userId);
    let created = false;

    if (!collection) {
        collection = await createOrganizerConfigCollection(http, session);
        created = true;
    }

    organizerCollection = collection;

    return {
        config: organizerAppConfigFromCollection(collection),
        collection,
        created,
    };
};

/**
 * Merge a partial update into remote app config and return the merged document.
 */
export const patchOrganizerConfig = async (
    http: HttpClient,
    patch: Partial<OrganizerAppConfig>,
): Promise<OrganizerAppConfig> => {
    if (!organizerCollection) {
        throw new Error("Organizer config collection not bootstrapped");
    }

    const current = organizerAppConfigFromCollection(organizerCollection);
    const next = mergeOrganizerAppConfig(current, patch);

    await updateCollectionPrivateMagicMetadata(http, organizerCollection, {
        [ORGANIZER_APP_CONFIG_KEY]: next,
    });

    return next;
};

export const getOrganizerConfigCollection = (): Collection | undefined =>
    organizerCollection;

/**
 * Replace the in-memory organizer collection after a collections sync.
 */
export const refreshOrganizerConfigCollection = (
    collections: Collection[],
    userId: number,
): void => {
    const match = findOrganizerConfigCollection(collections, userId);
    if (match) {
        organizerCollection = match;
    }
};
