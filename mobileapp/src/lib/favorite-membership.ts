import type { CollectionFileChange } from "@/core/api/files";
import {
    loadEncryptedFavoriteMembership,
    saveEncryptedFavoriteMembership,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";

/**
 * Server-oracle set of file IDs in the user's Favourites collection.
 *
 * [Note: Favourite membership vs library collectionID] The library is keyed by
 * file id only, but Ente links the same id into multiple collections. Favourites
 * detection must not use the surviving `collectionID` on a deduped row — that
 * value last-writer-wins across album sync and drifts across devices. This set
 * is updated from Favourites collection diffs and from successful favourite
 * API calls, then persisted encrypted beside the outbox.
 */

const membershipIds = new Set<number>();
let hydrated = false;
let ready = false;
let needsFullSync = true;
let persistChain: Promise<void> = Promise.resolve();
let hydrateInFlight: Promise<void> | undefined;

const flushMembershipToDisk = async (): Promise<void> => {
    await saveEncryptedFavoriteMembership(
        [...membershipIds],
        getSessionCacheKey(),
    );
};

const persistMembership = (): Promise<void> => {
    persistChain = persistChain
        .catch(() => undefined)
        .then(() => flushMembershipToDisk())
        .catch((error: unknown) => {
            console.warn("Favourite membership persist failed", error);
        });
    return persistChain;
};

/**
 * Load encrypted favourite membership from IndexedDB.
 *
 * Missing payload (upgrade / first run) marks a full Favourites pull so the
 * server remains the oracle.
 */
export const hydrateFavoriteMembership = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    if (hydrateInFlight) {
        return hydrateInFlight;
    }
    hydrateInFlight = (async () => {
        const persisted = await loadEncryptedFavoriteMembership(
            getSessionCacheKey(),
        );
        membershipIds.clear();
        if (persisted === undefined) {
            needsFullSync = true;
            ready = false;
        } else {
            for (const id of persisted) {
                membershipIds.add(id);
            }
            needsFullSync = false;
            ready = true;
        }
        hydrated = true;
    })().finally(() => {
        hydrateInFlight = undefined;
    });
    return hydrateInFlight;
};

export const ensureFavoriteMembershipHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateFavoriteMembership();
};

export const isFavoriteMembershipHydrated = (): boolean => hydrated;

/** True after at least one successful Favourites membership sync or hydrate. */
export const isFavoriteMembershipReady = (): boolean => ready;

/** When true, the next Favourites pull should start from sinceTime 0. */
export const needsFavoriteMembershipFullSync = (): boolean => needsFullSync;

/**
 * Snapshot of server membership file IDs ( Favourites collection rows ).
 */
export const getFavoriteMembershipIds = (): Set<number> =>
    new Set(membershipIds);

/**
 * Clear in-memory membership and force a full Favourites re-pull (force resync).
 */
export const resetFavoriteMembershipForFullSync = (): void => {
    membershipIds.clear();
    needsFullSync = true;
    ready = false;
};

/**
 * Begin a full Favourites membership rebuild (clears set; caller applies diffs).
 */
export const beginFavoriteMembershipFullSync = (): void => {
    membershipIds.clear();
    needsFullSync = true;
    ready = false;
};

/**
 * Apply Favourites collection file diff changes to membership.
 */
export const applyFavoriteMembershipChanges = (
    changes: CollectionFileChange[],
): void => {
    for (const change of changes) {
        if (change.isDeleted) {
            membershipIds.delete(change.id);
            continue;
        }
        if (change.file) {
            membershipIds.add(change.id);
        }
    }
};

/**
 * Record that Favourites membership now matches remote and persist it.
 */
export const commitFavoriteMembershipSync = async (): Promise<void> => {
    needsFullSync = false;
    ready = true;
    if (!hydrated) {
        hydrated = true;
    }
    await persistMembership();
};

/**
 * Add file IDs after a successful favourites add on remote.
 */
export const addFavoriteMembershipIds = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    if (!hydrated) {
        await ensureFavoriteMembershipHydrated();
    }
    for (const id of fileIds) {
        membershipIds.add(id);
    }
    ready = true;
    await persistMembership();
};

/**
 * Remove file IDs after a successful favourites remove on remote.
 */
export const removeFavoriteMembershipIds = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    if (!hydrated) {
        await ensureFavoriteMembershipHydrated();
    }
    for (const id of fileIds) {
        membershipIds.delete(id);
    }
    await persistMembership();
};

/**
 * Remap membership when a derived replace changes the file id.
 */
export const remapFavoriteMembershipFileId = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    if (!hydrated) {
        await ensureFavoriteMembershipHydrated();
    }
    if (!membershipIds.has(fromFileId)) {
        return;
    }
    membershipIds.delete(fromFileId);
    membershipIds.add(toFileId);
    await persistMembership();
};

/**
 * Drop membership for trashed file IDs.
 */
export const removeFavoriteMembershipForFileIds = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    if (!hydrated) {
        await ensureFavoriteMembershipHydrated();
    }
    let changed = false;
    for (const id of fileIds) {
        if (membershipIds.delete(id)) {
            changed = true;
        }
    }
    if (changed) {
        await persistMembership();
    }
};

export const flushFavoriteMembershipPersist = (): Promise<void> => {
    if (!hydrated) {
        return ensureFavoriteMembershipHydrated().then(() =>
            persistMembership());
    }
    return persistMembership();
};

export const clearFavoriteMembership = (): void => {
    membershipIds.clear();
    hydrated = false;
    ready = false;
    needsFullSync = true;
    hydrateInFlight = undefined;
    persistChain = Promise.resolve();
};
