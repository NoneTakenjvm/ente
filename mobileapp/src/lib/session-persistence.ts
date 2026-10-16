import { z } from "zod";
import { PasswordKeyAttributes } from "@/core/auth/key-attributes";

const sessionStorageKey = "ntphotos-session";
const legacyWrapKeyStorageKey = "ntphotos-wrap-key";

/** Clear in-memory keys after this much idle time while the app stays open. */
export const idleLockMs = 15 * 60 * 1000;

const PersistedSession = z.object({
    authToken: z.string(),
    userID: z.number(),
    email: z.string(),
    keyAttributes: PasswordKeyAttributes,
});

export type PersistedSession = z.infer<typeof PersistedSession>;

/**
 * Save what official Ente web keeps in localStorage: the auth token, account
 * identity, and the password-encrypted master key.
 *
 * [Note: Master key storage] The master key itself is never persisted here. It
 * lives only in sessionStorage (`ente-base/session`), so a new tab or a relaunch
 * needs the password to derive it again from `keyAttributes`.
 *
 * Every function here touches browser storage, so call them from effects or
 * event handlers only, never during server pre-render.
 */
export const savePersistedSession = (session: PersistedSession): void => {
    localStorage.setItem(sessionStorageKey, JSON.stringify(session));
};

/**
 * Read the saved session, or `undefined` if there is none. An entry that does
 * not match the schema (e.g. the old wrap-key encrypted format) is dropped, as
 * is the old wrap key itself.
 */
export const loadPersistedSession = (): PersistedSession | undefined => {
    localStorage.removeItem(legacyWrapKeyStorageKey);
    const raw = localStorage.getItem(sessionStorageKey);
    if (!raw) {
        return undefined;
    }
    try {
        return PersistedSession.parse(JSON.parse(raw));
    } catch {
        clearPersistedSession();
        return undefined;
    }
};

export const clearPersistedSession = (): void => {
    localStorage.removeItem(sessionStorageKey);
};
