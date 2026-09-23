/**
 * Probe auth + upload-urls after login (diagnoses HTTP 410 etc).
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/probe-upload-api.ts
 */
import { chromium } from "playwright";
import {
    testAccountEmail,
    testAccountPassword,
} from "../src/dev/test-account";

const BASE = process.env.UPLOAD_SMOKE_URL ?? "http://localhost:3001";

const main = async (): Promise<void> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    let capturedToken: string | undefined;
    page.on("request", (req) => {
        if (!req.url().includes("api.ente.com")) {
            return;
        }
        const t = req.headers()["x-auth-token"];
        if (t && t.length > 20) {
            capturedToken = t;
        }
    });

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(testAccountEmail);
    await page.getByLabel("Password").fill(testAccountPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/gallery/, { timeout: 180_000 });
    // Wait until sync fires so we capture the token.
    await page.waitForTimeout(5000);

    if (!capturedToken) {
        throw new Error("Could not capture X-Auth-Token from gallery requests");
    }
    console.log("tokenLen", capturedToken.length);

    const headers = { "X-Auth-Token": capturedToken };
    const hit = async (path: string) => {
        const res = await fetch(`https://api.ente.com${path}`, { headers });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 800) };
    };

    const details = await hit("/users/details/v2");
    const uploadUrls = await hit(
        `/files/upload-urls?count=2&ts=${Date.now()}`,
    );
    // Empty-file MD5 (d41d8cd98f00b204e9800998ecf8427e) as base64.
    const emptyMd5 = "1B2M2Y8AsgTpgAmY7PhCfg==";
    const uploadUrlPost = await fetch(
        `https://api.ente.com/files/upload-url?ts=${Date.now()}`,
        {
            method: "POST",
            headers: {
                "X-Auth-Token": capturedToken,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                contentLength: 100,
                contentMD5: emptyMd5,
            }),
        },
    );
    const uploadUrlPostBody = (await uploadUrlPost.text()).slice(0, 400);
    console.log(
        JSON.stringify(
            {
                details,
                uploadUrls,
                uploadUrlPost: {
                    status: uploadUrlPost.status,
                    body: uploadUrlPostBody,
                },
            },
            null,
            2,
        ),
    );

    await browser.close();
};

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
