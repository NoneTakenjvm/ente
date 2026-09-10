/**
 * Encrypted per-file tile CLIP vectors for the kit nearness tile pilot.
 *
 * One record per photo, wrapped with the session cacheKey like
 * {@link ./file-ciphertexts.ts}. Records tagged with another model or layout
 * are treated as absent; "Clear tile embeddings" in Manage drops them.
 */
import { decryptBlobBytes, encryptBlobBytes, toB64 } from "ente-base/crypto";
import { getSessionCacheKey } from "@/lib/cache-key";
import type { KitTileEmbeddings } from "@/lib/kit-embedding";
import { getOrganizerDB, type TileEmbeddingRecord } from "./index";

/** Ids of every photo with stored tiles, regardless of model or layout. */
export const listTileEmbeddingFileIds = async (): Promise<Set<number>> => {
    const db = await getOrganizerDB();
    // Keys are the numeric `fileId` key path; idb types them as IDBValidKey.
    return new Set((await db.getAllKeys("tileEmbeddings")).map(Number));
};

export const putTileEmbeddings = async (
    fileId: number,
    modelId: string,
    layout: string,
    tiles: KitTileEmbeddings,
): Promise<void> => {
    const { vectors } = tiles;
    const wrapped = await encryptBlobBytes(
        new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength),
        getSessionCacheKey(),
    );
    const record: TileEmbeddingRecord = {
        fileId,
        modelId,
        layout,
        rows: tiles.rows,
        columns: tiles.columns,
        encryptedData: wrapped.encryptedData.slice().buffer,
        decryptionHeader: await toB64(wrapped.decryptionHeader),
    };
    const db = await getOrganizerDB();
    await db.put("tileEmbeddings", record);
};

/**
 * Decrypt the stored tiles for `fileIds` that match `modelId` / `layout`.
 */
export const getTileEmbeddingsFor = async (
    fileIds: Iterable<number>,
    modelId: string,
    layout: string,
): Promise<Map<number, KitTileEmbeddings>> => {
    const cacheKey = getSessionCacheKey();
    const db = await getOrganizerDB();
    const result = new Map<number, KitTileEmbeddings>();
    for (const fileId of fileIds) {
        const record = await db.get("tileEmbeddings", fileId);
        if (record?.modelId !== modelId || record.layout !== layout) {
            continue;
        }
        const bytes = await decryptBlobBytes(
            {
                encryptedData: new Uint8Array(record.encryptedData),
                decryptionHeader: record.decryptionHeader,
            },
            cacheKey,
        );
        // Float32Array needs 4-byte alignment; a fresh copy guarantees it.
        const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
        result.set(fileId, {
            rows: record.rows,
            columns: record.columns,
            vectors: new Float32Array(
                aligned.buffer,
                aligned.byteOffset,
                aligned.byteLength / 4,
            ),
        });
    }
    return result;
};

export const clearTileEmbeddings = async (): Promise<void> => {
    const db = await getOrganizerDB();
    await db.clear("tileEmbeddings");
};
