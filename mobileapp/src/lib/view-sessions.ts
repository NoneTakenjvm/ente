/**
 * Pure helpers for recently-viewed browsing sessions.
 *
 * Sessions track full-screen PhotoViewer dwells (>1s). Persistence and the
 * active-session lifecycle live in {@link useViewSessionsStore}.
 *
 * [Note: View sessions cloud] Cross-device copy lives in organizer
 * `_organizer_app_v1.viewSessions` (cap 50, LWW per id via endTime, tombstones
 * for deletes). Local encrypted IDB remains the fast cache.
 */

/** Resume the latest session when activity returns within this window. */
export const VIEW_SESSION_RESUME_MS = 60 * 60 * 1000;

/** Full-view dwell required before a view counts. */
export const VIEW_SESSION_QUALIFY_MS = 1000;

/** Max sessions kept in organizer config / merged lists. */
export const VIEW_SESSIONS_CLOUD_CAP = 50;

/** Bound magic-metadata size — keep the newest views per session. */
export const VIEW_SESSION_CLOUD_MAX_VIEWS = 100;

/** Cap deleted-session tombstones retained in organizer config. */
export const VIEW_SESSION_TOMBSTONE_CAP = 100;

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

/** Tombstone so a delete wins over a stale remote session copy. */
export interface ViewSessionTombstone {
    id: string;
    deletedAt: number;
}

/** Payload stored under organizer `_organizer_app_v1.viewSessions`. */
export interface CloudViewSessionsPayload {
    sessions: ViewSession[];
    tombstones?: ViewSessionTombstone[];
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

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

/**
 * Prefer the session with the newer endTime (LWW); ties break on view count.
 */
export const preferViewSession = (
    a: ViewSession,
    b: ViewSession,
): ViewSession => {
    if (a.endTime !== b.endTime) {
        return a.endTime >= b.endTime ? a : b;
    }
    if (a.totalViews !== b.totalViews) {
        return a.totalViews >= b.totalViews ? a : b;
    }
    return a.startedAt >= b.startedAt ? a : b;
};

/**
 * Drop oldest views when over the cloud cap and recompute aggregates.
 * Preserves a consecutive-view {@link ViewSession.endTime} bump that is not
 * reflected in the last view's closedAt.
 */
export const trimSessionViewsForCloud = (
    session: ViewSession,
    maxViews: number = VIEW_SESSION_CLOUD_MAX_VIEWS,
): ViewSession => {
    if (session.views.length <= maxViews) {
        return session;
    }
    const views = session.views.slice(session.views.length - maxViews);
    const next = recomputeSessionAggregates({ ...session, views });
    return {
        ...next,
        endTime: Math.max(session.endTime, next.endTime),
    };
};

/**
 * Newest-first list capped to {@link VIEW_SESSIONS_CLOUD_CAP}.
 */
export const capViewSessions = (
    sessions: readonly ViewSession[],
    cap: number = VIEW_SESSIONS_CLOUD_CAP,
): ViewSession[] => sortSessionsNewestFirst([...sessions]).slice(0, cap);

/**
 * Keep the newest tombstones only.
 */
export const capViewSessionTombstones = (
    tombstones: readonly ViewSessionTombstone[],
    cap: number = VIEW_SESSION_TOMBSTONE_CAP,
): ViewSessionTombstone[] =>
    [...tombstones]
        .sort((a, b) => b.deletedAt - a.deletedAt)
        .slice(0, cap);

/**
 * LWW-merge two cloud payloads (sessions by id via endTime; tombstones by id).
 */
export const mergeCloudViewSessions = (
    local: CloudViewSessionsPayload | undefined,
    remote: CloudViewSessionsPayload | undefined,
): CloudViewSessionsPayload => {
    const tombstoneMap = new Map<string, number>();
    for (const list of [local?.tombstones, remote?.tombstones]) {
        for (const entry of list ?? []) {
            const prev = tombstoneMap.get(entry.id);
            if (prev === undefined || entry.deletedAt > prev) {
                tombstoneMap.set(entry.id, entry.deletedAt);
            }
        }
    }

    const sessionMap = new Map<string, ViewSession>();
    for (const list of [local?.sessions, remote?.sessions]) {
        for (const session of list ?? []) {
            const existing = sessionMap.get(session.id);
            sessionMap.set(
                session.id,
                existing ? preferViewSession(existing, session) : session,
            );
        }
    }

    for (const [id, deletedAt] of tombstoneMap) {
        const session = sessionMap.get(id);
        if (!session) {
            continue;
        }
        if (deletedAt >= session.endTime) {
            sessionMap.delete(id);
        } else {
            tombstoneMap.delete(id);
        }
    }

    return {
        sessions: capViewSessions(
            [...sessionMap.values()].map((session) =>
                trimSessionViewsForCloud(session)),
        ),
        tombstones: capViewSessionTombstones(
            [...tombstoneMap.entries()].map(([id, deletedAt]) => ({
                id,
                deletedAt,
            })),
        ),
    };
};

/**
 * Normalize unknown organizer-config JSON into a cloud payload.
 */
export const parseCloudViewSessions = (
    raw: unknown,
): CloudViewSessionsPayload | undefined => {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "object") {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    const sessionsRaw = record.sessions;
    if (!Array.isArray(sessionsRaw)) {
        return undefined;
    }
    const sessions: ViewSession[] = [];
    for (const entry of sessionsRaw) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const s = entry as Record<string, unknown>;
        if (typeof s.id !== "string" || s.id.length === 0) {
            continue;
        }
        if (!isFiniteNumber(s.startedAt) || !isFiniteNumber(s.endTime)) {
            continue;
        }
        const viewsRaw = Array.isArray(s.views) ? s.views : [];
        const views: ViewRecord[] = [];
        for (const view of viewsRaw) {
            if (!view || typeof view !== "object") {
                continue;
            }
            const v = view as Record<string, unknown>;
            if (
                !isFiniteNumber(v.fileId) ||
                !isFiniteNumber(v.openedAt) ||
                !isFiniteNumber(v.closedAt)
            ) {
                continue;
            }
            views.push({
                fileId: v.fileId,
                openedAt: v.openedAt,
                closedAt: v.closedAt,
            });
        }
        const recomputed = recomputeSessionAggregates({
            id: s.id,
            startedAt: s.startedAt,
            endTime: s.endTime,
            views,
            totalViewTimeMs: 0,
            totalViews: 0,
            uniqueFileIds: [],
            lastViewedFileId: 0,
        });
        // Consecutive re-views bump endTime without changing closedAt.
        sessions.push({
            ...recomputed,
            endTime: Math.max(s.endTime, recomputed.endTime),
        });
    }

