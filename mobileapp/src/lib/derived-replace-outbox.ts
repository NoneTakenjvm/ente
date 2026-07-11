import {
    loadEncryptedDerivedReplaceOutbox,
    saveEncryptedDerivedReplaceOutbox,
    type PersistedDerivedReplaceOutboxEntry,
} from "@/db/kv";
import { getSessionCacheKey } from "@/lib/cache-key";

export interface DerivedReplaceOutboxEntry {
    fileId: number;
    /** Base64 of the replacement JPEG/PNG/video bytes. */
    bytesBase64: string;
    width: number;
    height: number;
    kind: "crop" | "rotate" | "auto-crop" | "video-edit";
    enqueuedAt: number;
}

const outboxByFileId = new Map<number, DerivedReplaceOutboxEntry>();
let hydrated = false;
let persistChain: Promise<void> = Promise.resolve();

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
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
    for (const entry of persisted ?? []) {
        outboxByFileId.set(entry.fileId, entry);
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
    kind: DerivedReplaceOutboxEntry["kind"],
): Promise<void> => {
    if (!hydrated) {
        await hydrateDerivedReplaceOutbox();
    }
    outboxByFileId.set(fileId, {
        fileId,
        bytesBase64: bytesToBase64(bytes),
        width,
        height,
        kind,
        enqueuedAt: Date.now(),
    });
    await persist();
};

export const removeDerivedReplaceOutboxEntries = async (
    fileIds: number[],
): Promise<void> => {
    if (!fileIds.length) {
        return;
    }
    for (const fileId of fileIds) {
        outboxByFileId.delete(fileId);
    }
    await persist();
};

export const getDerivedReplaceOutboxEntries = (): DerivedReplaceOutboxEntry[] =>
    [...outboxByFileId.values()];

export const clearDerivedReplaceOutbox = (): void => {
    outboxByFileId.clear();
    hydrated = false;
    persistChain = Promise.resolve();
};
