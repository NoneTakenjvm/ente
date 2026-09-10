import { describe, expect, it } from "vitest";
import {
    beginViewOnSession,
    createEmptySession,
    endViewOnSession,
    formatSessionDuration,
    formatSessionLore,
    pickResumeSession,
    remapSessionFileId,
    recomputeSessionAggregates,
    sessionSpanMs,
    shouldResumeSession,
    VIEW_SESSION_RESUME_MS,
    type ViewSession,
} from "@/lib/view-sessions";

describe("view-sessions", () => {
    it("appends views and skips consecutive same file", () => {
        let session = createEmptySession(1000, "s1");
        const first = beginViewOnSession(session, 10, 1100);
        expect(first.kind).toBe("appended");
        session = first.session;
        session = endViewOnSession(session, 10, 1500, "appended");

        const again = beginViewOnSession(session, 10, 2000);
        expect(again.kind).toBe("consecutive");
        session = endViewOnSession(again.session, 10, 2500, "consecutive");
        expect(session.views).toHaveLength(1);
        expect(session.totalViews).toBe(1);
        expect(session.endTime).toBe(2500);
    });

    it("appends when the same file returns after another", () => {
        let session = createEmptySession(1000, "s1");
        session = beginViewOnSession(session, 10, 1100).session;
        session = endViewOnSession(session, 10, 1200, "appended");
        session = beginViewOnSession(session, 20, 1300).session;
        session = endViewOnSession(session, 20, 1400, "appended");
        session = beginViewOnSession(session, 10, 1500).session;
        session = endViewOnSession(session, 10, 1600, "appended");
        expect(session.views.map((v) => v.fileId)).toEqual([10, 20, 10]);
        expect(session.uniqueFileIds).toEqual([10, 20]);
        expect(session.totalViews).toBe(3);
        expect(session.lastViewedFileId).toBe(10);
    });

    it("does not treat empty sessions as persisted", () => {
        const session = createEmptySession(1000, "s1");
        expect(session.persisted).toBe(false);
        expect(session.views).toHaveLength(0);
    });

    it("resumes within one hour and starts new after", () => {
        const sessions: ViewSession[] = [
            {
                id: "old",
                startedAt: 1,
                endTime: 1000,
                views: [
                    { fileId: 1, openedAt: 500, closedAt: 1000 },
                ],
                totalViewTimeMs: 500,
                totalViews: 1,
                uniqueFileIds: [1],
                lastViewedFileId: 1,
            },
        ];
        expect(shouldResumeSession(1000, 1000 + VIEW_SESSION_RESUME_MS)).toBe(
            true,
        );
        expect(
            shouldResumeSession(1000, 1000 + VIEW_SESSION_RESUME_MS + 1),
        ).toBe(false);
        expect(pickResumeSession(sessions, 1000 + 30 * 60 * 1000)?.id).toBe(
            "old",
        );
        expect(
            pickResumeSession(sessions, 1000 + VIEW_SESSION_RESUME_MS + 1),
        ).toBeUndefined();
    });

    it("remaps file ids after replace", () => {
        const session = recomputeSessionAggregates({
            id: "s1",
            startedAt: 1,
            endTime: 300,
            views: [
                { fileId: 10, openedAt: 100, closedAt: 150 },
                { fileId: 20, openedAt: 200, closedAt: 300 },
                { fileId: 10, openedAt: 250, closedAt: 280 },
            ],
            totalViewTimeMs: 0,
            totalViews: 0,
            uniqueFileIds: [],
            lastViewedFileId: 0,
        });
        const remapped = remapSessionFileId(session, 10, 99);
        expect(remapped.views.map((v) => v.fileId)).toEqual([99, 20, 99]);
        expect(remapped.uniqueFileIds).toEqual([99, 20]);
        expect(remapped.lastViewedFileId).toBe(99);
    });

    it("formats lore and duration", () => {
        const session: ViewSession = {
            id: "s1",
            startedAt: 0,
            endTime: 125_000,
            views: [
                { fileId: 1, openedAt: 5_000, closedAt: 10_000 },
                { fileId: 2, openedAt: 20_000, closedAt: 125_000 },
            ],
            totalViewTimeMs: 110_000,
            totalViews: 2,
            uniqueFileIds: [1, 2],
            lastViewedFileId: 2,
        };
        expect(sessionSpanMs(session)).toBe(120_000);
        expect(formatSessionDuration(120_000)).toBe("2m");
        expect(formatSessionLore(session)).toBe("2 images · 2m");
        expect(formatSessionDuration(3_500)).toBe("4s");
        expect(formatSessionDuration(3_660_000)).toBe("1h 1m");
    });
});
