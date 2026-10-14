import type { CollectionFileChange } from "@/core/api/files";
import { loadKv, saveKv } from "@/db/kv";
import { createCoalescedWriter } from "@/lib/outbox";
import { registerFlush, registerReset } from "@/lib/session-lifecycle";

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
let hydrateInFlight: Promise<void> | undefined;

const writer = createCoalescedWriter(
    () => saveKv("favoriteMembership", [...membershipIds]),
    "Favourite membership",
);

const persistMembership = writer.persist;

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
        const persisted = validMembershipIds(await loadKv("favoriteMembership"));
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

/** Hydrate membership from IDB if not already loaded. */
export const ensureFavoriteMembershipHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateFavoriteMembership();
};

/** True after at least one successful Favourites membership sync or hydrate. */
export const isFavoriteMembershipReady = (): boolean => ready;

/** When true, the next Favourites pull should start from sinceTime 0. */
export const needsFavoriteMembershipFullSync = (): boolean => needsFullSync;

/**
 * Snapshot of server membership file IDs (Favourites collection rows).
 */
export const getFavoriteMembershipIds = (): Set<number> =>
    new Set(membershipIds);

/**
 * Clear in-memory membership and force a full Favourites re-pull.
 * Used for Manage force-resync and at the start of a full membership rebuild.
 */
export const resetFavoriteMembershipForFullSync = (): void => {
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

/** Await pending membership encrypt to IDB (hide / logout). */
export const flushFavoriteMembershipPersist = writer.flush;

/** Wipe in-memory membership on logout; forces next full Favourites pull. */
export const clearFavoriteMembership = (): void => {
    membershipIds.clear();
    hydrated = false;
    ready = false;
    needsFullSync = true;
    hydrateInFlight = undefined;
    writer.reset();
};

registerFlush(flushFavoriteMembershipPersist);
registerReset(clearFavoriteMembership);

/** Persisted ids when every entry is a finite number; otherwise `undefined`. */
const validMembershipIds = (decoded: unknown): number[] | undefined => {
    if (!Array.isArray(decoded)) {
        return undefined;
    }
    const ids = decoded.filter(
        (id): id is number => typeof id === "number" && Number.isFinite(id),
    );
    return ids.length === decoded.length ? ids : undefined;
};
