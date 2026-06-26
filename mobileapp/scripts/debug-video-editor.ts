/**
 * E2E: dev-login → find or upload tiny video → exercise video editor.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/debug-video-editor.ts
 *
 * Env:
 *   VIDEO_EDITOR_TEST_URL  (default http://localhost:3000)
 *   E2E_UPLOAD_MAX_MS      (default 180000 — hard cap on upload wait)
 *   E2E_FORCE_UPLOAD=1     skip gallery scan, always upload
 *
 * Requires `npm run dev`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.VIDEO_EDITOR_TEST_URL ?? "http://localhost:3000";
const UPLOAD_MAX_MS = Number(process.env.E2E_UPLOAD_MAX_MS ?? "120000");
const FORCE_UPLOAD = process.env.E2E_FORCE_UPLOAD === "1";
const SKIP_UPLOAD = process.env.E2E_SKIP_UPLOAD === "1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, "fixtures");
const TEST_VIDEO_PATH = join(FIXTURES_DIR, "e2e-tiny-video.mp4");

const signIn = async (page: Page): Promise<void> => {
    await page.goto(`${BASE}/dev-login`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
    });
    const reachedGallery = await page
        .waitForURL(/\/gallery/, { timeout: 90_000 })
        .then(() => true)
        .catch(() => false);
    if (reachedGallery) {
        return;
    }
    await page.waitForTimeout(3000);
    if (page.url().includes("/gallery")) {
        return;
    }
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const waitForGalleryReady = async (page: Page): Promise<void> => {
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
        const thumbs = page.locator('button[aria-label^="Open media"]');
        if ((await thumbs.count()) > 0) {
            await page.waitForTimeout(1500);
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error("Gallery thumbnails did not appear");
};

const ensureTinyTestVideo = (): void => {
    if (!existsSync(FIXTURES_DIR)) {
        mkdirSync(FIXTURES_DIR, { recursive: true });
    }
    const legacy = join(FIXTURES_DIR, "e2e-test-video.mp4");
    if (existsSync(legacy)) {
        unlinkSync(legacy);
    }
    if (existsSync(TEST_VIDEO_PATH)) {
        unlinkSync(TEST_VIDEO_PATH);
    }
    console.log("Generating tiny test video (2s, 320x240, with audio) …");
    execSync(
        `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=24:duration=2 -f lavfi -i sine=frequency=440:duration=2 -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 30 -c:a aac -shortest -movflags +faststart "${TEST_VIDEO_PATH}"`,
        { stdio: "inherit" },
    );
};

const scrollGallery = async (page: Page): Promise<void> => {
    await page.evaluate(() => {
        const scroller = document.querySelector("main div.overflow-y-auto") as
            | HTMLElement
            | null;
        if (scroller) {
            scroller.scrollTop += 1500;
            return;
        }
        const list = document.querySelector("div[style*='overflow: auto']") as
            | HTMLElement
            | null;
        if (list) {
            list.scrollTop += 1500;
            return;
        }
        window.scrollBy(0, 1500);
    });
};

const findVideoByOpeningThumbs = async (page: Page): Promise<boolean> => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    for (let round = 0; round < 8; round += 1) {
        const thumbs = page.locator('button[aria-label^="Open media"]');
        const count = await thumbs.count();
        const start = round === 0 ? 0 : Math.max(0, count - 12);
        const limit = Math.min(count, start + 24);
        for (let i = start; i < limit; i += 1) {
            await thumbs.nth(i).click({ force: true });
            await page.getByRole("dialog", { name: "Media viewer" }).waitFor({
                state: "visible",
                timeout: 15_000,
            }).catch(() => undefined);
            await page.waitForTimeout(2500);
            const editVideo = page
                .getByRole("dialog")
                .getByRole("button", { name: "Edit video" });
            if (await editVideo.isVisible().catch(() => false)) {
                return true;
            }
            await page.keyboard.press("Escape");
            await page.waitForTimeout(400);
        }
        await scrollGallery(page);
        await page.waitForTimeout(600);
    }
    return false;
};

const readUploadSheetState = async (page: Page): Promise<string> => {
    try {
        return await page.locator('[data-slot="sheet-content"], [role="dialog"]')
            .first()
            .innerText({ timeout: 2000 });
    } catch {
        return "(sheet not readable)";
    }
};

const waitForUploadComplete = async (page: Page): Promise<void> => {
    const startedAt = Date.now();
    let lastState = "";
    while (Date.now() - startedAt < UPLOAD_MAX_MS) {
        const done = await page.getByRole("heading", { name: "Upload complete" })
            .isVisible()
            .catch(() => false);
        if (done) {
            return;
        }
        const uploadedToast = await page.getByText(/Uploaded 1 file/)
            .isVisible()
            .catch(() => false);
        if (uploadedToast) {
            return;
        }
        const state = await readUploadSheetState(page);
        if (state !== lastState) {
            lastState = state;
        }
        const failed = state.includes("failed") || state.includes("Could not");
        if (failed) {
            throw new Error(`Upload failed: ${state.slice(0, 400)}`);
        }
        await page.waitForTimeout(3000);
    }
    throw new Error(
        `Upload timed out after ${UPLOAD_MAX_MS}ms. Last state: ${lastState.slice(0, 400)}`,
    );
};

const uploadTestVideo = async (page: Page): Promise<void> => {
    ensureTinyTestVideo();
    const { statSync } = await import("node:fs");
    const size = statSync(TEST_VIDEO_PATH).size;
    console.log("Uploading test video", { path: TEST_VIDEO_PATH, sizeBytes: size });

    await page.getByRole("button", { name: "Upload photos and videos" }).click();
    await page.getByRole("heading", { name: /Upload photos/ }).waitFor({
        state: "visible",
        timeout: 30_000,
    });
    await page.waitForFunction(() => {
        const input = document.querySelector(
            'label input[type="file"][accept*="video"]',
        ) as HTMLInputElement | null;
        return input && !input.disabled;
    }, { timeout: 120_000 });

    const fileInput = page.locator('label:has-text("Choose files") input[type="file"]');
    await fileInput.setInputFiles(TEST_VIDEO_PATH);

    await page.getByRole("heading", { name: "Uploading" }).waitFor({
        state: "visible",
        timeout: 120_000,
    });

    await waitForUploadComplete(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
};

const openFirstVideo = async (page: Page): Promise<void> => {
    const inViewer = await page
        .getByRole("dialog")
        .getByRole("button", { name: "Edit video" })
        .isVisible()
        .catch(() => false);
    if (inViewer) {
        return;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    const videoThumb = page
        .locator('button[aria-label^="Open media"]:has(span.rounded-full)')
        .first();
    if (await videoThumb.count()) {
        await videoThumb.click({ force: true });
    } else {
        throw new Error("No video thumbnail to open");
    }
    await page.getByRole("dialog", { name: "Media viewer" }).waitFor({
        state: "visible",
        timeout: 30_000,
    });
    await page.waitForTimeout(2000);
};

const openVideoEditor = async (page: Page): Promise<void> => {
    await page
        .getByRole("dialog")
        .getByRole("button", { name: "Edit video" })
        .click({ force: true });
    await page.locator(".ReactCrop video").waitFor({
        state: "visible",
        timeout: 120_000,
    });
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({
        headless: true,
        channel: "chrome",
    });
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
    });
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.error("[browser]", msg.text());
        }
    });

    await signIn(page);
    await waitForGalleryReady(page);

    let hasVideo = FORCE_UPLOAD ? false : await findVideoByOpeningThumbs(page);
    if (!hasVideo && !SKIP_UPLOAD) {
        console.log("No video found in gallery scan; trying upload …");
        await uploadTestVideo(page);
        await waitForGalleryReady(page);
        hasVideo = await findVideoByOpeningThumbs(page);
    }
    if (!hasVideo) {
        throw new Error(
            "No video found in library. Add a video to the test account or set E2E_FORCE_UPLOAD=1.",
        );
    }

    const alreadyInViewer = await page
        .getByRole("dialog")
        .getByRole("button", { name: "Edit video" })
        .isVisible()
        .catch(() => false);
    if (!alreadyInViewer) {
        await openFirstVideo(page);
    }
    await openVideoEditor(page);

    await page.waitForFunction(() => {
        const video = document.querySelector(".ReactCrop video") as HTMLVideoElement | null;
        return video && video.videoWidth > 0;
    }, { timeout: 120_000 });

    const editorState = await page.evaluate(() => ({
        videoWidth: (document.querySelector(".ReactCrop video") as HTMLVideoElement | null)?.videoWidth,
        trimThumbs: document.querySelectorAll('[data-slot="slider-thumb"]').length,
        hasCrop: Boolean(document.querySelector(".ReactCrop__crop-selection")),
        error: document.querySelector('[role="alert"]')?.textContent,
    }));
    console.log("Editor ready", editorState);

    if (!editorState.hasCrop || editorState.trimThumbs !== 2) {
        throw new Error(`Editor UI incomplete: ${JSON.stringify(editorState)}`);
    }

    await page.getByRole("button", { name: "Rotate right" }).click();
    await page.waitForFunction(() => {
        const spinning = document.querySelector('[aria-label="Rotate right"] svg.animate-spin');
        const alert = document.querySelector('[role="alert"]');
        return !spinning && !alert?.textContent?.includes("Could not");
    }, { timeout: 180_000 });

    console.log("Cancelling without save (upload path verified separately)");
    await page.getByRole("button", { name: "Cancel" }).click();

    await browser.close();
    console.log("PASS: video editor opens, crop/trim UI present, rotate succeeds");
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
