/**
 * Playwright smoke for organizer CLIP mldata sync.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-organizer-clip.ts
 *
 * Expects `npm run dev` on :3000 (or E2E_BASE_URL).
 */
import { chromium, type Page, type Request } from "playwright";
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

    const mldataRequests: string[] = [];
    page.on("request", (request: Request) => {
        const url = request.url();
        if (url.includes("/files/data")) {
            mldataRequests.push(`${request.method()} ${url}`);
        }
    });

    try {
        console.log(`Signing in at ${BASE} …`);
        await signIn(page);
        await page.waitForTimeout(5000);
        console.log("OK: signed in → gallery");

        await page.getByRole("link", { name: "Manage" }).click();
        await page.waitForURL(/\/manage/, { timeout: 60_000 });
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            const mainEl = document.querySelector("main");
            if (mainEl) {
                mainEl.scrollTop = mainEl.scrollHeight;
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

        // Stay on gallery long enough for post-sync CLIP pull/backfill network.
        await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(12_000);

        const sawStatusDiff = mldataRequests.some((line) =>
            line.includes("status-diff"),
        );
        const sawFetchOrPut = mldataRequests.some(
            (line) =>
                line.includes("/files/data/fetch") ||
                line.startsWith("PUT ") ||
                line.includes("/files/data\""),
        );

        console.log(
            `mldata traffic (${mldataRequests.length}):`,
            mldataRequests.slice(0, 12).join("\n  "),
        );

        // Fresh accounts may have no mldata yet — status-diff alone proves the
        // pull path ran after library sync.
        assert(
            sawStatusDiff || sawFetchOrPut || mldataRequests.length > 0,
            "Expected at least one /files/data request after sync (CLIP pull)",
        );
        console.log("OK: organizer CLIP mldata sync path hit museum");

        console.log("Organizer CLIP e2e smoke passed.");
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
