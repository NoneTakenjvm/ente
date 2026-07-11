/**
 * Playwright unit-style checks that do not need a logged-in Ente session:
 * crop CSS hitbox rules, site wipe helpers via page.evaluate.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-local-helpers.ts
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

const main = async (): Promise<void> => {
    const cssPath = resolve("src/styles/globals.css");
    const css = readFileSync(cssPath, "utf8");
    assert(
        css.includes(".ReactCrop__drag-handle::after"),
        "Expected enlarged crop handle hitbox CSS",
    );
    assert(css.includes("44px"), "Expected 44px touch target for crop handles");
    console.log("OK: crop handle CSS present");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Real http origin so localStorage is available (blocked on about:blank).
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    // Use a string script to avoid tsx injecting __name into the browser context.
    await page.evaluate(`(() => {
        localStorage.setItem("ntphotos-session", "1");
        localStorage.setItem("mobileapp-video-volume", "1");
        localStorage.setItem("keep-me", "1");
        sessionStorage.setItem("ntphotos-locked", "1");
        const prefixes = ["ntphotos-", "mobileapp-"];
        const clear = (storage) => {
            const keys = [];
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key && prefixes.some((p) => key.startsWith(p))) {
                    keys.push(key);
                }
            }
            keys.forEach((k) => storage.removeItem(k));
        };
        clear(localStorage);
        clear(sessionStorage);
    })()`);
    const result = await page.evaluate(`(() => ({
        session: localStorage.getItem("ntphotos-session"),
        volume: localStorage.getItem("mobileapp-video-volume"),
        keep: localStorage.getItem("keep-me"),
        locked: sessionStorage.getItem("ntphotos-locked"),
    }))()`) as {
        session: string | null;
        volume: string | null;
        keep: string | null;
        locked: string | null;
    };
    assert(result.session === null, "session key should be wiped");
    assert(result.volume === null, "volume key should be wiped");
    assert(result.keep === "1", "unrelated key should remain");
    assert(result.locked === null, "lock flag should be wiped");
    console.log("OK: storage prefix wipe probe");

    await browser.close();
    console.log("Local helper e2e checks passed.");
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
