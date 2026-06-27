/**
 * Profile mobileapp upload pipeline phases in a real Chromium session.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/benchmark-upload-pipeline.ts
 *
 * Requires ffmpeg on PATH for fixture generation. Serves harness via static HTTP.
 */
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, "fixtures");
const BUNDLE_PATH = join(SCRIPT_DIR, ".benchmark-upload-harness.mjs");
const HARNESS_SRC = join(SCRIPT_DIR, "benchmark-upload-harness.ts");
const LOG_PATH = join(SCRIPT_DIR, "..", "..", "debug-b43bb4.log");

const tinyMp4 = join(FIXTURES_DIR, "bench-tiny.mp4");
const mediumMp4 = join(FIXTURES_DIR, "bench-medium.mp4");
const movFixture = join(FIXTURES_DIR, "bench-tiny.mov");
const jpegFixture = join(FIXTURES_DIR, "bench-photo.jpg");

const ensureFixtures = (): void => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    if (!existsSync(tinyMp4)) {
        console.log("Generating tiny MP4 (2s, 320x240)…");
        execSync(
            `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=24:duration=2 -f lavfi -i sine=frequency=440:duration=2 -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 30 -c:a aac -shortest -movflags +faststart "${tinyMp4}"`,
            { stdio: "inherit" },
        );
    }
    if (!existsSync(mediumMp4)) {
        console.log("Generating medium MP4 (~8s, 1280x720)…");
        execSync(
            `ffmpeg -y -f lavfi -i testsrc=size=1280x720:rate=30:duration=8 -f lavfi -i sine=frequency=440:duration=8 -pix_fmt yuv420p -c:v libx264 -preset fast -crf 23 -c:a aac -shortest -movflags +faststart "${mediumMp4}"`,
            { stdio: "inherit" },
        );
    }
    if (!existsSync(movFixture)) {
        console.log("Generating MOV (same content as tiny, triggers transcode path)…");
        execSync(
            `ffmpeg -y -i "${tinyMp4}" -c copy "${movFixture}"`,
            { stdio: "inherit" },
        );
    }
    if (!existsSync(jpegFixture)) {
        console.log("Generating JPEG fixture…");
        execSync(
            `ffmpeg -y -f lavfi -i testsrc=size=4032x3024:rate=1:duration=1 -frames:v 1 -q:v 2 "${jpegFixture}"`,
            { stdio: "inherit" },
        );
    }
};

const bundleHarness = (): void => {
    const aliasAt = join(SCRIPT_DIR, "..", "src");
    execSync(
        `npx esbuild "${HARNESS_SRC}" --bundle --format=esm --platform=browser --target=es2022 --outfile="${BUNDLE_PATH}" --alias:@="${aliasAt}"`,
        { stdio: "inherit", cwd: join(SCRIPT_DIR, "..") },
    );
};

