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
    | "crop" |
    "rotate" |
    "auto-crop" |
    "video-edit" |
    "compress";

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

const base64ToBytes = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

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
    let migratedLegacy = false;
    for (const entry of persisted ?? []) {
        const legacyBase64 =
            "bytesBase64" in entry && typeof entry.bytesBase64 === "string" ?
                entry.bytesBase64 :
                undefined;
        if (legacyBase64) {
            try {
                await putDerivedReplacePayload(
                    entry.fileId,
                    base64ToBytes(legacyBase64),
                );
                migratedLegacy = true;
            } catch {
                continue;
            }
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
    if (migratedLegacy) {
        await persist();
    }
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

/**
 * Persist the in-memory derived-replace outbox meta to encrypted IDB.
 */
export const flushDerivedReplaceOutboxPersist = (): Promise<void> => {
    if (!hydrated) {
        return ensureDerivedReplaceOutboxHydrated().then(() => persist());
    }
    return persist();
};

export const clearDerivedReplaceOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistChain = Promise.resolve();
    void clearDerivedReplacePayloads();
};

if (typeof window !== "undefined") {
    const flushOnHide = (): void => {
        void flushDerivedReplaceOutboxPersist();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushOnHide();
        }
    });
}
