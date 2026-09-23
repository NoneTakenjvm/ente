/**
 * E2E smoke: dev-login → upload tiny JPEGs → assert progress leaves 0/x → complete.
 * Optional cancel probe with E2E_TEST_CANCEL=1.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-upload-smoke.ts
 *
 * Requires `npm run dev` (NODE_ENV=development for /dev-login).
 *
 * Env:
 *   UPLOAD_SMOKE_URL       (default http://localhost:3000)
 *   E2E_UPLOAD_MAX_MS      (default 180000)
 *   E2E_TEST_CANCEL=1      also run a multi-file cancel check
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.UPLOAD_SMOKE_URL ?? "http://localhost:3000";
const UPLOAD_MAX_MS = Number(process.env.E2E_UPLOAD_MAX_MS ?? "180000");
const TEST_CANCEL = process.env.E2E_TEST_CANCEL === "1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, "fixtures");

const ensureFixtures = (): string[] => {
    if (!existsSync(FIXTURES_DIR)) {
        mkdirSync(FIXTURES_DIR, { recursive: true });
    }
    const paths: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
        const path = join(FIXTURES_DIR, `e2e-smoke-${i}.jpg`);
        // Distinct solid colours so each file is a unique object.
        const color = ["red", "green", "blue", "yellow"][i - 1]!;
        execSync(
            `ffmpeg -y -f lavfi -i color=c=${color}:s=64x64:d=1 -frames:v 1 -update 1 "${path}"`,
            { stdio: "ignore" },
        );
        paths.push(path);
    }
    return paths;
};

const signIn = async (page: Page): Promise<void> => {
    console.log("Signing in via /dev-login …");
    await page.goto(`${BASE}/dev-login`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
    });
    const reachedGallery = await page
        .waitForURL(/\/gallery/, { timeout: 90_000 })
        .then(() => true)
        .catch(() => false);
    if (reachedGallery) {
        console.log("OK: reached gallery via /dev-login");
        return;
    }
    await page.waitForTimeout(3000);
    if (page.url().includes("/gallery")) {
        console.log("OK: reached gallery (delayed)");
        return;
    }
    console.log("Falling back to /login form …");
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
    console.log("OK: signed in via login form");
};

const waitForGalleryReady = async (page: Page): Promise<void> => {
    await page
        .waitForLoadState("networkidle", { timeout: 60_000 })
        .catch(() => undefined);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
        const thumbs = page.locator('button[aria-label^="Open media"]');
        if ((await thumbs.count()) > 0) {
            await page.waitForTimeout(1000);
            return;
        }
        const syncing = await page
            .getByText(/sync|loading|decrypt/i)
            .first()
            .isVisible()
            .catch(() => false);
        if (!syncing && Date.now() - startedAt > 15_000) {
            // Empty library is fine for upload smoke.
            return;
        }
        await page.waitForTimeout(500);
    }
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

const openUploadPanel = async (page: Page): Promise<void> => {
    await page.getByRole("button", { name: "Upload photos and videos" }).click();
    await page.getByRole("heading", { name: /Upload photos/ }).waitFor({
        state: "visible",
        timeout: 30_000,
    });
    await page.waitForFunction(
        () => {
            const input = document.querySelector(
                'label input[type="file"]',
            ) as HTMLInputElement | null;
            return input && !input.disabled;
        },
        { timeout: 120_000 },
    );
};

const waitForUploadProgress = async (
    page: Page,
    opts: { expectComplete?: boolean; fileCount: number },
): Promise<{ sawNonZero: boolean; finalState: string }> => {
    const startedAt = Date.now();
    let sawNonZero = false;
    let lastState = "";
    let stuckAtZeroMs = 0;
    let lastZeroCheck = Date.now();

    while (Date.now() - startedAt < UPLOAD_MAX_MS) {
        const state = await readUploadSheetState(page);
        if (state !== lastState) {
            console.log("upload state:", state.replace(/\s+/g, " ").slice(0, 220));
            lastState = state;
        }

        const progressMatch = state.match(/uploading\s+(\d+)\s*\/\s*(\d+)/i)
            ?? state.match(/(\d+)\s*\/\s*(\d+)/);
        if (progressMatch) {
            const current = Number(progressMatch[1]);
            if (current > 0) {
                sawNonZero = true;
                stuckAtZeroMs = 0;
            } else {
                stuckAtZeroMs += Date.now() - lastZeroCheck;
            }
        }
        lastZeroCheck = Date.now();

        if (
            /HTTP \d{3}/.test(state) ||
            /\d+\s+failed/i.test(state) ||
            state.includes("Could not")
        ) {
            throw new Error(`Upload failed: ${state.slice(0, 400)}`);
        }

        const doneInSheet =
            /Upload complete/i.test(state) &&
            !/Uploading\b/i.test(state.split("\n")[0] ?? state);

        const uploadedMatch = state.match(/Uploaded\s+(\d+)/i);
        const uploadedCount = uploadedMatch ? Number(uploadedMatch[1]) : 0;
        const sheetSuccess =
            doneInSheet ||
            (uploadedCount > 0 && uploadedCount >= opts.fileCount);

        if (opts.expectComplete !== false && sheetSuccess) {
            return {
                sawNonZero: sawNonZero || opts.fileCount === 1 || uploadedCount > 0,
                finalState: state,
            };
        }

        if (/Cancelled after|Upload cancelled/i.test(state)) {
            return { sawNonZero, finalState: state };
        }

        if (stuckAtZeroMs > 90_000 && !sawNonZero) {
            throw new Error(
                `Stuck at 0/${opts.fileCount} for >90s. State: ${state.slice(0, 400)}`,
            );
        }

        await page.waitForTimeout(1500);
    }
    throw new Error(
        `Upload timed out after ${UPLOAD_MAX_MS}ms. Last: ${lastState.slice(0, 400)}`,
    );
};

const uploadFiles = async (
    page: Page,
    paths: string[],
): Promise<{ sawNonZero: boolean; finalState: string }> => {
    await openUploadPanel(page);
    const fileInput = page.locator(
        'label:has-text("Choose files") input[type="file"]',
    );
    await fileInput.setInputFiles(paths);
    await page.getByRole("heading", { name: "Uploading" }).waitFor({
        state: "visible",
        timeout: 120_000,
    });
    return waitForUploadProgress(page, {
        expectComplete: true,
        fileCount: paths.length,
    });
};

const probeCancel = async (page: Page, paths: string[]): Promise<void> => {
    console.log("Cancel probe: start 4-file upload then cancel …");
    await openUploadPanel(page);
    const fileInput = page.locator(
        'label:has-text("Choose files") input[type="file"]',
    );
    await fileInput.setInputFiles(paths);
    await page.getByRole("heading", { name: "Uploading" }).waitFor({
        state: "visible",
        timeout: 60_000,
    });
    // Let encrypt/PUT start so abort is meaningful.
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Cancel upload" }).click();
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
        const state = await readUploadSheetState(page);
        if (
            /Cancelled|cancelled|skipped/i.test(state) ||
            (await page.getByText(/Cancelled after/).isVisible().catch(() => false))
        ) {
            console.log("OK: cancel acknowledged —", state.replace(/\s+/g, " ").slice(0, 160));
            await page.keyboard.press("Escape");
            return;
        }
        // Panel closed / returned to idle choose-files.
        if (await page.getByText("Choose files").isVisible().catch(() => false)) {
            const stillUploading = await page
                .getByRole("heading", { name: "Uploading" })
                .isVisible()
                .catch(() => false);
            if (!stillUploading) {
                console.log("OK: cancel returned panel to idle");
                await page.keyboard.press("Escape");
                return;
            }
        }
        await page.waitForTimeout(500);
    }
    throw new Error(
        `Cancel did not complete. State: ${(await readUploadSheetState(page)).slice(0, 400)}`,
    );
};

const main = async (): Promise<void> => {
    const fixtures = ensureFixtures();
    console.log("BASE", BASE);
    console.log("fixtures", fixtures.length);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log("browser console error:", msg.text().slice(0, 300));
        }
    });
    page.on("pageerror", (err) => {
        console.log("pageerror:", String(err).slice(0, 300));
    });

    try {
        await signIn(page);
        await waitForGalleryReady(page);
        console.log("Gallery ready at", page.url());

        // Single-file upload (fast path).
        console.log("Uploading 1 JPEG …");
        const one = await uploadFiles(page, [fixtures[0]!]);
        if (!one.sawNonZero && !/Uploaded 1 file/i.test(one.finalState)) {
            // Single file may jump straight to complete without showing 1/1 long enough.
            const toastOk = await page
                .getByText(/Uploaded 1 file/)
                .isVisible()
                .catch(() => false);
            if (!toastOk && !/Upload complete|Uploaded/i.test(one.finalState)) {
                throw new Error(`Single upload unclear: ${one.finalState.slice(0, 300)}`);
            }
        }
        console.log("OK: single JPEG upload completed");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(800);

        // Concurrent batch (4) — the stuck 0/x case.
        console.log("Uploading 4 JPEGs concurrently …");
        const batch = await uploadFiles(page, fixtures);
        if (!batch.sawNonZero) {
            throw new Error(
                `Batch never left 0/x. Final: ${batch.finalState.slice(0, 400)}`,
            );
        }
        console.log("OK: 4-file batch progressed past 0/x and finished");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);

        if (TEST_CANCEL) {
            await probeCancel(page, fixtures);
        }

        console.log("UPLOAD SMOKE PASSED");
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error("UPLOAD SMOKE FAILED", error);
    process.exit(1);
});
