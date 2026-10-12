import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateBlobOrStreamKey } from "ente-base/crypto";
import {
    chunkHashFinal,
    chunkHashInit,
    chunkHashUpdate,
    decryptStreamBytes,
    encryptStreamBytes,
} from "ente-base/crypto/libsodium";
import { streamEncryptionChunkSize } from "ente-base/crypto/types";
import { encryptFileForUpload } from "@/core/upload/encrypt-upload-file";

const sizes = [
    0,
    1000,
    streamEncryptionChunkSize,
    streamEncryptionChunkSize * 2 + 123,
];

const hashWholeBuffer = async (data: Uint8Array): Promise<string> => {
    const hashState = await chunkHashInit();
    await chunkHashUpdate(hashState, data);
    return chunkHashFinal(hashState);
};

describe("encryptFileForUpload", () => {
    for (const size of sizes) {
        it(`round-trips and digests a ${size} byte file`, async () => {
            const bytes = new Uint8Array(randomBytes(size));
            const key = await generateBlobOrStreamKey();

            const result = await encryptFileForUpload(new Blob([bytes]), key);
            const ciphertext = new Uint8Array(
                await result.encryptedData.arrayBuffer(),
            );

            const decrypted = await decryptStreamBytes(
                {
                    encryptedData: ciphertext,
                    decryptionHeader: result.decryptionHeader,
                },
                key,
            );
            expect(Buffer.from(decrypted).equals(Buffer.from(bytes))).toBe(
                true,
            );
            expect(result.hash).toBe(await hashWholeBuffer(bytes));
            expect(result.contentMd5).toBe(
                createHash("md5").update(ciphertext).digest("base64"),
            );
            expect(ciphertext.length).toBe(
                (await encryptStreamBytes(bytes, key)).encryptedData.length,
            );
        });
    }
});
