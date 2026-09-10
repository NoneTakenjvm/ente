import { create, type StateCreator } from "zustand";
import {
    loadEncryptedViewSessions,
    saveEncryptedViewSessions,
} from "@/db/kv";
import { getSessionCacheKey, hasSessionCacheKey } from "@/lib/cache-key";
import { isLocalDevToolsEnabled } from "@/lib/dev-flags";
import {
    beginViewOnSession,
    createEmptySession,
    endViewOnSession,
    pickResumeSession,
    remapSessionsFileId,
    sortSessionsNewestFirst,
    toPersistedSession,
    VIEW_SESSION_RESUME_MS,
    type ActiveViewSession,
    type ViewOpenKind,
    type ViewSession,
} from "@/lib/view-sessions";

const VIEW_SESSIONS_SAVE_DEBOUNCE_MS = 1500;

interface OpenViewState {
    fileId: number;
    kind: ViewOpenKind;
}

interface ViewSessionsState {
    sessions: ViewSession[];
    activeSession: ActiveViewSession | undefined;
    isHydrated: boolean;
    hydrateFromCache: () => Promise<void>;
    ensureActiveSession: (now?: number) => void;
    beginView: (fileId: number, openedAt?: number) => void;
    endView: (fileId: number, closedAt?: number) => void;
    remapFileId: (fromFileId: number, toFileId: number) => void;
    deleteSession: (sessionId: string) => void;
    replaceSessionsForTest: (sessions: ViewSession[]) => void;
    getSessionsForTest: () => ViewSession[];
    reset: () => void;
}

let openView: OpenViewState | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let persistChain: Promise<void> = Promise.resolve();
let pendingSessions: ViewSession[] | undefined;

const enqueuePersist = (sessions: ViewSession[]): Promise<void> => {
    if (!hasSessionCacheKey()) {
        return Promise.resolve();
    }
    persistChain = persistChain
        .catch(() => undefined)
        .then(() =>
            saveEncryptedViewSessions({ sessions }, getSessionCacheKey()));
    return persistChain;
};

const schedulePersist = (sessions: ViewSession[]): void => {
    pendingSessions = sessions;
    if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        const pending = pendingSessions;
        pendingSessions = undefined;
        if (!pending) {
            return;
        }
        void enqueuePersist(pending);
    }, VIEW_SESSIONS_SAVE_DEBOUNCE_MS);
};

const flushPersist = (): Promise<void> => {
    if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }
    const pending = pendingSessions;
    pendingSessions = undefined;
    if (!pending) {
        return persistChain;
    }
    return enqueuePersist(pending);
};

const upsertActiveIntoList = (
    sessions: ViewSession[],
    active: ActiveViewSession,
): ViewSession[] => {
    if (!active.persisted || active.views.length === 0) {
        return sessions;
    }
    const persisted = toPersistedSession(active);
    const index = sessions.findIndex((entry) => entry.id === persisted.id);
    if (index < 0) {
        return sortSessionsNewestFirst([persisted, ...sessions]);
    }
    const next = sessions.slice();
    next[index] = persisted;
    return sortSessionsNewestFirst(next);
};

