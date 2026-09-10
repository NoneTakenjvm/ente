/**
 * Playwright smoke: Tools menu + quick-rotate draft/apply flow.
 *
 * Prerequisites: app running (`npm run dev`).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-quick-rotate.ts
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

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

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setViewportSize({ width: 390, height: 844 });

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    await waitForThumbs(page);
    console.log("OK: gallery loaded");

    assert(
        (await page.getByRole("button", { name: "Gallery tools" }).count()) ===
            1,
        "Tools button missing",
    );
    assert(
        (await page.getByRole("button", { name: "Select media" }).count()) ===
            0,
        "Old Select toggle should be gone",
    );
    assert(
        (await page.getByRole("button", { name: /Stamp tags/i }).count()) === 0,
        "Old Stamp toggle should be gone",
    );
    console.log("OK: Tools menu replaces standalone toggles");

    await page.getByRole("button", { name: "Gallery tools" }).click();
    await page.getByRole("menuitem", { name: /Rotate/i }).click();
    await page
        .getByText(/Tap photos to rotate/i)
        .waitFor({ timeout: 10_000 });
    console.log("OK: rotate mode footer");

    const firstThumb = page
        .locator('button[aria-label^="Select media"], button[aria-label^="Rotate media"]')
        .first();
    await firstThumb.click();
    await page.waitForTimeout(400);
    assert(
        (await page.getByText(/1 pending/i).count()) > 0,
        "Expected 1 pending after first tap",
    );
    assert(
        (await page.locator("text=90°").count()) > 0,
        "Expected 90° badge on thumb",
    );
    console.log("OK: first tap drafts 90°");

    await firstThumb.click();
    await page.waitForTimeout(300);
    assert(
        (await page.getByText(/1 pending/i).count()) > 0,
        "Still one pending after second tap",
    );
    assert(
        (await page.locator("text=180°").count()) > 0,
        "Expected 180° badge after second tap",
    );
    console.log("OK: second tap advances to 180°");

    // Third + fourth clear
    await firstThumb.click();
    await page.waitForTimeout(200);
    await firstThumb.click();
    await page.waitForTimeout(300);
    assert(
        (await page.getByText(/Tap photos to rotate/i).count()) > 0,
        "Fourth tap should clear pending",
    );
    console.log("OK: fourth tap clears draft");

    // Draft two photos at 90° and Apply one (full upload can be slow — do one)
    const thumbs = page.locator(
        'button[aria-label^="Select media"], button[aria-label^="Rotate media"], button[aria-label^="Open media"]',
    );
    // Re-enter rotate if closed — still in mode
    await thumbs.nth(0).click();
    await page.waitForTimeout(200);
    await thumbs.nth(1).click();
    await page.waitForTimeout(300);
    assert(
        (await page.getByText(/2 pending/i).count()) > 0,
        "Expected 2 pending",
    );

    // Discard second path: discard then re-draft one and apply
    await page.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(200);
    assert(
        (await page.getByText(/Tap photos to rotate/i).count()) > 0,
        "Discard should clear drafts",
    );
    console.log("OK: Discard clears drafts");

    await thumbs.nth(0).click();
    await page.getByText(/1 pending/i).waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Apply" }).click();
    // Wait for success toast or footer exit (upload can take a while on HEIC convert).
    const applyOutcome = await Promise.race([
        page
            .getByText(/Rotated 1 photo/i)
            .waitFor({ timeout: 240_000 })
            .then(() => "success" as const),
        page
            .getByText(/failed/i)
            .waitFor({ timeout: 240_000 })
            .then(() => "failed" as const),
    ]);
    assert(applyOutcome === "success", `Apply did not succeed (${applyOutcome})`);
    await page
        .getByText(/Tap photos to rotate|pending · tap/i)
        .waitFor({ state: "hidden", timeout: 30_000 });
    console.log("OK: Apply uploaded and exited rotate mode");

    // Tools → Select still works
    await page.getByRole("button", { name: "Gallery tools" }).click();
    await page.getByRole("menuitem", { name: /^Select/i }).click();
    await page.waitForTimeout(400);
    assert(
        (await page.locator('button[aria-label^="Select media"]').count()) > 0,
        "Select mode should arm thumb taps",
    );
    console.log("OK: Select mode via Tools");

    await browser.close();
    console.log("Quick-rotate e2e smoke passed.");
};

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
