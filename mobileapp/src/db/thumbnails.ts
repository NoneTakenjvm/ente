import { fromB64, toB64 } from "ente-base/crypto";
import { getOrganizerDB, type ThumbnailRecord } from "./index";

export interface ServerCiphertext {
    encryptedData: Uint8Array;
    decryptionHeader: string;
}

export const hasThumbnailCiphertext = async (fileId: number): Promise<boolean> => {
    const db = await getOrganizerDB();
    const record: ThumbnailRecord | undefined = await db.get("thumbnails", fileId);
    return record !== undefined;
};

export const getThumbnailCiphertext = async (
    fileId: number,
): Promise<ServerCiphertext | undefined> => {
    const db = await getOrganizerDB();
    const record: ThumbnailRecord | undefined = await db.get("thumbnails", fileId);
    if (!record) {
        return undefined;
    }
    return {
        encryptedData: await fromB64(record.encryptedData),
        decryptionHeader: record.decryptionHeader,
    };
};

export const putThumbnailCiphertext = async (
    fileId: number,
    ciphertext: ServerCiphertext,
): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("thumbnails", {
        fileId,
        encryptedData: await toB64(ciphertext.encryptedData),
        decryptionHeader: ciphertext.decryptionHeader,
    });
};

export const deleteThumbnailCiphertext = async (fileId: number): Promise<void> => {
    const db = await getOrganizerDB();
    await db.delete("thumbnails", fileId);
};
