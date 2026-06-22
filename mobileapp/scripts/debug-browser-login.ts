/**
 * Browser E2E: login form → gallery. Run while `npm run dev` is up:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/debug-browser-login.ts
 */
import { chromium } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const baseUrl = process.env.DEBUG_LOGIN_URL ?? "http://localhost:3001/login";

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            errors.push(msg.text());
        }
    });

    console.log("Opening", baseUrl, "…");
    await page.goto(baseUrl, {
        waitUntil: "networkidle",
        timeout: 120_000,
    });

    await page.fill('input[type="email"]', testAccountEmail);
    await page.fill('input[type="password"]', testAccountPassword);
    await page.click('button[type="submit"]');

    await page.waitForURL("**/gallery**", { timeout: 180_000 }).catch(() => {
        console.log("Still on:", page.url());
    });

    await page.waitForTimeout(3000);

    console.log("Final URL:", page.url());
    const bodyText = await page.innerText("body");
    console.log("Page text snippet:", bodyText.slice(0, 300));
    const depthError = errors.some((e) => e.includes("Maximum update depth"));
    console.log("Max depth error:", depthError);
    console.log("JS errors:", errors.length ? errors.slice(0, 5) : "none");

    await browser.close();
    if (!page.url().includes("/gallery") || depthError) {
        process.exit(1);
    }
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
