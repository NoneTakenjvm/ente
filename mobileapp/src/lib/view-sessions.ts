/**
 * Pure helpers for recently-viewed browsing sessions.
 *
 * Sessions track full-screen PhotoViewer dwells (>1s). Persistence and the
 * active-session lifecycle live in {@link useViewSessionsStore}.
 */

/** Resume the latest session when activity returns within this window. */
export const VIEW_SESSION_RESUME_MS = 60 * 60 * 1000;

/** Full-view dwell required before a view counts. */
export const VIEW_SESSION_QUALIFY_MS = 1000;

export interface ViewRecord {
    fileId: number;
    openedAt: number;
    closedAt: number;
}

export interface ViewSession {
    id: string;
    startedAt: number;
    /** Last qualifying view close — drives the 1h resume clock. */
    endTime: number;
    views: ViewRecord[];
    totalViewTimeMs: number;
    totalViews: number;
    uniqueFileIds: number[];
    lastViewedFileId: number;
}

export interface ActiveViewSession extends ViewSession {
    /** True once the session has at least one qualifying view and is in the list. */
    persisted: boolean;
}

/**
 * Create an empty in-memory session that is not yet saved.
 */
export const createEmptySession = (
    startedAt: number,
    id: string = newSessionId(),
): ActiveViewSession => ({
    id,
    startedAt,
    endTime: startedAt,
    views: [],
    totalViewTimeMs: 0,
    totalViews: 0,
    uniqueFileIds: [],
    lastViewedFileId: 0,
    persisted: false,
});

/**
 * Whether `now` is still within the resume window of a session's endTime.
 */
export const shouldResumeSession = (
    endTime: number,
    now: number,
): boolean => now - endTime <= VIEW_SESSION_RESUME_MS;

/**
 * Pick the session to resume, or `undefined` to start a new one.
 */
export const pickResumeSession = (
    sessions: ViewSession[],
    now: number,
): ViewSession | undefined => {
    if (sessions.length === 0) {
        return undefined;
    }
    let latest: ViewSession | undefined;
    for (const session of sessions) {
        if (!latest || session.startedAt > latest.startedAt) {
            latest = session;
        }
    }
    if (!latest || !shouldResumeSession(latest.endTime, now)) {
        return undefined;
    }
    return latest;
};

/**
 * Recompute cached aggregates from `views`.
 */
export const recomputeSessionAggregates = (
    session: ViewSession,
): ViewSession => {
    const unique: number[] = [];
    const seen = new Set<number>();
    let totalViewTimeMs = 0;
    for (const view of session.views) {
        totalViewTimeMs += Math.max(0, view.closedAt - view.openedAt);
        if (!seen.has(view.fileId)) {
            seen.add(view.fileId);
            unique.push(view.fileId);
        }
    }
    const last = session.views[session.views.length - 1];
    return {
        ...session,
        totalViewTimeMs,
        totalViews: session.views.length,
        uniqueFileIds: unique,
        lastViewedFileId: last?.fileId ?? 0,
        endTime: last?.closedAt ?? session.startedAt,
    };
};

export type BeginViewResult =
    | { kind: "appended"; session: ActiveViewSession } |
    { kind: "consecutive"; session: ActiveViewSession };

/** How the matching `beginView` recorded this open — drives close behaviour. */
export type ViewOpenKind = BeginViewResult["kind"];

/**
 * Record a qualifying view open. Consecutive same-file opens do not append.
 */
export const beginViewOnSession = (
    session: ActiveViewSession,
    fileId: number,
    openedAt: number,
): BeginViewResult => {
    const last = session.views[session.views.length - 1];
    if (last?.fileId === fileId) {
        return { kind: "consecutive", session };
    }
    const views = [
        ...session.views,
        { fileId, openedAt, closedAt: openedAt },
    ];
    const next = recomputeSessionAggregates({ ...session, views });
    return {
        kind: "appended",
        session: {
            ...next,
            persisted: true,
            // Keep endTime at previous close until endView; first view uses openedAt.
            endTime: session.views.length === 0 ? openedAt : session.endTime,
        },
    };
};

/**
 * Close the open view: set closedAt on the last appended record (or only bump
 * endTime for a consecutive re-view).
 */
export const endViewOnSession = (
    session: ActiveViewSession,
    fileId: number,
    closedAt: number,
    kind: ViewOpenKind,
): ActiveViewSession => {
    if (kind === "consecutive") {
        return {
            ...session,
            endTime: Math.max(session.endTime, closedAt),
        };
    }
    const last = session.views[session.views.length - 1];
    if (last?.fileId !== fileId) {
        return {
            ...session,
            endTime: Math.max(session.endTime, closedAt),
        };
    }
    const views = session.views.slice(0, -1);
    views.push({ ...last, closedAt: Math.max(last.openedAt, closedAt) });
    return {
        ...recomputeSessionAggregates({ ...session, views }),
        persisted: true,
    };
};

/**
 * Rewrite every stored file id after a crop/compress replace.
 */
export const remapSessionFileId = (
    session: ViewSession,
    fromFileId: number,
    toFileId: number,
): ViewSession => {
    if (fromFileId === toFileId) {
        return session;
    }
    let changed = false;
    const views = session.views.map((view) => {
        if (view.fileId !== fromFileId) {
            return view;
        }
        changed = true;
        return { ...view, fileId: toFileId };
    });
    if (!changed) {
        return session;
    }
    return recomputeSessionAggregates({ ...session, views });
};

/**
 * Apply {@link remapSessionFileId} to every session in the list.
 */
export const remapSessionsFileId = (
    sessions: ViewSession[],
    fromFileId: number,
    toFileId: number,
): ViewSession[] =>
    sessions.map((session) =>
        remapSessionFileId(session, fromFileId, toFileId));

/**
 * Display name for a session from its start time.
 */
export const formatSessionName = (
    startedAt: number,
    locale?: string,
): string => {
    try {
        return new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(new Date(startedAt));
    } catch {
        return new Date(startedAt).toLocaleString();
    }
};

/**
 * Compact duration for lore lines (e.g. `12m 4s`, `1h 3m`).
 */
export const formatSessionDuration = (durationMs: number): string => {
    const totalSec = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
};

/**
 * Session length from first image open to last image close.
 */
export const sessionSpanMs = (session: ViewSession): number => {
    const first = session.views[0];
    if (!first) {
        return 0;
    }
    return Math.max(0, session.endTime - first.openedAt);
};

/**
 * Lore line under the session name.
 */
export const formatSessionLore = (session: ViewSession): string => {
    const n = session.totalViews;
    const images = n === 1 ? "1 image" : `${n} images`;
    return `${images} · ${formatSessionDuration(sessionSpanMs(session))}`;
};

/**
 * Sort sessions newest-first by start time.
 */
export const sortSessionsNewestFirst = (
    sessions: ViewSession[],
): ViewSession[] =>
    [...sessions].sort((a, b) => b.startedAt - a.startedAt);

const newSessionId = (): string => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `vs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

/** Drop the in-memory-only {@link ActiveViewSession.persisted} flag for storage. */
export const toPersistedSession = (session: ActiveViewSession): ViewSession => {
    const { persisted: _persisted, ...rest } = session;
    return rest;
};
