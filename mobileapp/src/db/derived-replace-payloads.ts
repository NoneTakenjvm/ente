import {
    getOrganizerDB,
    hasOrganizerDB,
    type DerivedReplacePayloadRecord,
} from "./index";

export const putDerivedReplacePayload = async (
    fileId: number,
    bytes: Uint8Array,
): Promise<void> => {
    if (!hasOrganizerDB()) {
        return;
    }
    const db = await getOrganizerDB();
    const record: DerivedReplacePayloadRecord = {
        fileId,
        bytes: bytes.slice().buffer,
        byteSize: bytes.byteLength,
    };
    await db.put("derivedReplacePayloads", record);
};

export const getDerivedReplacePayload = async (
    fileId: number,
): Promise<Uint8Array | undefined> => {
    if (!hasOrganizerDB()) {
        return undefined;
    }
    const db = await getOrganizerDB();
    const record = await db.get("derivedReplacePayloads", fileId);
    if (!record) {
        return undefined;
    }
    return new Uint8Array(record.bytes);
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
