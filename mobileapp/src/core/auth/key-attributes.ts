import { decryptBox, deriveKey } from "ente-base/crypto/libsodium";
import { z } from "zod";

/**
 * The password-encrypted master key and the settings needed to derive the key
 * encryption key (KEK) that decrypts it. Safe to persist: it reveals nothing
 * without the password.
 */
export const PasswordKeyAttributes = z.object({
    kekSalt: z.string(),
    encryptedKey: z.string(),
    keyDecryptionNonce: z.string(),
    memLimit: z.number(),
    opsLimit: z.number(),
});

export type PasswordKeyAttributes = z.infer<typeof PasswordKeyAttributes>;

type KekParams = Pick<
    PasswordKeyAttributes,
    "kekSalt" | "memLimit" | "opsLimit"
>;

/**
 * [Note: Argon2 floor] Lowest Argon2id settings any official client writes:
 * libsodium's INTERACTIVE limits (2 ops, 64 MiB) used by the oldest accounts
 * (see the KAT in `crypto.test.ts`). Current web clients write at least 128 MiB
 * (`deriveSensitiveKey` in `web/packages/base/crypto/libsodium.ts`) and mobile
 * uses the same sensitive derivation. Anything lower came from a server
 * trying to make offline password guessing cheap.
 */
const minOpsLimit = 2;
const minMemLimit = 64 * 1024 * 1024;

/**
 * Derive the KEK from the password.
 *
 * @throws if the settings are below the [Note: Argon2 floor].
 */
export const deriveKek = async (
    password: string,
    { kekSalt, memLimit, opsLimit }: KekParams,
): Promise<string> => {
    if (opsLimit < minOpsLimit || memLimit < minMemLimit) {
        throw new Error(
            "The server sent unsafe password hashing settings. Refusing to continue.",
        );
    }
    return deriveKey(password, kekSalt, opsLimit, memLimit);
};

/** Decrypt the master key (base64) with an already derived KEK. */
export const decryptMasterKey = (
    kek: string,
    { encryptedKey, keyDecryptionNonce }: PasswordKeyAttributes,
): Promise<string> =>
    decryptBox({ encryptedData: encryptedKey, nonce: keyDecryptionNonce }, kek);

/**
 * Derive the KEK locally and decrypt the master key, with no network access.
 *
 * @throws "Incorrect password" if decryption fails.
 */
export const unlockMasterKey = async (
    password: string,
    keyAttributes: PasswordKeyAttributes,
): Promise<string> => {
    const kek = await deriveKek(password, keyAttributes);
    try {
        return await decryptMasterKey(kek, keyAttributes);
    } catch {
        throw new Error("Incorrect password");
    }
};
