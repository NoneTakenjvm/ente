import type { EnteFile } from "ente-media/file";
import type { FilePublicMagicMetadataData } from "ente-media/file-metadata";
import {
    loadEncryptedTagOutbox,
    saveEncryptedTagOutbox,
    type PersistedTagOutboxEntry,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";
import { extractTags } from "@/lib/tags";
import {
    fileWithOrganizerTags,
    tagsEqual,
    type OrganizerPublicMetadata,
} from "@/lib/tag-writes";

export interface TagOutboxEntry {
    fileId: number;
    intendedTags: string[];
    enqueuedAt: number;
}

const outboxByFileId = new Map<number, TagOutboxEntry>();
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

const toPersisted = (entry: TagOutboxEntry): PersistedTagOutboxEntry => ({
    fileId: entry.fileId,
    intendedTags: entry.intendedTags,
    enqueuedAt: entry.enqueuedAt,
});

const flushTagOutboxToDisk = async (): Promise<void> => {
    const entries = [...outboxByFileId.values()].map(toPersisted);
    await saveEncryptedTagOutbox(entries, getSessionCacheKey());
};

const persistTagOutbox = (): Promise<void> => {
    persistChain = persistChain
        .catch(() => undefined)
        .then(() => flushTagOutboxToDisk())
        .catch((error: unknown) => {
            console.warn("Tag outbox persist failed", error);
        });
    return persistChain;
};

/**
 * Load the encrypted tag outbox from IndexedDB into memory.
 */
let tagOutboxHydrateInFlight: Promise<void> | undefined;

export const hydrateTagOutbox = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    if (tagOutboxHydrateInFlight) {
        return tagOutboxHydrateInFlight;
    }
    tagOutboxHydrateInFlight = (async () => {
        const persisted = await loadEncryptedTagOutbox(getSessionCacheKey());
        outboxByFileId.clear();
        for (const entry of persisted ?? []) {
            outboxByFileId.set(entry.fileId, entry);
        }
        hydrated = true;
    })().finally(() => {
        tagOutboxHydrateInFlight = undefined;
    });
    return tagOutboxHydrateInFlight;
};

/**
 * Load the outbox from disk once per session without clearing in-memory entries.
 */
export const ensureTagOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateTagOutbox();
};

export const isTagOutboxHydrated = (): boolean => hydrated;

/**
 * Persist the in-memory outbox to encrypted IDB (page hide / before unload).
 *
 * Does not drain to the server — only makes pending intents survive a kill.
 */
export const flushTagOutboxPersist = (): Promise<void> => {
    if (!hydrated) {
        return ensureTagOutboxHydrated().then(() => persistTagOutbox());
    }
    return persistTagOutbox();
};

/**
 * Queue or replace pending tag writes for many files (one disk persist).
 */
export const upsertTagOutboxEntries = async (
    entries: Array<{ fileId: number; intendedTags: string[] }>,
): Promise<void> => {
    if (!entries.length) {
        return;
    }
    if (!hydrated) {
        await hydrateTagOutbox();
    }
    const enqueuedAt = Date.now();
    for (const entry of entries) {
        outboxByFileId.set(entry.fileId, {
            fileId: entry.fileId,
            intendedTags: entry.intendedTags,
            enqueuedAt,
        });
    }
    await persistTagOutbox();
};

/**
 * Queue tag intents in memory immediately and schedule one disk persist.
 *
 * Prefer this on UI click paths — callers should not await encrypt/IDB.
 */
export const enqueueTagOutboxEntries = (
    entries: Array<{ fileId: number; intendedTags: string[] }>,
): void => {
    if (!entries.length) {
        return;
    }
    const apply = (): void => {
        const enqueuedAt = Date.now();
        for (const entry of entries) {
            outboxByFileId.set(entry.fileId, {
                fileId: entry.fileId,
                intendedTags: entry.intendedTags,
                enqueuedAt,
            });
        }
        void persistTagOutbox();
    };
    if (hydrated) {
        apply();
        return;
    }
    // Use ensure (not hydrate) so a concurrent bootstrap hydrate cannot clear
    // entries we are about to write after a second clear+reload race.
    void ensureTagOutboxHydrated().then(apply);
};

/**
 * Queue or replace a pending tag write for a file.
 */
export const upsertTagOutboxEntry = async (
    fileId: number,
    intendedTags: string[],
): Promise<void> => {
    await upsertTagOutboxEntries([{ fileId, intendedTags }]);
};

/**
 * Remove one or more files from the outbox after pull confirms server tags.
 */
