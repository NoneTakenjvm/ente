import type { PersistedAppSettings } from "@/lib/app-settings";
import { defaultAppSettings } from "@/lib/app-settings";
import type { CollectionPrivateMagicMetadataData } from "ente-media/collection";
import {
    emptyPersistedQueryAlbums,
    type PersistedQueryAlbums,
} from "@/lib/query-albums";
import {
    emptyTagTypeConfig,
    type PersistedTagTypeConfig,
} from "@/lib/tag-types";
import type { PersistedTagPresets } from "@/lib/tag-presets";
import {
    mergeCloudViewSessions,
    parseCloudViewSessions,
    type CloudViewSessionsPayload,
} from "@/lib/view-sessions";

export const ORGANIZER_COLLECTION_NAME = ".organizer";

export const ORGANIZER_ROLE = "app_config" as const;

export const ORGANIZER_ROLE_KEY = "_organizer_role" as const;

export const ORGANIZER_APP_CONFIG_KEY = "_organizer_app_v1" as const;

/**
 * Cross-device app configuration stored in the hidden organizer collection's
 * private magic metadata.
 */
export interface OrganizerAppConfig {
    version: 1;
    updatedAt: number;
    tagTypes?: PersistedTagTypeConfig;
    /** Tag names registered before any photo uses them. */
    registeredTags?: string[];
    /** Named tag bundles (kits) for one-tap apply. */
    tagPresets?: PersistedTagPresets;
    /** Tags pinned to the selection working-set bar. */
    pinnedTags?: string[];
    queryAlbums?: PersistedQueryAlbums;
    appSettings?: PersistedAppSettings;
    /**
     * Recently-viewed sessions (Recents). Merged LWW per session id; deletes
     * use tombstones. See [Note: View sessions cloud].
     */
    viewSessions?: CloudViewSessionsPayload;
}

export type OrganizerCollectionMagicMetadata =
    CollectionPrivateMagicMetadataData & {
        [ORGANIZER_ROLE_KEY]?: typeof ORGANIZER_ROLE;
        [ORGANIZER_APP_CONFIG_KEY]?: OrganizerAppConfig;
    };

export const defaultOrganizerAppConfig = (): OrganizerAppConfig => ({
    version: 1,
    updatedAt: Date.now() * 1000,
    tagTypes: emptyTagTypeConfig(),
    queryAlbums: emptyPersistedQueryAlbums(),
    appSettings: defaultAppSettings(),
});

/**
 * Merge a partial config update into the current document.
 *
 * `viewSessions` is LWW-merged (not replaced) so a multi-device 409 retry keeps
 * sessions from both sides.
 */
export const mergeOrganizerAppConfig = (
    current: OrganizerAppConfig | undefined,
    patch: Partial<OrganizerAppConfig>,
): OrganizerAppConfig => {
    const merged: OrganizerAppConfig = {
        ...defaultOrganizerAppConfig(),
        ...current,
        ...patch,
        version: 1,
        updatedAt: Date.now() * 1000,
    };
    if (patch.viewSessions !== undefined) {
        merged.viewSessions = mergeCloudViewSessions(
            current?.viewSessions,
            patch.viewSessions,
        );
    }
    return merged;
};

export const organizerMagicMetadata = (
    collection: { magicMetadata?: { data: unknown } },
): OrganizerCollectionMagicMetadata | undefined =>
    collection.magicMetadata?.data as
        OrganizerCollectionMagicMetadata |
        undefined;

export const organizerAppConfigFromCollection = (
    collection: { magicMetadata?: { data: unknown } },
): OrganizerAppConfig => {
    const raw = organizerMagicMetadata(collection)?._organizer_app_v1;
    const config = mergeOrganizerAppConfig(raw, {});
    const viewSessions = parseCloudViewSessions(raw?.viewSessions);
    if (viewSessions) {
        config.viewSessions = viewSessions;
    } else {
        delete config.viewSessions;
    }
    return config;
};

export const isOrganizerConfigCollection = (
    collection: { magicMetadata?: { data: unknown } },
): boolean =>
    organizerMagicMetadata(collection)?._organizer_role === ORGANIZER_ROLE;
