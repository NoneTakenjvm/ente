/**
 * Playwright smoke suite against a running app (`npm run dev`), signed in once.
 * Sections: upload, recents, durability, thumbnail-memory. Pass section names
 * to run a subset.
 *
 *   npm run test:e2e:smoke [-- upload recents]
 *
 * Env: E2E_BASE_URL (see scripts/e2e/lib.ts), E2E_UPLOAD_MAX_MS (default
 * 180000), E2E_TEST_CANCEL=1 (also run the upload cancel probe).
 * Upload fixtures live in scripts/fixtures; missing ones are generated with
 * `ffmpeg`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { APP_VERSION } from "../src/lib/app-version";
import type { ViewSession } from "../src/lib/view-sessions";
import { assert, BASE, launch, signIn } from "./e2e/lib";

type ViewSessionsTestApi = {
    replaceSessions: (sessions: ViewSession[]) => void;
    getSessions: () => ViewSession[];
    ensureActiveSession: (now?: number) => void;
    beginView: (fileId: number, openedAt?: number) => void;
    endView: (fileId: number, closedAt?: number) => void;
    getActiveSession: () => (ViewSession & { persisted: boolean }) | undefined;
};

declare global {
    interface Window {
        __viewSessionsTest?: ViewSessionsTestApi;
    }
}

const UPLOAD_MAX_MS = Number(process.env.E2E_UPLOAD_MAX_MS ?? "180000");
const TEST_CANCEL = process.env.E2E_TEST_CANCEL === "1";
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/** Synthetic thumbnails: a getAll of these would be hundreds of MB in UTF-16. */
const SYNTHETIC_THUMBNAIL_COUNT = 2_500;
/** ~48K base64 chars is about 96KB retained per string in V8. */
const SYNTHETIC_PAYLOAD_CHARS = 48 * 1024;

const sections: Record<string, (page: Page) => Promise<void>> = {
    upload: uploadSection,
    recents: recentsSection,
    durability: durabilitySection,
    "thumbnail-memory": thumbnailMemorySection,
};

const main = async (): Promise<void> => {
    const requested = process.argv.slice(2);
    const names = requested.length > 0 ? requested : Object.keys(sections);
    for (const name of names) {
        assert(name in sections, `unknown section: ${name}`);
    }

    const { browser, page } = await launch();
    try {
        console.log(`Signing in at ${BASE} …`);
        await signIn(page);
        for (const name of names) {
            console.log(`--- ${name} ---`);
            await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
            await waitForThumbs(page);
            await sections[name]!(page);
            console.log(`PASSED: ${name}`);
        }
    } finally {
        await browser.close();
    }
};

// --- upload: progress leaves 0/x and completes; optional cancel probe ---

async function uploadSection(page: Page): Promise<void> {
    const fixtures = ensureFixtures();

    const single = await uploadFiles(page, [fixtures[0]!]);
    assert(
        single.sawNonZero || /Upload complete|Uploaded/i.test(single.finalState),
        `Single upload unclear: ${single.finalState.slice(0, 300)}`,
    );
    console.log("OK: single JPEG upload completed");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    // The stuck 0/x case.
    const batch = await uploadFiles(page, fixtures);
    assert(
        batch.sawNonZero,
        `Batch never left 0/x. Final: ${batch.finalState.slice(0, 400)}`,
    );
    console.log("OK: 4-file batch progressed past 0/x and finished");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    if (TEST_CANCEL) {
        await probeUploadCancel(page, fixtures);
    }
}

const ensureFixtures = (): string[] => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    // Distinct solid colours so each file is a unique object.
    return ["red", "green", "blue", "yellow"].map((color, index) => {
        const path = join(FIXTURES_DIR, `e2e-smoke-${index + 1}.jpg`);
        if (!existsSync(path)) {
            execSync(
                `ffmpeg -y -f lavfi -i color=c=${color}:s=64x64:d=1 -frames:v 1 -update 1 "${path}"`,
                { stdio: "ignore" },
            );
        }
        return path;
    });
};

const readUploadSheetState = async (page: Page): Promise<string> => {
    try {
        return await page
            .locator('[data-slot="sheet-content"], [role="dialog"]')
            .first()
            .innerText({ timeout: 2000 });
    } catch {
        return "(sheet not readable)";
    }
};