const serveDir = (port: number): Promise<{ close: () => void }> =>
    new Promise((resolve) => {
        const server = createServer((req, res) => {
            const url = req.url ?? "/";
            if (url === "/" || url === "/index.html") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>bench</title></head>
<body><script>globalThis.process={env:{NODE_ENV:"production"}};</script>
<script type="module" src="/harness.mjs"></script></body></html>`);
                return;
            }
            if (url === "/harness.mjs") {
                res.writeHead(200, { "Content-Type": "text/javascript" });
                res.end(readFileSync(BUNDLE_PATH));
                return;
            }
            const name = decodeURIComponent(url.slice(1));
            const path = join(FIXTURES_DIR, name);
            if (!path.startsWith(FIXTURES_DIR) || !existsSync(path)) {
                res.writeHead(404);
                res.end();
                return;
            }
            const data = readFileSync(path);
            const type = name.endsWith(".mp4") ? "video/mp4" :
                name.endsWith(".mov") ? "video/quicktime" : "image/jpeg";
            res.writeHead(200, { "Content-Type": type });
            res.end(data);
        });
        server.listen(port, "127.0.0.1", () => {
            resolve({
                close: () => server.close(),
            });
        });
    });

interface BenchResult {
    label: string;
    fileSize: number;
    phases: { phase: string; ms: number; bytes?: number }[];
    totalMs: number;
}

const runCase = async (
    page: import("playwright").Page,
    baseUrl: string,
    label: string,
    fileName: string,
    mimeType: string,
    kind: "video" | "image",
): Promise<BenchResult> => {
    const filePath = join(FIXTURES_DIR, fileName);
    const fileSize = readFileSync(filePath).length;

    console.log(`Benchmarking: ${label}…`);

    const phases = await page.evaluate(
        async ({ baseUrl, fileName, mimeType, kind }) => {
            const { benchmarkVideoUpload, benchmarkImageUpload } =
                await import(`${baseUrl}/harness.mjs`);
            const res = await fetch(`${baseUrl}/${fileName}`);
            const blob = await res.blob();
            const file = new File([blob], fileName, { type: mimeType });
            return kind === "video" ?
                benchmarkVideoUpload(file) :
                benchmarkImageUpload(file);
        },
        { baseUrl, fileName, mimeType, kind },
    );

    const totalMs = phases.reduce((sum, p) => sum + p.ms, 0);
    return { label, fileSize, phases, totalMs };
};

const formatKb = (n: number): string => `${Math.round(n / 1024)} KB`;

const printResult = (result: BenchResult): void => {
    console.log(`\n=== ${result.label} (${formatKb(result.fileSize)}) ===`);
    for (const phase of result.phases) {
        const pct = ((phase.ms / result.totalMs) * 100).toFixed(0);
        console.log(`  ${phase.phase.padEnd(28)} ${phase.ms.toFixed(0).padStart(6)} ms  (${pct}%)`);
    }
    console.log(`  ${"TOTAL (pre-network)".padEnd(28)} ${result.totalMs.toFixed(0).padStart(6)} ms`);
};

const appendLog = (payload: Record<string, unknown>): void => {
    const line = JSON.stringify({
        sessionId: "b43bb4",
        timestamp: Date.now(),
        location: "benchmark-upload-pipeline.ts",
        ...payload,
    });
    writeFileSync(LOG_PATH, `${line}\n`, { flag: "a" });
};

const main = async (): Promise<void> => {
    ensureFixtures();
    bundleHarness();

    const port = 9876 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = await serveDir(port);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    page.on("console", (msg) => {
        if (msg.text().startsWith("[bench]")) {
            console.log(msg.text());
        }
    });
    page.setDefaultTimeout(600_000);

    try {
        await page.goto(`${baseUrl}/`, { waitUntil: "load", timeout: 120_000 });

        const cases: BenchResult[] = [];
        cases.push(await runCase(page, baseUrl, "Tiny MP4 (no transcode)", "bench-tiny.mp4", "video/mp4", "video"));
        if (process.env.BENCH_FULL === "1") {
            cases.push(await runCase(page, baseUrl, "Medium MP4 (no transcode)", "bench-medium.mp4", "video/mp4", "video"));
            cases.push(await runCase(page, baseUrl, "MOV → FFmpeg transcode", "bench-tiny.mov", "video/quicktime", "video"));
            cases.push(await runCase(page, baseUrl, "JPEG re-encode on upload", "bench-photo.jpg", "image/jpeg", "image"));
        }

        for (const result of cases) {
            printResult(result);
            appendLog({
                message: "upload-benchmark",
                hypothesisId: "perf",
                data: result,
            });
        }

        console.log("\n--- Comparison notes (Ente official) ---");
        console.log("Ente: streams file → chunked encrypt in worker → multipart S3 PUT");
        console.log("Ente: video metadata via ffmpeg -c copy (no re-encode)");
        console.log("Ente: prefetches upload URLs in batch");
        console.log("mobileapp: full arrayBuffer + sequential phases before any network");
    } finally {
        await context.close();
        await browser.close();
        server.close();
    }
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
