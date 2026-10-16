import { describe, expect, it } from "vitest";
import {
    deriveKey,
    encryptBox,
    fromB64,
    generateKey,
} from "ente-base/crypto/libsodium";
import {
    deriveKek,
    unlockMasterKey,
    type PasswordKeyAttributes,
} from "../key-attributes";

const kekSalt = "vd0dcYMGNLKn/gpT6uTFTw==";
const opsLimit = 2;
const memLimit = 64 * 1024 * 1024;

const makeKeyAttributes = async (
    password: string,
    masterKey: string,
): Promise<PasswordKeyAttributes> => {
    const kek = await deriveKey(password, kekSalt, opsLimit, memLimit);
    const { encryptedData, nonce } = await encryptBox(
        await fromB64(masterKey),
        kek,
    );
    return {
        kekSalt,
        encryptedKey: encryptedData,
        keyDecryptionNonce: nonce,
        opsLimit,
        memLimit,
    };
};

describe("key attributes", () => {
    it("unlocks the master key with the right password", async () => {
        const masterKey = await generateKey();
        const attributes = await makeKeyAttributes("correct horse", masterKey);
        expect(await unlockMasterKey("correct horse", attributes)).toBe(
            masterKey,
        );
    });

    it("rejects a wrong password", async () => {
        const attributes = await makeKeyAttributes(
            "correct horse",
            await generateKey(),
        );
        await expect(unlockMasterKey("wrong", attributes)).rejects.toThrow(
            "Incorrect password",
        );
    });

    it("rejects Argon2 settings below the floor", async () => {
        await expect(
            deriveKek("pw", { kekSalt, opsLimit: 1, memLimit }),
        ).rejects.toThrow("unsafe password hashing");
        await expect(
            deriveKek("pw", { kekSalt, opsLimit, memLimit: 32 * 1024 * 1024 }),
        ).rejects.toThrow("unsafe password hashing");
    });
});
