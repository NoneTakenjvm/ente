import {
    loadEncryptedDerivedReplaceOutbox,
    saveEncryptedDerivedReplaceOutbox,
    type PersistedDerivedReplaceOutboxEntry,
} from "@/db/kv";
import {
    clearDerivedReplacePayloads,
    deleteDerivedReplacePayload,
    getDerivedReplacePayload,
    putDerivedReplacePayload,
} from "@/db/derived-replace-payloads";
import { getSessionCacheKey } from "@/lib/cache-key";

export type DerivedReplaceKind =
    | "crop"
    | "rotate"
    | "auto-crop"
    | "video-edit"
    | "compress";

export interface DerivedReplaceOutboxEntry {
    fileId: number;
    width: number;
    height: number;
    kind: DerivedReplaceKind;
    enqueuedAt: number;
}

const outboxByFileId = new Map<number, DerivedReplaceOutboxEntry>();
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

const flushToDisk = async (): Promise<void> => {
    const entries: PersistedDerivedReplaceOutboxEntry[] = [
        ...outboxByFileId.values(),
    ];
    await saveEncryptedDerivedReplaceOutbox(entries, getSessionCacheKey());
};

const persist = (): Promise<void> => {
    persistChain = persistChain.then(() => flushToDisk());
    return persistChain;
};

export const hydrateDerivedReplaceOutbox = async (): Promise<void> => {
    const persisted = await loadEncryptedDerivedReplaceOutbox(
        getSessionCacheKey(),
    );
    outboxByFileId.clear();
    for (const entry of persisted ?? []) {
        // Drop legacy base64-in-kv entries — payloads now live in IDB.
        if ("bytesBase64" in entry && entry.bytesBase64) {
            continue;
        }
        outboxByFileId.set(entry.fileId, {
            fileId: entry.fileId,
            width: entry.width,
            height: entry.height,
            kind: entry.kind,
            enqueuedAt: entry.enqueuedAt,
        });
    }
    hydrated = true;
};

export const ensureDerivedReplaceOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateDerivedReplaceOutbox();
};

export const isDerivedReplaceOutboxHydrated = (): boolean => hydrated;

export const upsertDerivedReplaceOutboxEntry = async (
    fileId: number,
    bytes: Uint8Array,
    width: number,
    height: number,
    kind: DerivedReplaceKind,
): Promise<void> => {
    if (!hydrated) {
        await hydrateDerivedReplaceOutbox();
    }
    await putDerivedReplacePayload(fileId, bytes);
    outboxByFileId.set(fileId, {
        fileId,
        width,
        height,
        kind,
        enqueuedAt: Date.now(),
    });
    await persist();
};

/**
 * Load pending replacement bytes for an outbox entry.
 */
export const loadDerivedReplaceOutboxBytes = async (
    fileId: number,
): Promise<Uint8Array | undefined> => getDerivedReplacePayload(fileId);

export const removeDerivedReplaceOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    for (const fileId of fileIds) {
        outboxByFileId.delete(fileId);
        await deleteDerivedReplacePayload(fileId);
    }
    await persist();
};

export const getDerivedReplaceOutboxEntries = (): DerivedReplaceOutboxEntry[] =>
    [...outboxByFileId.values()];

export const clearDerivedReplaceOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistChain = Promise.resolve();
    void clearDerivedReplacePayloads();
};
