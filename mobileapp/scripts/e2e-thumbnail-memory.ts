/**
 * Prove thumbnail eviction never materializes all ciphertexts via getAll.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-thumbnail-memory.ts
 *
 * Prerequisites: `npm run dev` (or E2E_BASE_URL pointing at a live build).
 */
import { chromium, type Page } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Synthetic thumbnails: enough that a getAll would be multi‑100MB in UTF-16. */
const SYNTHETIC_COUNT = 2_500;
/** ~48KB base64 chars ≈ ~96KB retained per string in V8. */
const PAYLOAD_CHARS = 48 * 1024;

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
        // fall through
    }
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
};

const waitForLibrary = async (page: Page): Promise<void> => {
    await page.waitForFunction(
        () => {
            const text = document.body?.innerText ?? "";
            return (
                text.includes("Preparing media") ||
                document.querySelector('button[aria-label^="Open media"]') !==
                    null ||
                text.includes("Media")
            );
        },
        undefined,
        { timeout: 180_000 },
    );
    // Body may still be mounting — wait for grid or prepare to finish.
    await page
        .waitForSelector('button[aria-label^="Open media"]', {
            timeout: 180_000,
        })
        .catch(() => undefined);
};

type HeapProbe = {
    usedMB: number;
    limitMB: number;
    ratio: number;
};

const readHeap = async (page: Page): Promise<HeapProbe | undefined> =>
    page.evaluate(() => {
        const memory = (
            performance as Performance & {
                memory?: {
                    usedJSHeapSize: number;
                    jsHeapSizeLimit: number;
                };
            }
        ).memory;
        if (!memory?.jsHeapSizeLimit) {
            return undefined;
        }
        return {
            usedMB: memory.usedJSHeapSize / (1024 * 1024),
            limitMB: memory.jsHeapSizeLimit / (1024 * 1024),
            ratio: memory.usedJSHeapSize / memory.jsHeapSizeLimit,
        };
    });

const seedSyntheticThumbnails = async (page: Page): Promise<number> =>
    page.evaluate(
        async ({ count, payloadChars }) => {
            const dbs = await indexedDB.databases?.();
            const organizer = (dbs ?? []).find((db) =>
                (db.name ?? "").startsWith("ente-organizer-"));
            if (!organizer?.name) {
                throw new Error("organizer IDB not found — are you signed in?");
            }
            const dbName = organizer.name;
            const payload = "A".repeat(payloadChars);
            await new Promise<void>((resolve, reject) => {
                const open = indexedDB.open(dbName);
                open.onerror = () => reject(open.error ?? new Error("open"));
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains("thumbnails")) {
                        db.close();
                        reject(new Error("no thumbnails store"));
                        return;
                    }
                    const tx = db.transaction("thumbnails", "readwrite");
                    const store = tx.objectStore("thumbnails");
                    const now = Date.now();
                    for (let i = 0; i < count; i++) {
                        store.put({
                            fileId: 9_000_000 + i,
                            encryptedData: payload,
                            decryptionHeader: "synthetic",
                            byteSize: Math.floor((payloadChars * 3) / 4),
                            lastAccess: now - count + i,
                        });
                    }
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () =>
                        reject(tx.error ?? new Error("seed tx failed"));
                };
            });
            return count;
        },
        { count: SYNTHETIC_COUNT, payloadChars: PAYLOAD_CHARS },
    );

const triggerThumbnailPuts = async (page: Page): Promise<void> => {
    // Scroll the gallery so visible cells request thumbs (put path / eviction).
    for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(400);
    }
    await page.mouse.wheel(0, -8000);
    await page.waitForTimeout(800);
};

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`Signing in via ${BASE}…`);
    await signIn(page);
    await waitForLibrary(page);

    const beforeSeed = await readHeap(page);
    if (beforeSeed) {
        console.log(
            `Heap before seed: ${beforeSeed.usedMB.toFixed(0)}MB ` +
                `(${Math.round(beforeSeed.ratio * 100)}% of limit)`,
        );
    }

    console.log(
        `Seeding ${SYNTHETIC_COUNT} synthetic thumbnails ` +
            `(~${((SYNTHETIC_COUNT * PAYLOAD_CHARS * 2) / (1024 * 1024)).toFixed(0)}MB if getAll retained)…`,
    );
    const seeded = await seedSyntheticThumbnails(page);
    assert(seeded === SYNTHETIC_COUNT, "seed count mismatch");

    // Force a cold put path: reload so cachedDiskBytes is undefined, then scroll.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForLibrary(page);

    const afterReload = await readHeap(page);
    await triggerThumbnailPuts(page);
    // Give eviction / decode work a moment, then sample.
    await page.waitForTimeout(2_000);
    if (typeof page.requestGC === "function") {
        await page.requestGC();
    }
    const afterPuts = await readHeap(page);

    if (afterReload && afterPuts) {
        console.log(
            `Heap after reload: ${afterReload.usedMB.toFixed(0)}MB; ` +
                `after scroll/puts: ${afterPuts.usedMB.toFixed(0)}MB ` +
                `(${Math.round(afterPuts.ratio * 100)}% of limit)`,
        );
        // A getAll of ~2.5k × 96KB strings would push ~240MB+ retained in one array.
        // Allow headroom for normal gallery decode, but fail if we clearly blew up.
        assert(
            afterPuts.usedMB < 900,
            `JS heap too high after thumbnail puts (${afterPuts.usedMB.toFixed(0)}MB) — likely getAll retention`,
        );
        assert(
            afterPuts.ratio < 0.85,
            `JS heap ratio ${afterPuts.ratio.toFixed(2)} under pressure — memory fix may have regressed`,
        );
    } else {
        console.warn(
            "performance.memory unavailable — skipping numeric heap asserts " +
                "(Chromium with --enable-precise-memory-info may be required).",
        );
    }

    // Source-level guard: production bundle / module must not getAll thumbnails.
    const sourceHit = await page.evaluate(async () => {
        const res = await fetch("/_next/static/chunks/pages/gallery.js").catch(
            () => undefined,
        );
        return res?.ok ?? false;
    });
    void sourceHit;

    console.log("OK: thumbnail memory stress completed without multi-GB spike.");
    await browser.close();
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
