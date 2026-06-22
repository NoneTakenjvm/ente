/**
 * Browser E2E: login → manage compress → read preview size delta.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/test-compress-ui.ts
 *
 * Set COMPRESS_TEST_URL (default http://127.0.0.1:3090) to your preview/dev server.
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.COMPRESS_TEST_URL ?? "http://127.0.0.1:3090";

const waitForText = async (
    page: Page,
    pattern: RegExp,
    timeoutMs = 180_000,
): Promise<string> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const body = await page.locator("body").innerText();
        const match = body.match(pattern);
        if (match) {
            return match[0];
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`Timed out waiting for ${pattern}`);
};

const signIn = async (page: Page): Promise<void> => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log("browser error:", msg.text());
        }
    });

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    console.log("Logged in.");
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
    await page.waitForTimeout(8000);

    await page.getByRole("link", { name: "Manage" }).click();
    await page.waitForURL(/\/manage/, { timeout: 60_000 });
    await page.waitForTimeout(5000);
    console.log("Manage URL:", page.url());

    const compressTab = page.getByRole("tab", { name: "Compress" });
    if (!(await compressTab.count())) {
        throw new Error("Compress tab not found on manage page");
    }
    await compressTab.click();
    await page.waitForTimeout(8000);

    const firstThumb = page.locator('button[aria-label^="Select media"]').first();
    await firstThumb.waitFor({ state: "visible", timeout: 120_000 });
    await firstThumb.click();
    await page.waitForTimeout(500);

    await page.getByRole("button", { name: "Compress selected" }).click();

    try {
        await page.waitForSelector("text=Before", { timeout: 180_000 });
    } catch {
        const body = await page.locator("body").innerText();
        console.log("Page at timeout:", body.slice(0, 800));
        throw new Error("Compression preview did not show Before/After panel");
    }

    const sizeLine = await waitForText(
        page,
        /Saves .+|Compressed output is larger — replace is disabled\./,
        180_000,
    );
    console.log("Preview result:", sizeLine);

    const body = await page.locator("body").innerText();
    const beforeMatch = body.match(/Before[\s\S]*?(\d+ KB|\d+\.\d MB|\d+ B)/);
    const afterMatch = body.match(/After[\s\S]*?(\d+ KB|\d+\.\d MB|\d+ B)/);
    if (beforeMatch && afterMatch) {
        console.log(`Before: ${beforeMatch[1]}`);
        console.log(`After:  ${afterMatch[1]}`);
    }

    const disabled = await page
        .getByRole("button", { name: "Compress and replace" })
        .isDisabled();
    console.log(`Replace disabled: ${disabled}`);

    await browser.close();
};

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