const startUpload = async (page: Page, paths: string[]): Promise<void> => {
    await page.getByRole("button", { name: "Upload photos and videos" }).click();
    await page
        .getByRole("heading", { name: /Upload photos/ })
        .waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
        () => {
            const input = document.querySelector(
                'label input[type="file"]',
            ) as HTMLInputElement | null;
            return input && !input.disabled;
        },
        undefined,
        { timeout: 120_000 },
    );
    await page
        .locator('label:has-text("Choose files") input[type="file"]')
        .setInputFiles(paths);
    await page
        .getByRole("heading", { name: "Uploading" })
        .waitFor({ state: "visible", timeout: 120_000 });
};

const uploadFiles = async (
    page: Page,
    paths: string[],
): Promise<{ sawNonZero: boolean; finalState: string }> => {
    await startUpload(page, paths);
    const startedAt = Date.now();
    let sawNonZero = false;
    let lastState = "";
    let stuckAtZeroMs = 0;
    let lastCheck = Date.now();

    while (Date.now() - startedAt < UPLOAD_MAX_MS) {
        const state = await readUploadSheetState(page);
        if (state !== lastState) {
            console.log("upload state:", state.replace(/\s+/g, " ").slice(0, 220));
            lastState = state;
        }

        const progress =
            state.match(/uploading\s+(\d+)\s*\/\s*(\d+)/i) ??
            state.match(/(\d+)\s*\/\s*(\d+)/);
        if (progress) {
            if (Number(progress[1]) > 0) {
                sawNonZero = true;
                stuckAtZeroMs = 0;
            } else {
                stuckAtZeroMs += Date.now() - lastCheck;
            }
        }
        lastCheck = Date.now();

        if (
            /HTTP \d{3}/.test(state) ||
            /\d+\s+failed/i.test(state) ||
            state.includes("Could not")
        ) {
            throw new Error(`Upload failed: ${state.slice(0, 400)}`);
        }

        const uploadedCount = Number(state.match(/Uploaded\s+(\d+)/i)?.[1] ?? 0);
        const complete =
            (/Upload complete/i.test(state) &&
                !/Uploading\b/i.test(state.split("\n")[0] ?? state)) ||
            (uploadedCount > 0 && uploadedCount >= paths.length);
        if (complete) {
            return {
                sawNonZero: sawNonZero || paths.length === 1 || uploadedCount > 0,
                finalState: state,
            };
        }

        if (stuckAtZeroMs > 90_000 && !sawNonZero) {
            throw new Error(
                `Stuck at 0/${paths.length} for >90s. State: ${state.slice(0, 400)}`,
            );
        }
        await page.waitForTimeout(1500);
    }
    throw new Error(
        `Upload timed out after ${UPLOAD_MAX_MS}ms. Last: ${lastState.slice(0, 400)}`,
    );
};

