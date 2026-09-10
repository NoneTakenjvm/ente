/**
 * Playwright smoke: Recents tab + view-session fixtures.
 *
 * Prerequisites: app running (`npm run dev`).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-recents.ts
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";
import type { ViewSession } from "../src/lib/view-sessions";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

type ViewSessionsTestApi = {
    replaceSessions: (sessions: ViewSession[]) => void;
    getSessions: () => ViewSession[];
    ensureActiveSession: (now?: number) => void;
    beginView: (fileId: number, openedAt?: number) => void;
    endView: (fileId: number, closedAt?: number) => void;
    getActiveSession: () =>
        | (ViewSession & { persisted: boolean })
        | undefined;
};

declare global {
    interface Window {
        __viewSessionsTest?: ViewSessionsTestApi;
    }
}

const signIn = async (page: Page): Promise<void> => {
    await page.goto(`${BASE}/dev-login`, { waitUntil: "domcontentloaded" });
    try {
        await page.waitForURL(/\/gallery/, { timeout: 60_000 });
        return;
    } catch {
        // fall through
    }
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const waitForThumbs = async (page: Page): Promise<void> => {
    await page.waitForSelector('button[aria-label^="Open media"]', {
        timeout: 120_000,
    });
};

const waitForTestApi = async (page: Page): Promise<void> => {
    await page.waitForFunction(
        () => typeof window.__viewSessionsTest !== "undefined",
        undefined,
        { timeout: 30_000 },
    );
};

const captureTwoFileIds = async (page: Page): Promise<[number, number]> => {
    const thumbs = page.locator('button[aria-label^="Open media"]');
    const count = await thumbs.count();
    assert(count >= 1, "gallery has no media thumbs");

    const openAndCapture = async (thumbIndex: number): Promise<number> => {
        await thumbs.nth(thumbIndex).click();
        await page.getByLabel("Close").waitFor({ timeout: 30_000 });
        await page.waitForSelector(
            '.fixed img[src^="blob:"], .fixed video[src], .fixed video source',
            { timeout: 90_000 },
        );
        // Qualify window starts after media ready — wait past it.
        await page.waitForTimeout(1300);
        const fileId = await page.waitForFunction(
            (): number => {
                const active = window.__viewSessionsTest?.getActiveSession();
                const last = active?.views[active.views.length - 1];
                return last?.fileId ?? 0;
            },
            undefined,
            { timeout: 10_000 },
        );
        const id = await fileId.jsonValue();
        await page.getByLabel("Close").click();
        await page.waitForTimeout(400);
        assert(
            typeof id === "number" && id > 0,
            `failed to capture file id from thumb ${thumbIndex}`,
        );
        return id;
    };

    const idA = await openAndCapture(0);
    const idB =
        count >= 2 ? await openAndCapture(Math.min(1, count - 1)) : idA;
    return [idA, idB];
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setViewportSize({ width: 390, height: 844 });

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    await waitForThumbs(page);
    console.log("OK: gallery loaded");

    await waitForTestApi(page);
    console.log("OK: __viewSessionsTest hook ready");

    const [idA, idB] = await captureTwoFileIds(page);
    console.log(`OK: captured live file ids ${idA}, ${idB}`);

    const now = Date.now();
    const fixture: ViewSession = {
        id: "e2e-fixture-1",
        startedAt: now - 10 * 60_000,
        endTime: now - 5 * 60_000,
        views: [
            {
                fileId: idA,
                openedAt: now - 10 * 60_000,
                closedAt: now - 9 * 60_000,
            },
            {
                fileId: idB,
                openedAt: now - 8 * 60_000,
                closedAt: now - 7 * 60_000,
            },
            {
                fileId: idA,
                openedAt: now - 6 * 60_000,
                closedAt: now - 5 * 60_000,
            },
            {
                fileId: 999_999_001,
                openedAt: now - 5.5 * 60_000,
                closedAt: now - 5.2 * 60_000,
            },
        ],
        totalViewTimeMs: 0,
        totalViews: 4,
        uniqueFileIds: [idA, idB, 999_999_001],
        lastViewedFileId: idA,
    };
    fixture.totalViewTimeMs = fixture.views.reduce(
        (sum, v) => sum + (v.closedAt - v.openedAt),
        0,
    );

    await page.evaluate((session) => {
        window.__viewSessionsTest?.replaceSessions([session]);
    }, fixture);
    console.log("OK: injected fixture session");

    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const labels = await nav.locator("a").allTextContents();
    const albumsIdx = labels.findIndex((t) => t.includes("Albums"));
    const recentsIdx = labels.findIndex((t) => t.includes("Recents"));
    const manageIdx = labels.findIndex((t) => t.includes("Manage"));
    assert(
        albumsIdx >= 0 && recentsIdx >= 0 && manageIdx >= 0,
        `nav missing tabs: ${labels.join("|")}`,
    );
    assert(
        albumsIdx < recentsIdx && recentsIdx < manageIdx,
        "Recents should sit between Albums and Manage",
    );
    console.log("OK: nav order");

    await page.getByRole("link", { name: "Recents" }).click();
    await page.waitForURL(/\/recents/, { timeout: 15_000 });
    await page.getByText("4 images").first().waitFor({ timeout: 10_000 });
    console.log("OK: session list shows lore");

    // SessionListCard is a Card with onClick — click the lore line's card.
    await page.getByText("4 images").first().click();
    await page
        .getByLabel(/Deleted Image/i)
        .first()
        .waitFor({ timeout: 10_000 });
    console.log("OK: deleted placeholder in session detail");

    const openButtons = page.locator('button[aria-label^="Open media"]');
    const openCount = await openButtons.count();
    assert(openCount >= 2, `expected ≥2 openable thumbs, got ${openCount}`);

    await openButtons.nth(Math.min(2, openCount - 1)).click();
    await page.getByRole("button", { name: "Close" }).waitFor({
        timeout: 10_000,
    });
    assert(
        (await page.getByRole("button", { name: "Delete" }).count()) === 0,
        "read-only viewer should hide Delete",
    );
    assert(
        (await page.getByRole("button", { name: "Tags" }).count()) === 0,
        "read-only viewer should hide Tags",
    );
    console.log("OK: read-only carousel chrome");

    await page.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(300);

    const tracking = await page.evaluate(
        ({ a, b }: { a: number; b: number }) => {
            const api = window.__viewSessionsTest!;
            api.replaceSessions([]);
            api.ensureActiveSession(Date.now());
            const t0 = Date.now();
            api.beginView(a, t0);
            api.endView(a, t0 + 2000);
            api.beginView(a, t0 + 3000);
            api.endView(a, t0 + 4000);
            api.beginView(b, t0 + 5000);
            api.endView(b, t0 + 6000);
            api.beginView(a, t0 + 7000);
            api.endView(a, t0 + 8000);
            const active = api.getActiveSession();
            return {
                views: active?.views.map((v) => v.fileId) ?? [],
                total: active?.totalViews ?? 0,
            };
        },
        { a: idA, b: idB },
    );
    assert(
        tracking.views.join(",") === `${idA},${idB},${idA}`,
        `dedupe failed: ${tracking.views.join(",")}`,
    );
    assert(tracking.total === 3, `expected 3 views, got ${tracking.total}`);
    console.log("OK: consecutive dedupe + re-append");

    const resume = await page.evaluate(() => {
        const api = window.__viewSessionsTest!;
        const t = Date.now();
        const within: ViewSession = {
            id: "resume-within",
            startedAt: t - 30 * 60_000,
            endTime: t - 5 * 60_000,
            views: [
                {
                    fileId: 1,
                    openedAt: t - 30 * 60_000,
                    closedAt: t - 5 * 60_000,
                },
            ],
            totalViewTimeMs: 25 * 60_000,
            totalViews: 1,
            uniqueFileIds: [1],
            lastViewedFileId: 1,
        };
        api.replaceSessions([within]);
        api.ensureActiveSession(t);
        const resumedId = api.getActiveSession()?.id;

        const stale: ViewSession = {
            ...within,
            id: "resume-stale",
            endTime: t - 2 * 60 * 60_000,
            startedAt: t - 3 * 60 * 60_000,
        };
        api.replaceSessions([stale]);
        api.ensureActiveSession(t);
        const freshId = api.getActiveSession()?.id;
        return { resumedId, freshId };
    });
    assert(
        resume.resumedId === "resume-within",
        `expected resume-within, got ${resume.resumedId}`,
    );
    assert(
        resume.freshId !== "resume-stale",
        `expected new session after 1h, got ${resume.freshId}`,
    );
    console.log("OK: 1h resume window");

    await browser.close();
    console.log("All Recents e2e checks passed.");
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
