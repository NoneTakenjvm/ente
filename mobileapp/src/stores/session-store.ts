import { create } from "zustand";
import type { StateCreator } from "zustand";
import {
    clearSessionStorage,
    haveMasterKeyInSession,
    masterKeyFromSession,
    saveMasterKeyInSessionAndSafeStore,
} from "ente-base/session";
import {
    getEnteCore,
    resetEnteCore,
    type LoginCredentials,
} from "@/core";
import { unlockMasterKey } from "@/core/auth/key-attributes";
import { wipeOrganizerDB, wipeOrganizerDBForUser } from "@/db";
import { clearSessionCacheKey } from "@/lib/cache-key";
import { clearAllLocalMediaOverrides } from "@/lib/local-media-overrides";
import {
    clearPersistedSession,
    loadPersistedSession,
    savePersistedSession,
    type PersistedSession,
} from "@/lib/session-persistence";
import { wipeSiteStorage } from "@/lib/site-wipe";
import { clearThumbnailCache } from "@/lib/thumbnail-cache";
import { clearVideoSessionCache } from "@/lib/video-media-cache";
import { flushAll, runSessionResets } from "@/lib/session-lifecycle";
import {
    resetUnauthorizedGate,
    setUnauthorizedHandler,
} from "@/lib/session-invalidation";
import { errorMessage } from "@/lib/format";

type SessionStatus = "idle" | "loading" | "authenticated" | "error";

interface SessionState {
    status: SessionStatus;
    userID: number | undefined;
    email: string | undefined;
    errorMessage: string | undefined;
    login: (credentials: LoginCredentials) => Promise<void>;
    /**
     * Flush, revoke the token on the server, wipe this user's local data and
     * all saved credentials. Best-effort: never throws.
     */
    logout: () => Promise<void>;
    /** Wipe in-memory and tab-session keys; the password is needed to unlock. */
    lock: () => Promise<void>;
    /** Derive the master key from the password locally; throws if it is wrong. */
    unlock: (password: string) => Promise<void>;
    /** Restore from the tab's session key (reload); false when locked or signed out. */
    restoreFromPersistence: () => Promise<boolean>;
    panic: () => Promise<void>;
}

const clearMemoryState = (): void => {
    getEnteCore().logout();
    clearSessionCacheKey();
    clearThumbnailCache();
    clearVideoSessionCache();
    clearAllLocalMediaOverrides();
    runSessionResets();
};

const clearLocalState = (): void => {
    clearMemoryState();
    resetEnteCore();
};

const signedOutState = {
    status: "idle",
    userID: undefined,
    email: undefined,
    errorMessage: undefined,
} as const;

/**
 * [Note: Do not throw during logout] Run one logout step, ignoring failure so a
 * network or storage error cannot leave the user signed in.
 */
const attempt = async (step: () => Promise<unknown>): Promise<void> => {
    try {
        await step();
    } catch {
        // Best-effort.
    }
};