export const removeTagOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    for (const fileId of fileIds) {
        outboxByFileId.delete(fileId);
    }
    await persistTagOutbox();
};

export const getTagOutboxEntries = (): TagOutboxEntry[] =>
    [...outboxByFileId.values()];

export const getTagOutboxEntry = (
    fileId: number,
): TagOutboxEntry | undefined => outboxByFileId.get(fileId);

/**
 * Remap a pending tag entry when a derived replace changes the file id.
 */
export const remapTagOutboxFileId = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    if (!hydrated) {
        await hydrateTagOutbox();
    }
    const existing = outboxByFileId.get(fromFileId);
    if (!existing) {
        return;
    }
    outboxByFileId.delete(fromFileId);
    outboxByFileId.set(toFileId, { ...existing, fileId: toFileId });
    await persistTagOutbox();
};

/**
 * Drop outbox entries whose pulled server metadata already matches intent.
 */
export const reconcileTagOutboxWithFiles = async (
    files: EnteFile[],
): Promise<void> => {
    if (outboxByFileId.size === 0) {
        return;
    }
    const filesById = new Map(files.map((file) => [file.id, file]));
    const verifiedIds: number[] = [];
    for (const entry of outboxByFileId.values()) {
        const file = filesById.get(entry.fileId);
        if (
            file &&
            tagsEqual(extractTags(file), entry.intendedTags)
        ) {
            verifiedIds.push(entry.fileId);
        }
    }
    if (verifiedIds.length > 0) {
        await removeTagOutboxEntries(verifiedIds);
    }
};

/**
 * Apply pending outbox tag intents onto a file list for display and indexing.
 */
export const applyOutboxTagsToFiles = (
    files: EnteFile[],
    entries: Iterable<TagOutboxEntry> = outboxByFileId.values(),
): EnteFile[] => {
    const byFileId = new Map<number, TagOutboxEntry>();
    for (const entry of entries) {
        byFileId.set(entry.fileId, entry);
    }
    if (byFileId.size === 0) {
        return files;
    }
    return files.map((file) => {
        const entry = byFileId.get(file.id);
        if (!entry) {
            return file;
        }
        return fileWithOrganizerTags(file, entry.intendedTags);
    });
};

const pubMagicVersion = (file: EnteFile): number =>
    file.pubMagicMetadata?.version && file.pubMagicMetadata.version > 0 ?
        file.pubMagicMetadata.version :
        0;

/**
 * Copy organizer tags from a live library file onto a pulled file, keeping the
 * live pub-magic version so a later PUT is not sent against a stale snapshot.
 */
const copyAheadOrganizerTags = (pulled: EnteFile, live: EnteFile): EnteFile => {
    const liveMeta = live.pubMagicMetadata;
    const pulledMeta = pulled.pubMagicMetadata;
    const liveData = liveMeta?.data as OrganizerPublicMetadata | undefined;
    const pulledData = pulledMeta?.data as OrganizerPublicMetadata | undefined;
    return {
        ...pulled,
        pubMagicMetadata: {
            version: pubMagicVersion(live) || pubMagicVersion(pulled) || 1,
            count: liveMeta?.count ?? pulledMeta?.count ?? 0,
            data: {
                ...pulledData,
                _organizer_v1: liveData?._organizer_v1,
            } as FilePublicMagicMetadataData,
        },
    };
};

/**
 * Keep local organizer-tag writes that landed (or were acked) while a pull
 * snapshot was in flight. Outbox overlays are left untouched.
 *
 * A pulled file whose live counterpart has a higher pub-magic version and
 * different tags is treated as a post-snapshot local write the pull missed.
 */
export const mergeAheadOrganizerTags = (
    pulled: EnteFile[],
    live: EnteFile[],
): EnteFile[] => {
    if (!live.length || !pulled.length) {
        return pulled;
    }
    const liveById = new Map(live.map((file) => [file.id, file]));
    let changed = false;
    const merged = pulled.map((file) => {
        if (outboxByFileId.has(file.id)) {
            return file;
        }
        const local = liveById.get(file.id);
        if (!local) {
            return file;
        }
        if (pubMagicVersion(local) <= pubMagicVersion(file)) {
            return file;
        }
        if (tagsEqual(extractTags(local), extractTags(file))) {
            return file;
        }
        changed = true;
        return copyAheadOrganizerTags(file, local);
    });
    return changed ? merged : pulled;
};

export const clearTagOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    tagOutboxHydrateInFlight = undefined;
    persistChain = Promise.resolve();
};

if (typeof window !== "undefined") {
    const flushOnHide = (): void => {
        void flushTagOutboxPersist();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
}
