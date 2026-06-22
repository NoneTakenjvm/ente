/**
 * Open crop editor on first croppable photo. Run while `npm run dev` is up:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/debug-crop-editor.ts
 */
import { chromium } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const baseUrl = process.env.DEBUG_LOGIN_URL ?? "http://localhost:3000/login";

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setViewportSize({ width: 390, height: 844 });

    console.log("Opening", baseUrl, "…");
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 120_000 });
    await page.fill('input[type="email"]', testAccountEmail);
    await page.fill('input[type="password"]', testAccountPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/gallery**", { timeout: 180_000 });

    await page.waitForURL("**/gallery**", { timeout: 180_000 });
    await page.locator('main img[alt=""]').first().waitFor({
        timeout: 180_000,
    });
    await page.waitForTimeout(3000);

    const thumbs = page.locator('main img[alt=""]');
    const thumbCount = await thumbs.count();
    console.log("Thumbnail count:", thumbCount);

    let opened = false;
    for (let i = 0; i < Math.min(thumbCount, 20); i++) {
        await thumbs.nth(i).click();
        await page.waitForTimeout(2500);
        const cropBtn = page.getByRole("button", { name: "Crop image" });
        if (!(await cropBtn.isVisible())) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(500);
            continue;
        }
        await page.evaluate(() => {
            document.querySelector('[aria-label="Crop image"]')?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
            );
        });
        await page.waitForSelector(".ReactCrop", { timeout: 30_000 });
        await page.waitForFunction(() => {
            const img = document.querySelector(".ReactCrop img") as HTMLImageElement | null;
            return img && img.complete && img.naturalWidth > 200;
        }, { timeout: 120_000 }).catch(() => undefined);
        await page.waitForTimeout(2000);

        const dims = await page.evaluate(() => {
            const img = document.querySelector(".ReactCrop img") as HTMLImageElement | null;
            if (!img) {
                return { error: "no img" };
            }
            const imgRect = img.getBoundingClientRect();
            const selection = document.querySelector(".ReactCrop__crop-selection");
            const selRect = selection?.getBoundingClientRect();
            const reactCrop = document.querySelector(".ReactCrop");
            const rcRect = reactCrop?.getBoundingClientRect();
            return {
                width: img.width,
                height: img.height,
                clientWidth: img.clientWidth,
                clientHeight: img.clientHeight,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                imgRectW: imgRect.width,
                imgRectH: imgRect.height,
                selectionW: selRect?.width,
                selectionH: selRect?.height,
                reactCropW: rcRect?.width,
                reactCropH: rcRect?.height,
                selectionOverflow:
                    selRect && imgRect ?
                        selRect.width > imgRect.width + 2 ||
                        selRect.height > imgRect.height + 2 :
                        false,
            };
        });
        console.log(`Photo index ${i}:`, JSON.stringify(dims, null, 2));

        if (dims.naturalWidth && dims.naturalWidth >= 800) {
            opened = true;
            if (dims.selectionOverflow) {
                console.log("MISMATCH DETECTED on large photo");
            }
            const rotateBtn = page.getByRole("button", { name: "Rotate right" });
            await rotateBtn.click({ force: true });
            await page.waitForTimeout(4000);
            const afterRotate = await page.evaluate(() => {
                const img = document.querySelector(".ReactCrop img") as HTMLImageElement | null;
                const alert = document.querySelector('[role="alert"]');
                return {
                    naturalWidth: img?.naturalWidth,
                    naturalHeight: img?.naturalHeight,
                    clientWidth: img?.clientWidth,
                    clientHeight: img?.clientHeight,
                    error: alert?.textContent,
                };
            });
            console.log("After rotate:", JSON.stringify(afterRotate, null, 2));
            break;
        }

        await page.getByRole("button", { name: "Cancel" }).click();
        await page.waitForTimeout(500);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
    }

    if (!opened) {
        console.log("No large photo found in first 20 thumbnails");
    }

    await browser.close();
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
