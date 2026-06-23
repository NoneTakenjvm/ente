/**
 * E2E: dev-login → gallery → tag picker keyboard/blur/+ button.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/debug-tag-picker.ts
 *
 * Requires `npm run dev` (dev-login is dev-only).
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.TAG_PICKER_TEST_URL ?? "http://127.0.0.1:3000";

const signIn = async (page: Page): Promise<void> => {
    await page.goto(`${BASE}/dev-login`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
    });
    const reachedGallery = await page
        .waitForURL(/\/gallery/, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
    if (reachedGallery) {
        return;
    }
    const body = await page.locator("body").innerText();
    console.log("dev-login did not redirect, body:", body.slice(0, 300));
    console.log("Falling back to /login form …");
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const waitForGalleryReady = async (page: Page): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 180_000) {
        const thumbs = page.locator('button[aria-label^="Open media"]');
        if ((await thumbs.count()) > 0) {
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error("Gallery thumbnails did not appear");
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log("browser error:", msg.text());
        }
    });

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    console.log("Logged in, waiting for gallery …");
    await waitForGalleryReady(page);

    const firstThumb = page.locator('button[aria-label^="Open media"]').first();
    await firstThumb.waitFor({ state: "visible", timeout: 120_000 });
    await firstThumb.click({ force: true });
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("dialog").click({ position: { x: 195, y: 300 } });
    await page.waitForTimeout(500);

    const tagsButton = page
        .getByRole("dialog")
        .getByRole("button", { name: "Tags", exact: true });
    await tagsButton.waitFor({ state: "visible", timeout: 30_000 });
    await tagsButton.evaluate((el) => {
        (el as HTMLButtonElement).click();
    });
    await page.waitForTimeout(1000);

    const tagInput = page.getByPlaceholder("Create new tag");
    await tagInput.waitFor({ state: "visible", timeout: 30_000 });
    const testTag = `dbg-${Date.now()}`;
    await tagInput.fill(testTag);
    console.log("Filled tag input:", testTag);

    // Simulate keyboard open (shorter viewport) then close (full height).
    await page.setViewportSize({ width: 390, height: 480 });
    await page.waitForTimeout(400);
    await page.locator('[data-slot="sheet-title"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    const plusButton = page.getByRole("button", { name: "Create tag" });
    const plusBox = await plusButton.boundingBox();
    if (!plusBox) {
        throw new Error("Plus button not found");
    }
    const centerX = plusBox.x + plusBox.width / 2;
    const centerY = plusBox.y + plusBox.height / 2;
    console.log("Plus button box:", plusBox);

    const hitBeforeClick = await page.evaluate(
        ({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return {
                tag: el?.tagName,
                aria: el?.getAttribute("aria-label"),
                text: el?.textContent?.slice(0, 40),
            };
        },
        { x: centerX, y: centerY },
    );
    console.log("elementFromPoint at plus center:", hitBeforeClick);

    await page.mouse.click(centerX, centerY);
    await page.waitForTimeout(800);

    const tagVisible = await page.getByText(testTag, { exact: true }).count();
    console.log("Tag visible in sheet after + click:", tagVisible > 0);

    const misclickY = centerY - 96;
    const hitMisaligned = await page.evaluate(
        ({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return {
                tag: el?.tagName,
                aria: el?.getAttribute("aria-label"),
                text: el?.textContent?.slice(0, 40),
            };
        },
        { x: centerX, y: misclickY },
    );
    console.log("elementFromPoint 96px above plus:", hitMisaligned);

    await browser.close();

    if (!tagVisible) {
        console.error("FAIL: tag was not created after + click");
        process.exit(1);
    }
    console.log("PASS: tag created successfully");
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
