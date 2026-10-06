import { decryptBlobBytes, encryptBlobBytes, toB64 } from "ente-base/crypto";
import { getSessionCacheKey } from "@/lib/cache-key";
import {
    getOrganizerDB,
    hasOrganizerDB,
    type DerivedReplacePayloadRecord,
} from "./index";

/**
 * Persist edited file bytes awaiting upload, encrypted with the session
 * cacheKey (they are decrypted user content).
 */
export const putDerivedReplacePayload = async (
    fileId: number,
    bytes: Uint8Array,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    const wrapped = await encryptBlobBytes(bytes, getSessionCacheKey());
    const db = await getOrganizerDB();
    const record: DerivedReplacePayloadRecord = {
        fileId,
        encryptedData: wrapped.encryptedData.slice().buffer,
        decryptionHeader: await toB64(wrapped.decryptionHeader),
        byteSize: bytes.byteLength,
    };
    await db.put("derivedReplacePayloads", record);
};

/**
 * Load and decrypt pending edited bytes. Rows that cannot be decrypted (other
 * session key, or pre-encryption plaintext rows) are deleted.
 */
export const getDerivedReplacePayload = async (
    fileId: number,
): Promise<Uint8Array | undefined> => {
    if (!hasOrganizerDB()) {
        return undefined;
    }
    let cacheKey: string;
    try {
        cacheKey = getSessionCacheKey();
    } catch {
        return undefined;
    }
    const db = await getOrganizerDB();
    const record = await db.get("derivedReplacePayloads", fileId);
    if (!record) {
        return undefined;
    }
    try {
        return await decryptBlobBytes(
            {
                encryptedData: new Uint8Array(record.encryptedData),
                decryptionHeader: record.decryptionHeader,
            },
            cacheKey,
        );
    } catch {
        await db.delete("derivedReplacePayloads", fileId);
        return undefined;
    }
};

export const deleteDerivedReplacePayload = async (
    fileId: number,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    try {
        const db = await getOrganizerDB();
        await db.delete("derivedReplacePayloads", fileId);
    } catch {
        // ignore
    }
};

export const clearDerivedReplacePayloads = async (): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    try {
        const db = await getOrganizerDB();
        await db.clear("derivedReplacePayloads");
    } catch {
        // ignore
    }
};
