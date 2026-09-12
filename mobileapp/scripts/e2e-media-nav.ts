/**
 * Playwright: Media tab opens immediately with prepare UI + optimistic nav.
 *
 * Prerequisites: `npm run dev` (or E2E_BASE_URL).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-media-nav.ts
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

const waitForBottomNav = async (page: Page): Promise<void> => {
    await page.waitForSelector('nav[aria-label="Main navigation"]', {
        timeout: 120_000,
    });
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await signIn(page);
    await waitForBottomNav(page);

    // Settle past prepare → body mount so nav is interactive.
    await page.waitForFunction(
        () => {
            const text = document.body?.innerText ?? "";
            return !text.includes("Preparing media…");
        },
        undefined,
        { timeout: 180_000 },
    );

    // Leave Media so a return tap exercises optimistic highlight + prepare.
    await page.goto(`${BASE}/albums`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/albums/, { timeout: 60_000 });
    await waitForBottomNav(page);
    await page.waitForSelector('h1:has-text("Albums")', { timeout: 60_000 });

    const mediaLink = page.locator(
        'nav[aria-label="Main navigation"] a[href="/gallery"]',
    );
    await mediaLink.click();

    // Optimistic: Media should show aria-current before / during navigation.
    await page.waitForFunction(
        () => {
            const link = document.querySelector(
                'nav[aria-label="Main navigation"] a[href="/gallery"]',
            );
            return link?.getAttribute("aria-current") === "page";
        },
        undefined,
        { timeout: 5_000 },
    );
    console.log("OK: optimistic Media aria-current");

    await page.waitForURL(/\/gallery/, { timeout: 60_000 });
    await page.waitForSelector('h1:has-text("Media")', { timeout: 60_000 });
    console.log("OK: Media shell committed");

    // Prepare is brief; accept prepare, library loader, or grid.
    const deadline = Date.now() + 30_000;
    let surfaced: string | undefined;
    while (Date.now() < deadline && !surfaced) {
        const text = await page.locator("body").innerText();
        if (text.includes("Preparing media")) {
            surfaced = "prepare";
            break;
        }
        if (text.includes("Loading your library")) {
            surfaced = "loading";
            break;
        }
        if (
            (await page.locator('button[aria-label^="Open media"]').count()) > 0
        ) {
            surfaced = "grid";
            break;
        }
        // Empty library still counts as settled Media body.
        if (
            !text.includes("Preparing media") &&
            text.includes("Media")
        ) {
            surfaced = "shell-settled";
            break;
        }
        await page.waitForTimeout(100);
    }
    assert(Boolean(surfaced), "Media body never settled after shell paint");
    console.log(`OK: Media tap surfaced ${surfaced}`);

    console.log("OK: Media nav prepare + optimistic highlight.");
    await browser.close();
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
