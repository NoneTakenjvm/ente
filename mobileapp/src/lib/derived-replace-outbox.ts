import { loadKv, saveKv, type PersistedDerivedReplaceOutboxEntry } from "@/db/kv";
import {
    deleteDerivedReplacePayload,
    getDerivedReplacePayload,
    putDerivedReplacePayload,
} from "@/db/derived-replace-payloads";

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
    await saveKv("derivedReplaceOutbox", entries);
};

const persist = (): Promise<void> => {
    persistChain = persistChain
        .then(() => flushToDisk())
        .catch((error: unknown) => {
            console.warn("Derived replace outbox persist failed", error);
        });
    return persistChain;
};

export const hydrateDerivedReplaceOutbox = async (): Promise<void> => {
    const persisted = await loadKv("derivedReplaceOutbox");
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

const ensureDerivedReplaceOutboxHydrated = async (): Promise<void> => {
    if (hydrated) {
        return;
    }
    await hydrateDerivedReplaceOutbox();
};

export const isDerivedReplaceOutboxHydrated = (): boolean => hydrated;

/**
 * Queue or replace the pending derived replacement for a file.
 *
 * @returns the entry's `enqueuedAt`, strictly increasing per file. Pass it to
 * {@link removeDerivedReplaceOutboxEntryIfCurrent} so a finished save never
 * removes a newer edit queued for the same file.
 */
export const upsertDerivedReplaceOutboxEntry = async (
    fileId: number,
    bytes: Uint8Array,
    width: number,
    height: number,
    kind: DerivedReplaceKind,
): Promise<number> => {
    if (!hydrated) {
        await hydrateDerivedReplaceOutbox();
    }
    // Set the entry first so an older save finishing during the payload write
    // sees a newer token and leaves this entry and payload alone.
    const enqueuedAt = Math.max(
        Date.now(),
        (outboxByFileId.get(fileId)?.enqueuedAt ?? 0) + 1,
    );
    outboxByFileId.set(fileId, { fileId, width, height, kind, enqueuedAt });
    await putDerivedReplacePayload(fileId, bytes);
    await persist();
    return enqueuedAt;
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

/**
 * Remove the entry and payload for {@link fileId} unless a newer edit has
 * replaced the entry saved with {@link enqueuedAt}.
 *
 * @returns false when a newer entry exists and nothing was removed.
 */
export const removeDerivedReplaceOutboxEntryIfCurrent = async (
    fileId: number,
    enqueuedAt: number,
): Promise<boolean> => {
    const current = outboxByFileId.get(fileId);
    if (current && current.enqueuedAt !== enqueuedAt) {
        return false;
    }
    await removeDerivedReplaceOutboxEntries([fileId]);
    return true;
};

/**
 * Re-key a pending entry and its payload after its source file was replaced.
 */
export const remapDerivedReplaceOutboxFileId = async (
    fromFileId: number,
    toFileId: number,
): Promise<void> => {
    const bytes = await getDerivedReplacePayload(fromFileId);
    const entry = outboxByFileId.get(fromFileId);
    if (!entry || !bytes) {
        return;
    }
    await putDerivedReplacePayload(toFileId, bytes);
    outboxByFileId.delete(fromFileId);
    outboxByFileId.set(toFileId, { ...entry, fileId: toFileId });
    await deleteDerivedReplacePayload(fromFileId);
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

/**
 * Drop the in-memory outbox on lock/logout.
 *
 * [Note: derived replace payloads survive lock] Only memory is cleared. The
 * encrypted payload rows and persisted metadata stay on disk so a queued edit
 * is retried after unlock. Panic deletes the whole organizer DB instead.
 */
export const clearDerivedReplaceOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistChain = Promise.resolve();
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