const probeUploadCancel = async (page: Page, paths: string[]): Promise<void> => {
    await startUpload(page, paths);
    // Let encrypt/PUT start so abort is meaningful.
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Cancel upload" }).click();

    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
        const state = await readUploadSheetState(page);
        const acknowledged =
            /Cancelled|cancelled|skipped/i.test(state) ||
            (await page.getByText(/Cancelled after/).isVisible().catch(() => false));
        // Or the panel returned to the idle choose-files state.
        const idle =
            (await page.getByText("Choose files").isVisible().catch(() => false)) &&
            !(await page
                .getByRole("heading", { name: "Uploading" })
                .isVisible()
                .catch(() => false));
        if (acknowledged || idle) {
            console.log("OK: cancel acknowledged");
            await page.keyboard.press("Escape");
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(
        `Cancel did not complete. State: ${(await readUploadSheetState(page)).slice(0, 400)}`,
    );
};

// --- recents: nav order, session list/detail, read-only viewer, tracking ---

async function recentsSection(page: Page): Promise<void> {
    await page.waitForFunction(
        () => typeof window.__viewSessionsTest !== "undefined",
        undefined,
        { timeout: 30_000 },
    );
    const [idA, idB] = await captureTwoFileIds(page);
    console.log(`OK: captured live file ids ${idA}, ${idB}`);

    const now = Date.now();
    const minutesAgo = (minutes: number): number => now - minutes * 60_000;
    const views = [
        { fileId: idA, openedAt: minutesAgo(10), closedAt: minutesAgo(9) },
        { fileId: idB, openedAt: minutesAgo(8), closedAt: minutesAgo(7) },
        { fileId: idA, openedAt: minutesAgo(6), closedAt: minutesAgo(5) },
        // Deleted file: must render as a placeholder.
        { fileId: 999_999_001, openedAt: minutesAgo(5.5), closedAt: minutesAgo(5.2) },
    ];
    const fixture: ViewSession = {
        id: "e2e-fixture-1",
        startedAt: minutesAgo(10),
        endTime: minutesAgo(5),
        views,
        totalViewTimeMs: views.reduce((sum, v) => sum + (v.closedAt - v.openedAt), 0),
        totalViews: 4,
        uniqueFileIds: [idA, idB, 999_999_001],
        lastViewedFileId: idA,
    };
    await page.evaluate((session) => {
        window.__viewSessionsTest?.replaceSessions([session]);
    }, fixture);

    const labels = await page
        .getByRole("navigation", { name: "Main navigation" })
        .locator("a")
        .allTextContents();
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
    await page.getByText("4 images").first().click();
    await page.getByLabel(/Deleted Image/i).first().waitFor({ timeout: 10_000 });
    console.log("OK: session list and deleted placeholder in detail");

    const openButtons = page.locator('button[aria-label^="Open media"]');
    const openCount = await openButtons.count();
    assert(openCount >= 2, `expected >=2 openable thumbs, got ${openCount}`);
    await openButtons.nth(Math.min(2, openCount - 1)).click();
    await page.getByRole("button", { name: "Close" }).waitFor({ timeout: 10_000 });
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
                { fileId: 1, openedAt: t - 30 * 60_000, closedAt: t - 5 * 60_000 },
            ],
            totalViewTimeMs: 25 * 60_000,
            totalViews: 1,
            uniqueFileIds: [1],
            lastViewedFileId: 1,
        };
        api.replaceSessions([within]);
        api.ensureActiveSession(t);
        const resumedId = api.getActiveSession()?.id;

        api.replaceSessions([
            {
                ...within,
                id: "resume-stale",
                endTime: t - 2 * 60 * 60_000,
                startedAt: t - 3 * 60 * 60_000,
            },
        ]);
        api.ensureActiveSession(t);
        return { resumedId, freshId: api.getActiveSession()?.id };
    });
    assert(
        resume.resumedId === "resume-within",
        `expected resume-within, got ${resume.resumedId}`,
    );
    assert(
        resume.freshId !== "resume-stale",
        `expected new session after 30m, got ${resume.freshId}`,
    );
    console.log("OK: 30m resume window");
}

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
        // The qualify window starts after media is ready; wait past it.
        await page.waitForTimeout(1300);
        const handle = await page.waitForFunction(
            (): number => {
                const active = window.__viewSessionsTest?.getActiveSession();
                return active?.views[active.views.length - 1]?.fileId ?? 0;
            },
            undefined,
            { timeout: 10_000 },
        );
        const id = await handle.jsonValue();
        await page.getByLabel("Close").click();
        await page.waitForTimeout(400);
        assert(id > 0, `failed to capture file id from thumb ${thumbIndex}`);
        return id;
    };

    const idA = await openAndCapture(0);
    const idB = count >= 2 ? await openAndCapture(1) : idA;
    return [idA, idB];
};

// --- durability: version footer, Select mode chrome, Stamp footer, pagehide ---

async function durabilitySection(page: Page): Promise<void> {
    await page.getByRole("link", { name: "Manage" }).click();
    await page.waitForURL(/\/manage/, { timeout: 60_000 });
    await page.waitForTimeout(2000);
    // The version footer sits at the bottom of the hub scroll area.
    await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main) {
            main.scrollTop = main.scrollHeight;
        }
        window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(500);
    assert(
        (await page.locator("body").innerText()).includes(APP_VERSION),
        `Expected APP_VERSION ${APP_VERSION} on Manage`,
    );
    console.log(`OK: Manage shows ${APP_VERSION}`);

    await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Mobile tools: the wrench opens a menu (force past dev overlays).
    const toolsTrigger = page.getByRole("button", {
        name: /gallery tools|exit active tool/i,
    });
    if ((await toolsTrigger.count()) === 0) {
        const selectToggle = page.getByRole("button", {
            name: /selection mode|exit selection/i,
        });
        if (await selectToggle.count()) {
            await selectToggle.first().click({ force: true });
        } else {
            console.log("SKIP: no tools control found");
        }
    } else {
        await toolsTrigger.first().click({ force: true });
        const selectItem = page.getByRole("menuitem", { name: /select/i });
        if (await selectItem.count()) {
            await selectItem.click({ force: true });
        }
    }

    const done = page.getByRole("button", { name: /^done$/i });
    await done.waitFor({ timeout: 15_000 });
    console.log("OK: Select mode shows Done at 0 picks");

    const nav = page.locator('[aria-label="Main navigation"]');
    assert(!(await nav.isVisible()), "Bottom nav should hide while Select active");
    await done.click();
    await nav.waitFor({ state: "visible", timeout: 15_000 });
    console.log("OK: bottom nav hidden in Select, Done restores it");

    const toolsAgain = page.getByRole("button", { name: /gallery tools|tools/i });
    if (await toolsAgain.count()) {
        await toolsAgain.first().click();
        await page.getByRole("menuitem", { name: /stamp/i }).click();
        const closeStamp = page.getByRole("button", { name: /^close$/i });
        await closeStamp.waitFor({ timeout: 10_000 });
        await closeStamp.click();
        await nav.waitFor({ state: "visible", timeout: 10_000 });
        console.log("OK: Stamp footer visible, Close restores nav");
    }

    await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
    });
    console.log("OK: pagehide did not crash");
}

