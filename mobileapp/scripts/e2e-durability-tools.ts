/**
 * Playwright smoke for durability/tools chrome (real login).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-durability-tools.ts
 *
 * Expects `npm run dev` on :3000 (or E2E_BASE_URL).
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";
import { APP_VERSION } from "../src/lib/app-version";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
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
    page.setViewportSize({ width: 390, height: 844 });

    try {
        console.log(`Signing in at ${BASE} …`);
        await signIn(page);
        await page.waitForTimeout(3000);
        console.log("OK: signed in → gallery");

        await page.getByRole("link", { name: "Manage" }).click();
        await page.waitForURL(/\/manage/, { timeout: 60_000 });
        await page.waitForTimeout(2000);
        // Version footer sits at the bottom of the hub scroll area.
        await page.evaluate(() => {
            const main = document.querySelector("main");
            if (main) {
                main.scrollTop = main.scrollHeight;
            }
            window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(500);
        const bodyText = await page.locator("body").innerText();
        assert(
            bodyText.includes(APP_VERSION),
            `Expected APP_VERSION ${APP_VERSION} on Manage`,
        );
        console.log(`OK: Manage shows ${APP_VERSION}`);

        await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
        await page.waitForURL(/\/gallery/, { timeout: 60_000 });
        await page.waitForTimeout(2000);

        // Mobile tools: wrench opens menu (force past nextjs-portal overlays in dev)
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
        assert(
            !(await nav.isVisible()),
            "Bottom nav should hide while Select active",
        );
        console.log("OK: bottom nav hidden in Select");

        await done.click();
        await nav.waitFor({ state: "visible", timeout: 15_000 });
        console.log("OK: Done exits Select and restores nav");

        // Stamp collapsed
        const toolsAgain = page.getByRole("button", {
            name: /gallery tools|tools/i,
        });
        if (await toolsAgain.count()) {
            await toolsAgain.first().click();
            await page.getByRole("menuitem", { name: /stamp/i }).click();
            const expand = page.getByRole("button", {
                name: /expand stamp|show kits|expand/i,
            });
            const closeStamp = page.getByRole("button", { name: /^close$/i });
            await closeStamp.waitFor({ timeout: 10_000 });
            console.log("OK: Stamp footer visible (collapsed or expanded)");
            if (await expand.count()) {
                console.log("OK: Stamp expand control present");
            }
            await closeStamp.click();
            await nav.waitFor({ state: "visible", timeout: 10_000 });
            console.log("OK: Stamp Close restores nav");
        }

        await page.evaluate(() => {
            window.dispatchEvent(new Event("pagehide"));
        });
        console.log("OK: pagehide did not crash");

        console.log("Durability/tools e2e smoke passed.");
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
