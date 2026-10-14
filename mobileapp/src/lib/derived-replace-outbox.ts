import type { PersistedDerivedReplaceOutboxEntry } from "@/db/kv";
import {
    deleteDerivedReplacePayload,
    getDerivedReplacePayload,
    putDerivedReplacePayload,
} from "@/db/derived-replace-payloads";
import { createOutbox } from "@/lib/outbox";

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

let migratedLegacy = false;

const base64ToBytes = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

/**
 * Move legacy inline `bytesBase64` payloads into the payload store and drop
 * the field. An entry whose payload cannot be moved is dropped.
 */
const normalizePersistedEntries = async (
    persisted: DerivedReplaceOutboxEntry[],
): Promise<DerivedReplaceOutboxEntry[]> => {
    const entries: DerivedReplaceOutboxEntry[] = [];
    for (const entry of persisted as PersistedDerivedReplaceOutboxEntry[]) {
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
        entries.push({
            fileId: entry.fileId,
            width: entry.width,
            height: entry.height,
            kind: entry.kind,
            enqueuedAt: entry.enqueuedAt,
        });
    }
    return entries;
};

const outbox = createOutbox<DerivedReplaceOutboxEntry, number>({
    kvKey: "derivedReplaceOutbox",
    keyOf: (entry) => entry.fileId,
    label: "Derived replace outbox",
    normalize: normalizePersistedEntries,
});

export const hydrateDerivedReplaceOutbox = async (): Promise<void> => {
    await outbox.hydrate();
    if (migratedLegacy) {
        migratedLegacy = false;
        await outbox.persist();
    }
};

export const isDerivedReplaceOutboxHydrated = outbox.isHydrated;

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
    await hydrateDerivedReplaceOutbox();
    // Set the entry first so an older save finishing during the payload write
    // sees a newer token and leaves this entry and payload alone.
    const enqueuedAt = Math.max(
        Date.now(),
        (outbox.get(fileId)?.enqueuedAt ?? 0) + 1,
    );
    outbox.put({ fileId, width, height, kind, enqueuedAt });
    await putDerivedReplacePayload(fileId, bytes);
    await outbox.persist();
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
    const idSet = new Set(fileIds);
    await outbox.removeWhere((entry) => idSet.has(entry.fileId));
    for (const fileId of fileIds) {
        await deleteDerivedReplacePayload(fileId);
    }
};

/**
 * Remove the entry and payload for `fileId` unless a newer edit has
 * replaced the entry saved with `enqueuedAt`.
 *
 * @returns false when a newer entry exists and nothing was removed.
 */
export const removeDerivedReplaceOutboxEntryIfCurrent = async (
    fileId: number,
    enqueuedAt: number,
): Promise<boolean> => {
    const current = outbox.get(fileId);
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
    if (!outbox.get(fromFileId) || !bytes) {
        return;
    }
    await putDerivedReplacePayload(toFileId, bytes);
    await outbox.remap(fromFileId, toFileId, (entry) => ({
        ...entry,
        fileId: toFileId,
    }));
    await deleteDerivedReplacePayload(fromFileId);
};

export const getDerivedReplaceOutboxEntries = outbox.entries;

/**
 * Persist the in-memory derived-replace outbox meta to encrypted IDB.
 */
export const flushDerivedReplaceOutboxPersist = outbox.flush;

/**
 * Drop the in-memory outbox on lock/logout.
 *
 * [Note: derived replace payloads survive lock] Only memory is cleared. The
 * encrypted payload rows and persisted metadata stay on disk so a queued edit
 * is retried after unlock. Panic deletes the whole organizer DB instead.
 */
export const clearDerivedReplaceOutbox = outbox.clear;
