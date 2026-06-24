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
import { clearThumbnailCache } from "@/lib/thumbnail-cache";

export type SessionStatus = "idle" | "loading" | "authenticated" | "error";

interface SessionState {
    status: SessionStatus;
    userID: number | undefined;
    email: string | undefined;
    errorMessage: string | undefined;
    login: (credentials: LoginCredentials) => Promise<void>;
    logout: () => void;
    lock: () => void;
    unlock: () => Promise<boolean>;
    restoreFromPersistence: () => Promise<boolean>;
    panic: () => Promise<void>;
}

const resetDependentStores = (): void => {
    void import("@/lib/similarity-job").then(({ terminatePhashWorker }) => {
        terminatePhashWorker();
    });
    void import("@/lib/organizer-config-save-queue").then(
        ({ resetOrganizerConfigSaveQueue }) => {
            resetOrganizerConfigSaveQueue();
        },
    );
    void import("@/lib/tag-outbox-runner").then(({ stopTagOutboxRunner }) => {
        stopTagOutboxRunner();
    });
    void import("@/lib/tag-outbox").then(({ clearTagOutbox }) => {
        clearTagOutbox();
    });
    void import("./library-store").then(({ useLibraryStore }) => {
        useLibraryStore.getState().reset();
    });
    void import("./tag-store").then(({ useTagStore }) => {
        useTagStore.getState().reset();
    });
    void import("./album-store").then(({ useAlbumStore }) => {
        useAlbumStore.getState().reset();
    });
    void import("./phash-index-store").then(({ usePhashIndexStore }) => {
        usePhashIndexStore.getState().reset();
    });
    void import("./ui-store").then(({ useCompressJobStore, usePhashJobStore, useUploadJobStore, useUIStore }) => {
        usePhashJobStore.getState().reset();
        useCompressJobStore.getState().reset();
        useUploadJobStore.getState().reset();
        useUIStore.getState().setDedupDryRun(false);
    });
};

const clearMemoryState = (): void => {
    getEnteCore().logout();
    clearSessionCacheKey();
    clearThumbnailCache();
    clearAllLocalMediaOverrides();
    resetDependentStores();
};

const clearLocalState = (): void => {
    clearMemoryState();
    resetEnteCore();
};

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
                    error instanceof Error ? error.message : "Login failed",
            });
            throw error;
        }
    },

    logout: (): void => {
        clearPersistedSession();
        clearSessionLock();
        clearLocalState();
        set({
            status: "idle",
            userID: undefined,
            email: undefined,
            errorMessage: undefined,
        });
    },

    lock: (): void => {
        const { email, status } = useSessionStore.getState();
        if (status !== "authenticated" || !email) {
            return;
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
        if (userId !== undefined) {
            await wipeOrganizerDBForUser(userId);
        } else {
            await wipeOrganizerDB();
        }
        clearLocalState();
        set({
            status: "idle",
            userID: undefined,
            email: undefined,
            errorMessage: undefined,
        });
    },
});

export const useSessionStore = create<SessionState>(createSessionStore);

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