// --- thumbnail-memory: eviction never does a getAll of ciphertexts ---

async function thumbnailMemorySection(page: Page): Promise<void> {
    const beforeSeed = await readHeap(page);
    const seeded = await seedSyntheticThumbnails(page);
    assert(seeded === SYNTHETIC_THUMBNAIL_COUNT, "seed count mismatch");

    // Force a cold put path: reload so the cached disk size is unknown, then scroll.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForThumbs(page);
    for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(400);
    }
    await page.mouse.wheel(0, -8000);
    // Give eviction / decode work a moment, then sample.
    await page.waitForTimeout(2_800);
    if (typeof page.requestGC === "function") {
        await page.requestGC();
    }
    const afterPuts = await readHeap(page);

    if (beforeSeed && afterPuts) {
        console.log(
            `Heap before seed: ${beforeSeed.usedMB.toFixed(0)}MB; ` +
                `after scroll/puts: ${afterPuts.usedMB.toFixed(0)}MB ` +
                `(${Math.round(afterPuts.ratio * 100)}% of limit)`,
        );
        // A getAll of ~2.5k x 96KB strings would retain ~240MB+ in one array.
        assert(
            afterPuts.usedMB < 900,
            `JS heap too high after thumbnail puts (${afterPuts.usedMB.toFixed(0)}MB), likely getAll retention`,
        );
        assert(
            afterPuts.ratio < 0.85,
            `JS heap ratio ${afterPuts.ratio.toFixed(2)} under pressure, memory fix may have regressed`,
        );
    } else {
        console.warn("performance.memory unavailable, skipping numeric heap asserts");
    }
}

const readHeap = async (
    page: Page,
): Promise<{ usedMB: number; ratio: number } | undefined> =>
    page.evaluate(() => {
        const memory = (
            performance as Performance & {
                memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
            }
        ).memory;
        if (!memory?.jsHeapSizeLimit) {
            return undefined;
        }
        return {
            usedMB: memory.usedJSHeapSize / (1024 * 1024),
            ratio: memory.usedJSHeapSize / memory.jsHeapSizeLimit,
        };
    });

const seedSyntheticThumbnails = async (page: Page): Promise<number> =>
    page.evaluate(
        async ({ count, payloadChars }) => {
            const databases = (await indexedDB.databases?.()) ?? [];
            const organizer = databases.find((db) =>
                (db.name ?? "").startsWith("ente-organizer-"),
            );
            if (!organizer?.name) {
                throw new Error("organizer IDB not found, are you signed in?");
            }
            const dbName = organizer.name;
            const payload = "A".repeat(payloadChars);
            await new Promise<void>((resolve, reject) => {
                const open = indexedDB.open(dbName);
                open.onerror = () => reject(open.error ?? new Error("open"));
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains("thumbnails")) {
                        db.close();
                        reject(new Error("no thumbnails store"));
                        return;
                    }
                    const tx = db.transaction("thumbnails", "readwrite");
                    const store = tx.objectStore("thumbnails");
                    const now = Date.now();
                    for (let i = 0; i < count; i++) {
                        store.put({
                            fileId: 9_000_000 + i,
                            encryptedData: payload,
                            decryptionHeader: "synthetic",
                            byteSize: Math.floor((payloadChars * 3) / 4),
                            lastAccess: now - count + i,
                        });
                    }
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () =>
                        reject(tx.error ?? new Error("seed tx failed"));
                };
            });
            return count;
        },
        {
            count: SYNTHETIC_THUMBNAIL_COUNT,
            payloadChars: SYNTHETIC_PAYLOAD_CHARS,
        },
    );

const waitForThumbs = async (page: Page): Promise<void> => {
    await page.waitForSelector('button[aria-label^="Open media"]', {
        timeout: 180_000,
    });
};

main().catch((error: unknown) => {
    console.error("E2E SMOKE FAILED", error);
    process.exit(1);
});
