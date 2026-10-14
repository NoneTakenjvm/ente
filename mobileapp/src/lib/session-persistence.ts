import {
    decryptMetadataJSON,
    encryptMetadataJSON,
    toB64,
} from "ente-base/crypto";

const wrapKeyStorageKey = "ntphotos-wrap-key";
const sessionStorageKey = "ntphotos-session";
const lockedFlagKey = "ntphotos-locked";
const lockedEmailKey = "ntphotos-locked-email";

/** Clear in-memory keys after this much idle time while the app stays open. */
export const idleLockMs = 15 * 60 * 1000;

/** Drop persisted session credentials after this age. */
const sessionMaxAgeMs = 60 * 60 * 1000;

export interface PersistedSessionPayload {
    authToken: string;
    masterKey: string;
    userID: number;
    email: string;
    savedAt: number;
}

const getOrCreateWrapKey = async (): Promise<string> => {
    let key = localStorage.getItem(wrapKeyStorageKey);
    if (!key) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        key = await toB64(bytes);
        localStorage.setItem(wrapKeyStorageKey, key);
    }
    return key;
};

/**
 * Encrypt and store session credentials for restore after reload or unlock.
 *
 * [Note: Session blob] Master key is encrypted with a device-local wrap key in
 * localStorage — not plaintext, but recoverable on this browser without re-login.
 *
 * Every function here touches browser storage, so call them from effects or
 * event handlers only, never during server pre-render.
 */
export const savePersistedSession = async (
    payload: Omit<PersistedSessionPayload, "savedAt">,
): Promise<void> => {
    const wrapKey = await getOrCreateWrapKey();
    const encrypted = await encryptMetadataJSON(
        { ...payload, savedAt: Date.now() },
        wrapKey,
    );
    localStorage.setItem(sessionStorageKey, JSON.stringify(encrypted));
};

export const loadPersistedSession =
    async (): Promise<PersistedSessionPayload | undefined> => {
        const raw = localStorage.getItem(sessionStorageKey);
        if (!raw) {
            return undefined;
        }
        try {
            const encrypted = JSON.parse(raw) as {
                encryptedData: string;
                decryptionHeader: string;
            };
            const payload = (await decryptMetadataJSON(
                encrypted,
                await getOrCreateWrapKey(),
            )) as PersistedSessionPayload;
            if (Date.now() - payload.savedAt > sessionMaxAgeMs) {
                clearPersistedSession();
                return undefined;
            }
            return payload;
        } catch {
            clearPersistedSession();
            return undefined;
        }
    };

export const hasPersistedSession = (): boolean =>
    localStorage.getItem(sessionStorageKey) !== null;

export const clearPersistedSession = (): void => {
    localStorage.removeItem(sessionStorageKey);
};

export const clearPersistedWrapKey = (): void => {
    localStorage.removeItem(wrapKeyStorageKey);
};

export const markSessionLocked = (email: string): void => {
    sessionStorage.setItem(lockedFlagKey, "1");
    sessionStorage.setItem(lockedEmailKey, email);
};

export const isSessionLocked = (): boolean =>
    sessionStorage.getItem(lockedFlagKey) === "1";

export const getLockedSessionEmail = (): string | undefined => {
    return sessionStorage.getItem(lockedEmailKey) ?? undefined;
};

export const clearSessionLock = (): void => {
    sessionStorage.removeItem(lockedFlagKey);
    sessionStorage.removeItem(lockedEmailKey);
};
