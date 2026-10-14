import { create } from "zustand";
import type { StateCreator } from "zustand";
import {
    getEnteCore,
    resetEnteCore,
    type LoginCredentials,
} from "@/core";
import { wipeOrganizerDB, wipeOrganizerDBForUser } from "@/db";
import { clearSessionCacheKey } from "@/lib/cache-key";
import { clearAllLocalMediaOverrides } from "@/lib/local-media-overrides";
import {
    clearPersistedSession,
    clearPersistedWrapKey,
    clearSessionLock,
    getLockedSessionEmail,
    isSessionLocked,
    loadPersistedSession,
    markSessionLocked,
    savePersistedSession,
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

export type SessionStatus = "idle" | "loading" | "authenticated" | "error";

interface SessionState {
    status: SessionStatus;
    userID: number | undefined;
    email: string | undefined;
    errorMessage: string | undefined;
    login: (credentials: LoginCredentials) => Promise<void>;
    /** Flush, then clear the session; resolves once local state is gone. */
    logout: () => Promise<void>;
    /** Wipe in-memory keys and mark locked; resolves when flush + clear finish. */
    lock: () => Promise<void>;
    unlock: () => Promise<boolean>;
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

const persistCurrentSession = async (
    authToken: string,
    masterKey: string,
    userID: number,
    email: string,
): Promise<void> => {
    await savePersistedSession({
        authToken,
        masterKey,
        userID,
        email,
    });
    clearSessionLock();
};

const createSessionStore: StateCreator<SessionState> = (set) => ({
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
            const session = await core.login(credentials);
            const { authToken, masterKey } = core.getSessionCredentials();
            await persistCurrentSession(
                authToken,
                masterKey,
                session.userID,
                credentials.email,
            );
            resetUnauthorizedGate();
            set({
                status: "authenticated",
                userID: session.userID,
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
        try {
            await flushAll();
        } catch {
            // Best-effort — still clear local session.
        }
        clearPersistedSession();
        clearSessionLock();
        clearLocalState();
        set(signedOutState);
    },

    lock: async (): Promise<void> => {
        const { email, status } = useSessionStore.getState();
        if (status !== "authenticated" || !email) {
            return;
        }
        try {
            await flushAll();
        } catch {
            // Best-effort.
        }
        clearMemoryState();
        markSessionLocked(email);
        set({
            status: "idle",
            userID: undefined,
            errorMessage: undefined,
        });
    },

    unlock: async (): Promise<boolean> => {
        clearSessionLock();
        return useSessionStore.getState().restoreFromPersistence();
    },

    restoreFromPersistence: async (): Promise<boolean> => {
        if (getEnteCore().isAuthenticated()) {
            return true;
        }
        if (isSessionLocked()) {
            return false;
        }
        const payload = await loadPersistedSession();
        if (!payload) {
            return false;
        }
        getEnteCore().restoreSession(
            payload.authToken,
            payload.masterKey,
            payload.userID,
        );
        resetUnauthorizedGate();
        set({
            status: "authenticated",
            userID: payload.userID,
            email: payload.email,
            errorMessage: undefined,
        });
        return true;
    },

    panic: async (): Promise<void> => {
        const userId = useSessionStore.getState().userID;
        clearPersistedSession();
        clearPersistedWrapKey();
        clearSessionLock();
        await wipeSiteStorage();
        if (userId !== undefined) {
            await wipeOrganizerDBForUser(userId);
        } else {
            await wipeOrganizerDB();
        }
        clearLocalState();
        set(signedOutState);
    },
});

export const useSessionStore = create<SessionState>(createSessionStore);

if (typeof window !== "undefined") {
    setUnauthorizedHandler((): void => {
        void useSessionStore.getState().logout();
    });
}

/** True when the core holds a live session (keys in memory). */
export const isSessionAuthenticated = (): boolean =>
    getEnteCore().isAuthenticated();

/** True when credentials are saved but the session is locked. */
export const isSessionLockedForLogin = (): boolean =>
    isSessionLocked() && getLockedSessionEmail() !== undefined;

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