    const tombstones: ViewSessionTombstone[] = [];
    if (Array.isArray(record.tombstones)) {
        for (const entry of record.tombstones) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const t = entry as Record<string, unknown>;
            if (typeof t.id !== "string" || !isFiniteNumber(t.deletedAt)) {
                continue;
            }
            tombstones.push({ id: t.id, deletedAt: t.deletedAt });
        }
    }

    return mergeCloudViewSessions({ sessions, tombstones }, undefined);
};

/**
 * Pack local state for an organizer-config patch.
 */
export const packCloudViewSessions = (
    sessions: readonly ViewSession[],
    tombstones: readonly ViewSessionTombstone[] = [],
): CloudViewSessionsPayload =>
    mergeCloudViewSessions({ sessions: [...sessions], tombstones: [...tombstones] }, undefined);

/**
 * True when two cloud payloads match for sync short-circuiting.
 */
export const cloudViewSessionsEqual = (
    a: CloudViewSessionsPayload | undefined,
    b: CloudViewSessionsPayload | undefined,
): boolean => {
    const left = mergeCloudViewSessions(a, undefined);
    const right = mergeCloudViewSessions(b, undefined);
    if (left.sessions.length !== right.sessions.length) {
        return false;
    }
    if ((left.tombstones?.length ?? 0) !== (right.tombstones?.length ?? 0)) {
        return false;
    }
    for (let i = 0; i < left.sessions.length; i += 1) {
        const ls = left.sessions[i]!;
        const rs = right.sessions[i]!;
        if (
            ls.id !== rs.id ||
            ls.endTime !== rs.endTime ||
            ls.totalViews !== rs.totalViews ||
            ls.views.length !== rs.views.length
        ) {
            return false;
        }
    }
    const leftTombs = left.tombstones ?? [];
    const rightTombs = right.tombstones ?? [];
    for (let i = 0; i < leftTombs.length; i += 1) {
        if (
            leftTombs[i]!.id !== rightTombs[i]!.id ||
            leftTombs[i]!.deletedAt !== rightTombs[i]!.deletedAt
        ) {
            return false;
        }
    }
    return true;
};
