/**
 * Playwright smoke for compress follow-up UI (filters, footer, no CRF, size chips).
 *
 * Prerequisites: app running (`npm run dev`).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-compress-followup.ts
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
        // fall through to form login
    }
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const openCompress = async (page: Page): Promise<void> => {
    await page.getByRole("link", { name: "Manage" }).click();
    await page.waitForURL(/\/manage/, { timeout: 60_000 });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: /Tools/i }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /Compress/i }).first().click();
    await page.waitForTimeout(2500);
    await page.getByText(/Minimum file size/i).waitFor({ timeout: 60_000 });
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setViewportSize({ width: 390, height: 844 });

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    await page.waitForTimeout(3000);
    await openCompress(page);

    assert(
        (await page.getByRole("button", { name: /Settings/i }).count()) === 0,
        "CRF Settings button should be gone",
    );
    assert(
        (await page.getByText(/Video CRF/i).count()) === 0,
        "Video CRF label should be gone",
    );
    console.log("OK: CRF settings removed");

    assert(
        (await page.getByRole("button", { name: /^Tags$|^[0-9]+ tags$/i }).count()) > 0 ||
            (await page.getByRole("button", { name: /Edit tag query/i }).count()) > 0 ||
            (await page.getByRole("button", { name: /Options/i }).count()) > 0,
        "Filter controls missing on Compress",
    );
    assert(
        (await page.getByRole("button", { name: /Randomise/i }).count()) === 0,
        "Randomise should not appear on Compress",
    );
    console.log("OK: filter-only chrome");

    assert(
        (await page.getByText(/Minimum file size/i).count()) > 0,
        "Minimum file size control missing",
    );
    assert(
        (await page.getByRole("button", {
            name: /Skip compressed|Including compressed/i,
        }).count()) > 0,
        "Skip compressed toggle missing",
    );
    console.log("OK: skip + min-size kept");

    const selectBtn = page.getByRole("button", { name: /^Select media / });
    if ((await selectBtn.count()) > 0) {
        await selectBtn.first().click();
        await page.waitForTimeout(400);
        const footerText = await page.locator("footer").innerText();
        assert(
            /photo|video/i.test(footerText),
            `Footer should show photo/video counts, got: ${footerText}`,
        );
        console.log("OK: selection footer mix");
    } else {
        console.log("SKIP: no compressible thumbs to select");
    }

    const sizeChip = page.locator("span").filter({
        hasText: /^\d+(\.\d+)?\s*(B|KB|MB)$/,
    });
    if ((await sizeChip.count()) > 0) {
        console.log("OK: size overlay chips present");
    } else {
        console.log("SKIP: no size chips visible (sizes may be unknown)");
    }

    await browser.close();
    console.log("Compress follow-up e2e smoke passed.");
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