const createSessionStore: StateCreator<SessionState> = (set) => {
    const startSession = (
        { authToken, userID, email }: PersistedSession,
        masterKey: string,
    ): void => {
        getEnteCore().restoreSession(authToken, masterKey, userID);
        resetUnauthorizedGate();
        set({
            status: "authenticated",
            userID,
            email,
            errorMessage: undefined,
        });
    };

    return {
        status: "idle",
        userID: undefined,
        email: undefined,
        errorMessage: undefined,

        login: async (credentials: LoginCredentials): Promise<void> => {
            set({
                status: "loading",
                errorMessage: undefined,
                email: credentials.email,
            });
            try {
                const core = getEnteCore();
                const { userID, keyAttributes } =
                    await core.login(credentials);
                const { authToken, masterKey } = core.getSessionCredentials();
                savePersistedSession({
                    authToken,
                    userID,
                    email: credentials.email,
                    keyAttributes,
                });
                await saveMasterKeyInSessionAndSafeStore(masterKey);
                resetUnauthorizedGate();
                set({
                    status: "authenticated",
                    userID,
                    email: credentials.email,
                    errorMessage: undefined,
                });
            } catch (error) {
                set({
                    status: "error",
                    userID: undefined,
                    errorMessage:
                        errorMessage(error, "Login failed"),
                });
                throw error;
            }
        },

        logout: async (): Promise<void> => {
            const persisted = loadPersistedSession();
            const userID = useSessionStore.getState().userID ?? persisted?.userID;
            await attempt(flushAll);
            if (persisted) {
                await attempt(() => getEnteCore().remoteLogout(persisted.authToken));
            }
            clearPersistedSession();
            clearSessionStorage();
            clearLocalState();
            if (userID !== undefined) {
                await attempt(() => wipeOrganizerDBForUser(userID));
            }
            set(signedOutState);
        },

        lock: async (): Promise<void> => {
            if (useSessionStore.getState().status !== "authenticated") {
                return;
            }
            await attempt(flushAll);
            clearMemoryState();
            clearSessionStorage();
            set({
                status: "idle",
                userID: undefined,
                errorMessage: undefined,
            });
        },

        unlock: async (password: string): Promise<void> => {
            const persisted = loadPersistedSession();
            if (!persisted) {
                throw new Error("No saved session. Sign in again.");
            }
            const masterKey = await unlockMasterKey(
                password,
                persisted.keyAttributes,
            );
            await saveMasterKeyInSessionAndSafeStore(masterKey);
            startSession(persisted, masterKey);
        },

        restoreFromPersistence: async (): Promise<boolean> => {
            if (getEnteCore().isAuthenticated()) {
                return true;
            }
            const persisted = loadPersistedSession();
            if (!persisted) {
                return false;
            }
            const masterKey = await masterKeyFromSession().catch(
                () => undefined,
            );
            if (!masterKey) {
                return false;
            }
            startSession(persisted, masterKey);
            return true;
        },

        panic: async (): Promise<void> => {
            const userId = useSessionStore.getState().userID;
            clearPersistedSession();
            clearSessionStorage();
            if (userId !== undefined) {
                await wipeOrganizerDBForUser(userId);
            } else {
                await wipeOrganizerDB();
            }
            // After the DB is closed above, so its delete is not blocked.
            await wipeSiteStorage();
            clearLocalState();
            set(signedOutState);
        },
    };
};

export const useSessionStore = create<SessionState>(createSessionStore);

if (typeof window !== "undefined") {
    setUnauthorizedHandler((): void => {
        void useSessionStore.getState().logout();
    });
}

/** True when the core holds a live session (keys in memory). */
export const isSessionAuthenticated = (): boolean =>
    getEnteCore().isAuthenticated();

/** True when an account is saved but its master key needs the password. */
export const isSessionLockedForLogin = (): boolean =>
    !isSessionAuthenticated() &&
    !haveMasterKeyInSession() &&
    loadPersistedSession() !== undefined;

/**
 * Clear stale Zustand session state when the core was reset (e.g. HMR, tab restore).
 */
export const reconcileSessionWithCore = (): void => {
    const { status } = useSessionStore.getState();
    const coreAuth = getEnteCore().isAuthenticated();
    if (status === "authenticated" && !coreAuth) {
        useSessionStore.setState({
            status: "idle",
            userID: undefined,
            errorMessage: undefined,
        });
    }
};

let restoreInFlight: Promise<void> | undefined;

/**
 * Reconcile stale store state with the core, then restore the persisted
 * session if the core is not authenticated. Concurrent callers share one
 * in-flight restore; the memo clears once it settles, so a later logout or
 * login can restore again.
 */
export const ensureSessionRestored = (): Promise<void> => {
    reconcileSessionWithCore();
    if (isSessionAuthenticated()) {
        return Promise.resolve();
    }
    restoreInFlight ??= useSessionStore
        .getState()
        .restoreFromPersistence()
        .then(
            (): void => undefined,
        )
        .finally((): void => {
            restoreInFlight = undefined;
        });
    return restoreInFlight;
};