const createViewSessionsStore: StateCreator<ViewSessionsState> = (
    set,
    get,
) => ({
    sessions: [],
    activeSession: undefined,
    isHydrated: false,

    hydrateFromCache: async (): Promise<void> => {
        try {
            const cached = await loadEncryptedViewSessions(
                getSessionCacheKey(),
            );
            const sessions = sortSessionsNewestFirst(cached?.sessions ?? []);
            set({ sessions, isHydrated: true });
            get().ensureActiveSession(Date.now());
        } catch {
            set({ sessions: [], isHydrated: true });
            get().ensureActiveSession(Date.now());
        }
    },

    ensureActiveSession: (now = Date.now()): void => {
        const { sessions, activeSession } = get();

        const resume = pickResumeSession(sessions, now);
        if (resume) {
            if (activeSession?.id === resume.id) {
                return;
            }
            set({
                activeSession: { ...resume, persisted: true },
            });
            openView = undefined;
            return;
        }

        if (
            activeSession &&
            !activeSession.persisted &&
            now - activeSession.startedAt <= VIEW_SESSION_RESUME_MS
        ) {
            return;
        }

        set({ activeSession: createEmptySession(now) });
        openView = undefined;
    },

    beginView: (fileId: number, openedAt = Date.now()): void => {
        let { activeSession } = get();
        if (!activeSession) {
            get().ensureActiveSession(openedAt);
            activeSession = get().activeSession;
        }
        if (!activeSession) {
            return;
        }
        if (openView && openView.fileId !== fileId) {
            get().endView(openView.fileId, openedAt);
            activeSession = get().activeSession ?? activeSession;
        }
        const result = beginViewOnSession(activeSession, fileId, openedAt);
        openView = {
            fileId,
            kind: result.kind,
        };
        const sessions = upsertActiveIntoList(get().sessions, result.session);
        set({ activeSession: result.session, sessions });
        if (result.session.persisted) {
            schedulePersist(sessions);
        }
    },

    endView: (fileId: number, closedAt = Date.now()): void => {
        const { activeSession } = get();
        if (!activeSession || openView?.fileId !== fileId) {
            return;
        }
        const kind = openView.kind;
        openView = undefined;
        const next = endViewOnSession(
            activeSession,
            fileId,
            closedAt,
            kind,
        );
        const sessions = upsertActiveIntoList(get().sessions, next);
        set({ activeSession: next, sessions });
        if (next.persisted) {
            schedulePersist(sessions);
        }
    },

    remapFileId: (fromFileId: number, toFileId: number): void => {
        const { sessions, activeSession } = get();
        const nextSessions = remapSessionsFileId(
            sessions,
            fromFileId,
            toFileId,
        );
        let nextActive = activeSession;
        if (activeSession) {
            const remapped = remapSessionsFileId(
                [toPersistedSession(activeSession)],
                fromFileId,
                toFileId,
            )[0];
            if (remapped) {
                nextActive = {
                    ...remapped,
                    persisted: activeSession.persisted,
                };
            }
        }
        if (openView?.fileId === fromFileId) {
            openView = { ...openView, fileId: toFileId };
        }
        set({ sessions: nextSessions, activeSession: nextActive });
        schedulePersist(nextSessions);
    },

    deleteSession: (sessionId: string): void => {
        const { sessions, activeSession } = get();
        const nextSessions = sessions.filter(
            (session) => session.id !== sessionId,
        );
        const deletedActive = activeSession?.id === sessionId;
        if (deletedActive) {
            openView = undefined;
        }
        set({
            sessions: nextSessions,
            activeSession: deletedActive ?
                createEmptySession(Date.now()) :
                activeSession,
        });
        schedulePersist(nextSessions);
    },

    replaceSessionsForTest: (sessions: ViewSession[]): void => {
        const sorted = sortSessionsNewestFirst(sessions);
        set({
            sessions: sorted,
            activeSession: undefined,
        });
        openView = undefined;
        void enqueuePersist(sorted);
    },

    getSessionsForTest: (): ViewSession[] => get().sessions,

    reset: (): void => {
        openView = undefined;
        pendingSessions = undefined;
        if (saveTimer !== undefined) {
            clearTimeout(saveTimer);
            saveTimer = undefined;
        }
        set({
            sessions: [],
            activeSession: undefined,
            isHydrated: false,
        });
    },
});

export const useViewSessionsStore = create<ViewSessionsState>(
    createViewSessionsStore,
);

const installDevTestHook = (): void => {
    if (!isLocalDevToolsEnabled || typeof window === "undefined") {
        return;
    }
    const api = {
        replaceSessions: (sessions: ViewSession[]): void => {
            useViewSessionsStore.getState().replaceSessionsForTest(sessions);
        },
        getSessions: (): ViewSession[] =>
            useViewSessionsStore.getState().getSessionsForTest(),
        ensureActiveSession: (now?: number): void => {
            useViewSessionsStore.getState().ensureActiveSession(now);
        },
        beginView: (fileId: number, openedAt?: number): void => {
            useViewSessionsStore.getState().beginView(fileId, openedAt);
        },
        endView: (fileId: number, closedAt?: number): void => {
            useViewSessionsStore.getState().endView(fileId, closedAt);
        },
        getActiveSession: (): ActiveViewSession | undefined =>
            useViewSessionsStore.getState().activeSession,
    };
    (
        window as Window & {
            __viewSessionsTest?: typeof api;
        }
    ).__viewSessionsTest = api;
};

installDevTestHook();

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            void flushPersist();
            return;
        }
        useViewSessionsStore.getState().ensureActiveSession(Date.now());
    });
}
