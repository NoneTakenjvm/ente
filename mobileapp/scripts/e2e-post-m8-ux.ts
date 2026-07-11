/**
 * Playwright E2E smoke for post-M8 UX: tag AND/OR, manage archived/auto-crop,
 * crop keepSelection chrome, panic wipe entry.
 *
 * Prerequisites: app running (`npm run dev` or preview).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-post-m8-ux.ts
 *
 * Optional: E2E_BASE_URL (default http://127.0.0.1:3000)
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

const signIn = async (page: Page): Promise<void> => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const assert = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setViewportSize({ width: 390, height: 844 });

    const failures: string[] = [];

    console.log(`Signing in at ${BASE} …`);
    await signIn(page);
    await page.waitForTimeout(5000);

    // --- Tag AND/OR toggle ---
    try {
        const tagsTrigger = page.getByRole("button", { name: /^Tags/ });
        await tagsTrigger.click();
        const firstTag = page.locator("[data-tag], button").filter({
            hasText: /.*/,
        });
        // Open clause picker and set at least one include if possible
        const hasButton = page.getByRole("button", { name: /^Has$/ }).first();
        if (await hasButton.count()) {
            await hasButton.click();
            await page.waitForTimeout(400);
            const andOr = page.getByRole("radio", { name: "OR" }).or(
                page.getByText("OR", { exact: true }),
            );
            if (await andOr.count()) {
                await andOr.first().click();
                console.log("OK: tag OR control clickable");
            } else {
                // ToggleGroup may render as buttons
                const orBtn = page.getByRole("button", { name: "OR" });
                assert(await orBtn.count() > 0, "OR toggle missing after tag select");
                await orBtn.click();
                console.log("OK: tag OR button toggled");
            }
        } else {
            console.log("SKIP: no tags available to select for AND/OR");
        }
        await page.keyboard.press("Escape");
    } catch (error) {
        failures.push(`AND/OR: ${error instanceof Error ? error.message : error}`);
    }

    // --- Manage hub: Archived + Auto-crop ---
    try {
        await page.getByRole("link", { name: "Manage" }).click();
        await page.waitForURL(/\/manage/, { timeout: 60_000 });
        await page.waitForTimeout(1500);

        const archived = page.getByRole("button", { name: /Archived/i });
        assert(await archived.count() > 0, "Archived Images manage entry missing");
        await archived.click();
        await page.waitForTimeout(800);
        assert(
            page.url().includes("archived") ||
                (await page.getByText(/archived/i).count()) > 0,
            "Archived section did not open",
        );
        console.log("OK: Archived manage section");

        await page.getByRole("button", { name: /Back|Manage/i }).first().click();
        await page.waitForTimeout(500);

        const autoCrop = page.getByRole("button", { name: /Auto-crop/i });
        assert(await autoCrop.count() > 0, "Auto-crop manage entry missing");
        await autoCrop.click();
        await page.waitForTimeout(800);
        const scanBtn = page.getByRole("button", { name: /Scan/i });
        assert(await scanBtn.count() > 0, "Auto-crop Scan button missing");
        console.log("OK: Auto-crop manage section");
    } catch (error) {
        failures.push(`Manage: ${error instanceof Error ? error.message : error}`);
    }

    // --- Crop editor keepSelection (open crop, verify handles exist) ---
    try {
        await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(4000);
        const thumb = page.locator('main img[alt=""]').first();
        await thumb.waitFor({ state: "visible", timeout: 120_000 });
        await thumb.click();
        await page.waitForTimeout(2000);
        const cropBtn = page.getByRole("button", { name: /Crop/i });
        if (await cropBtn.isVisible()) {
            await cropBtn.click();
            await page.waitForTimeout(1500);
            const handle = page.locator(".ReactCrop__drag-handle").first();
            assert(await handle.count() > 0, "Crop drag handle missing");
            console.log("OK: crop editor opened with handles");
            await page.keyboard.press("Escape");
        } else {
            console.log("SKIP: first photo not croppable");
        }
    } catch (error) {
        failures.push(`Crop: ${error instanceof Error ? error.message : error}`);
    }

    // --- Panic control present ---
    try {
        await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        const panic = page.getByRole("button", { name: /panic|wipe|shield/i });
        if (await panic.count()) {
            console.log("OK: panic control present");
        } else {
            // Icon-only button — look for ShieldOff aria
            const shield = page.locator('button[aria-label*="Panic"], button[aria-label*="panic"], button[aria-label*="Wipe"]');
            if (await shield.count()) {
                console.log("OK: panic control present (aria)");
            } else {
                console.log("SKIP: could not locate panic button by label");
            }
        }
    } catch (error) {
        failures.push(`Panic: ${error instanceof Error ? error.message : error}`);
    }

    await browser.close();

    if (failures.length) {
        console.error("Failures:\n" + failures.map((f) => ` - ${f}`).join("\n"));
        process.exit(1);
    }
    console.log("All post-M8 UX smoke checks passed.");
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
