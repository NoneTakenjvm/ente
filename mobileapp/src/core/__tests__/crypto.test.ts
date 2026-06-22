import { describe, expect, it } from "vitest";
import {
    decryptBox,
    decryptMetadataJSON,
    deriveKey,
    encryptBox,
    encryptMetadataJSON,
    fromB64,
    generateKey,
    toB64,
} from "ente-base/crypto/libsodium";
import { decryptRemoteFile } from "ente-media/file";
import { createMagicMetadata } from "ente-media/magic-metadata";

describe("crypto", () => {
    it("deriveKey KAT matches Go test vector", async () => {
        const key = await deriveKey(
            "test_password",
            "vd0dcYMGNLKn/gpT6uTFTw==",
            2,
            64 * 1024 * 1024,
        );
        expect(key).toBe(
            "vp8d8Nee0BbIML4ab8Cp34uYnyrN77cRwTl920flyT0=",
        );
    });

    it("encryptBox round-trips", async () => {
        const key = await generateKey();
        const plainBytes = new TextEncoder().encode("hello ente");
        const { encryptedData, nonce } = await encryptBox(plainBytes, key);
        const decryptedB64 = await decryptBox({ encryptedData, nonce }, key);
        const decrypted = new TextDecoder().decode(await fromB64(decryptedB64));
        expect(decrypted).toBe("hello ente");
    });

    it("encryptMetadataJSON round-trips", async () => {
        const key = await generateKey();
        const data = { title: "photo.jpg", caption: "summer" };
        const encrypted = await encryptMetadataJSON(data, key);
        const decrypted = await decryptMetadataJSON(encrypted, key);
        expect(decrypted).toEqual(data);
    });

    it("tampered ciphertext throws on decrypt", async () => {
        const key = await generateKey();
        const plainBytes = new TextEncoder().encode("secret");
        const { encryptedData, nonce } = await encryptBox(plainBytes, key);
        const bytes = await fromB64(encryptedData);
        bytes[0] ^= 0xff;
        const tampered = await toB64(bytes);
        await expect(
            decryptBox({ encryptedData: tampered, nonce }, key),
        ).rejects.toThrow();
    });

    it("createMagicMetadata merge preserves unknown keys", () => {
        const existing = {
            caption: "old",
            _organizer_v1: { tags: ["selfie"], updatedAt: 1 },
        };
        const merged = createMagicMetadata({
            ...existing,
            caption: "new",
        });
        expect(merged.data).toEqual({
            caption: "new",
            _organizer_v1: { tags: ["selfie"], updatedAt: 1 },
        });
    });

    it("decryptRemoteFile decrypts synthetic remote entry", async () => {
        const collectionKey = await generateKey();
        const fileKey = await generateKey();
        const metadata = {
            fileType: 0,
            title: "test.png",
            creationTime: 1_700_000_000_000_000,
            modificationTime: 1_700_000_000_000_000,
        };

        const encryptedMetadata = await encryptMetadataJSON(
            metadata,
            fileKey,
        );
        const { encryptedData: encryptedKey, nonce: keyDecryptionNonce } =
            await encryptBox(fileKey, collectionKey);

        const remoteFile = {
            id: 42,
            collectionID: 7,
            ownerID: 1,
            updationTime: 1,
            encryptedKey,
            keyDecryptionNonce,
            metadata: encryptedMetadata,
            file: { decryptionHeader: "" },
            thumbnail: { decryptionHeader: "" },
            isDeleted: false,
        };

        const file = await decryptRemoteFile(remoteFile, collectionKey);
        expect(file.id).toBe(42);
        expect(file.key).toBe(fileKey);
        expect(file.metadata.title).toBe("test.png");
    });
});
