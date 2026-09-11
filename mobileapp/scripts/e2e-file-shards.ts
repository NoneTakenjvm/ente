/**
 * Playwright smoke: library loads and fileShards appear in IndexedDB.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/e2e-file-shards.ts
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
        // Allow bootstrap + sync + first library persist / migrate.
        await page.waitForTimeout(12_000);
        console.log("OK: signed in → gallery");

        await page.getByRole("link", { name: "Manage" }).click();
        await page.waitForURL(/\/manage/, { timeout: 60_000 });
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            const mainEl = document.querySelector("main");
            if (mainEl) {
                mainEl.scrollTop = mainEl.scrollHeight;
            }
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
        // Sync + debounce(1.5s) + shard encrypt.
        await page.waitForTimeout(15_000);

        const shardInfo = await page.evaluate(async () => {
            const databases = await indexedDB.databases();
            const organizer = databases.find((db) =>
                (db.name ?? "").startsWith("ente-organizer-"),
            );
            if (!organizer?.name) {
                return { dbName: null as string | null, shardCount: 0, legacyFiles: false };
            }
            const dbName = organizer.name;
            return await new Promise<{
                dbName: string;
                shardCount: number;
                legacyFiles: boolean;
            }>((resolve, reject) => {
                const open = indexedDB.open(dbName);
                open.onerror = () => {
                    reject(open.error ?? new Error("idb open failed"));
                };
                open.onsuccess = () => {
                    const db = open.result;
                    const hasShards = db.objectStoreNames.contains("fileShards");
                    const storeNames = hasShards ? ["fileShards", "kv"] : ["kv"];
                    const tx = db.transaction(storeNames, "readonly");
                    let shardCount = 0;
                    let legacyFiles = false;
                    if (hasShards) {
                        const countReq = tx.objectStore("fileShards").count();
                        countReq.onsuccess = () => {
                            shardCount = countReq.result;
                        };
                    }
                    const kvReq = tx.objectStore("kv").get("files");
                    kvReq.onsuccess = () => {
                        legacyFiles = kvReq.result !== undefined;
                    };
                    tx.oncomplete = () => {
                        db.close();
                        resolve({ dbName, shardCount, legacyFiles });
                    };
                    tx.onerror = () => {
                        db.close();
                        reject(tx.error ?? new Error("idb tx failed"));
                    };
                };
            });
        });

        console.log("IDB shard info:", shardInfo);
        assert(shardInfo.dbName !== null, "Expected ente-organizer IndexedDB");
        assert(
            shardInfo.shardCount > 0,
            `Expected fileShards rows > 0, got ${shardInfo.shardCount}`,
        );
        assert(
            !shardInfo.legacyFiles,
            "Legacy kv files blob should be removed after shard migrate/save",
        );
        console.log(
            `OK: ${shardInfo.shardCount} fileShards, no monolith files key`,
        );

        console.log("File shards e2e smoke passed.");
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
