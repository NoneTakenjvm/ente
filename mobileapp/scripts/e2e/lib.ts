/**
 * Shared Playwright helpers for the e2e scripts. Credentials come from
 * `.env.local` (see `src/dev/test-account.ts`); the app must be running
 * (`npm run dev` for `/dev-login`).
 */
import { config } from "dotenv";
import { chromium, type Browser, type Page } from "playwright";

config({ path: ".env.local" });

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

/** Launches headless Chromium with a phone-sized page. */
export const launch = async (): Promise<{ browser: Browser; page: Page }> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    return { browser, page };
};

/** Signs in through `/dev-login`, falling back to the `/login` form. */
export const signIn = async (page: Page): Promise<void> => {
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
    // Loaded after dotenv so the NEXT_PUBLIC_DEV_TEST_* vars are set.
    const { testAccountEmail, testAccountPassword } = await import(
        "../../src/dev/test-account"
    );
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};
