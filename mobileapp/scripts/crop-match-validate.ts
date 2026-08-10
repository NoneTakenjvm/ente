/**
 * Validation: run the real src/lib/crop-match implementation against the same
 * real-photo rotate-then-crop fixtures as the benchmark, to confirm the
 * shipped numbers (rotation-aware ~19/32 recall, 0/28 cross-photo FP).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/crop-match-validate.ts
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
    areCropMatches,
    colorHashFromImageData,
    decodeLuminanceGrid,
    encodeLuminanceGrid,
    luminanceGridFromImageData,
    templateMatchScore,
} from "../src/lib/crop-match";

const outDir = join(process.cwd(), ".spike-out");
mkdirSync(outDir, { recursive: true });
const G = 48;

const downloadPhoto = (seed: string): Buffer => {
    const tmp = join(outDir, `_dl-${seed}.jpg`);
    if (!existsSync(tmp)) {
        execFileSync(
            "curl",
            ["-sS", "-L", "-o", tmp, `https://picsum.photos/seed/${seed}/1024/768.jpg`],
            { stdio: "pipe" },
        );
    }
    return readFileSync(tmp);
};

/** Render an image to GxG and return { grid (encoded), color, rgba } via the
 * real luminanceGridFromImageData / colorHashFromImageData. */
const signatureOfImage = async (
    bytes: Buffer,
): Promise<{ grid: string; color: string }> => {
    const img = await loadImage(bytes);
    const small = createCanvas(G, G);
    const ctx = small.getContext("2d");
    ctx.drawImage(img as never, 0, 0, G, G);
    const imageData = ctx.getImageData(0, 0, G, G);
    const grid = luminanceGridFromImageData(imageData.data, G, G);
    return {
        grid: encodeLuminanceGrid(grid),
        color: colorHashFromImageData(imageData.data, G, G),
    };
};

/** Grid-space helpers mirroring the benchmark's corrected fixture. */
type Grid = Float32Array;
const rot90Grid = (g: Grid): Grid => {
    const r = new Float32Array(G * G);
    for (let i = 0; i < G; i++) {
        for (let j = 0; j < G; j++) {
            r[j * G + (G - 1 - i)] = g[i * G + j]!;
        }
    }
    return r;
};
const mirrorHGrid = (g: Grid): Grid => {
    const r = new Float32Array(G * G);
    for (let i = 0; i < G; i++) {
        for (let j = 0; j < G; j++) {
            r[i * G + (G - 1 - j)] = g[i * G + j]!;
        }
    }
    return r;
};
const center60ScaleUp = (g: Grid): Grid => {
    const out = new Float32Array(G * G);
    const x0 = Math.floor(G * 0.2);
    const y0 = Math.floor(G * 0.2);
    const w = Math.floor(G * 0.6);
    const h = Math.floor(G * 0.6);
    for (let i = 0; i < G; i++) {
        for (let j = 0; j < G; j++) {
            const px = x0 + Math.min(w - 1, Math.floor((i * w) / G));
            const py = y0 + Math.min(h - 1, Math.floor((j * h) / G));
            out[j * G + i] = g[py * G + px]!;
        }
    }
    return out;
};

/** Encode a Float32 grid as a base64 luminance grid via the real codec. */
const encodeFloatGrid = (g: Grid): string => {
    const u8 = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) {
        u8[i] = Math.round(Math.max(0, Math.min(255, g[i]!)));
    }
    return encodeLuminanceGrid(u8);
};

const main = async (): Promise<void> => {
    const seeds = [237, 1084, 1025, 429, 522, 765, 903, 1134];

    const photos: {
        seed: string;
        srcGrid: string;
        srcColor: string;
        crops: { label: string; grid: string; color: string }[];
    }[] = [];

    for (const seed of seeds) {
        const bytes = downloadPhoto(String(seed));
        const src = await signatureOfImage(bytes);

        // The rotated/cropped fixture: rotate the full-frame grid, center-60%, upscale.
        const upright = new Float32Array(G * G);
        {
            const img = await loadImage(bytes);
            const small = createCanvas(G, G);
            const ctx = small.getContext("2d");
            ctx.drawImage(img as never, 0, 0, G, G);
            const data = ctx.getImageData(0, 0, G, G).data;
            for (let i = 0; i < G * G; i++) {
                upright[i] =
                    0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
            }
        }

        const crops: { label: string; grid: string; color: string }[] = [];
        for (const [label, orient] of [
            ["upright", (g: Grid) => g],
            ["rot90", rot90Grid],
            ["rot270", (g: Grid) => rot90Grid(rot90Grid(rot90Grid(g)))],
            ["mirror", mirrorHGrid],
        ] as const) {
            const cropped = center60ScaleUp(orient(upright));
            crops.push({
                label,
                grid: encodeFloatGrid(cropped),
                color: src.color, // same palette by construction
            });
        }
        photos.push({ seed: String(seed), srcGrid: src.grid, srcColor: src.color, crops });
    }

    const TH = 0.08;
    const ESC = 0.12;

    // Replicate the benchmark's EXACT full search (all scales/offsets, 8 source
    // rotations) to isolate whether the two-tier fast-pass is dropping recall.
    const scales = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.75, 0.85, 1.0];
    const fullAlignLocal = (src: Uint8Array, crop: Uint8Array): number => {
        let best = Number.POSITIVE_INFINITY;
        for (const sx of scales) {
            for (const sy of scales) {
                const spanX = Math.max(1, Math.ceil(G - G * sx));
                const spanY = Math.max(1, Math.ceil(G - G * sy));
                const dxs = Math.max(1, Math.floor(spanX / 6));
                const dys = Math.max(1, Math.floor(spanY / 6));
                for (let ox = 0; ox <= spanX; ox += dxs) {
                    for (let oy = 0; oy <= spanY; oy += dys) {
                        let sum = 0;
                        let n = 0;
                        for (let i = 0; i < G; i++) {
                            for (let j = 0; j < G; j++) {
                                const sxr = Math.round(ox + i * sx);
                                const syr = Math.round(oy + j * sy);
                                if (sxr < 0 || sxr >= G || syr < 0 || syr >= G) {
                                    continue;
                                }
                                sum += Math.abs(
                                    crop[j * G + i]! - src[syr * G + sxr]!,
                                );
                                n++;
                            }
                        }
                        if (n < G * G * 0.6) {
                            continue;
                        }
                        best = Math.min(best, sum / n / 255);
                    }
                }
            }
        }
        return best;
    };
    const benchmarkBestSAD = (
        srcGrid: string,
        cropGrid: string,
    ): number => {
        const src = decodeLuminanceGrid(srcGrid);
        const crop = decodeLuminanceGrid(cropGrid);
        let best = fullAlignLocal(src, crop);
        for (const variant of variantsLocal(src)) {
            best = Math.min(best, fullAlignLocal(variant, crop));
        }
        return best;
    };
    const rot90Local = (g: Uint8Array): Uint8Array => {
        const r = new Uint8Array(G * G);
        for (let i = 0; i < G; i++) {
            for (let j = 0; j < G; j++) {
                r[j * G + (G - 1 - i)] = g[i * G + j]!;
            }
        }
        return r;
    };
    const mirrorHLocal = (g: Uint8Array): Uint8Array => {
        const r = new Uint8Array(G * G);
        for (let i = 0; i < G; i++) {
            for (let j = 0; j < G; j++) {
                r[i * G + (G - 1 - j)] = g[i * G + j]!;
            }
        }
        return r;
    };
    const variantsLocal = (g: Uint8Array): Uint8Array[] => [
        g,
        rot90Local(g),
        rot90Local(rot90Local(g)),
        rot90Local(rot90Local(rot90Local(g))),
        mirrorHLocal(g),
        rot90Local(mirrorHLocal(g)),
        rot90Local(rot90Local(mirrorHLocal(g))),
        rot90Local(rot90Local(rot90Local(mirrorHLocal(g)))),
    ];

    // Per-case diagnosis on the rotate-then-crop fixtures.
    let benchRecall = 0;
    for (const p of photos) {
        for (const f of p.crops) {
            const bench = benchmarkBestSAD(p.srcGrid, f.grid);
            const mine = templateMatchScore(p.srcGrid, f.grid);
            if (bench <= TH) {
                benchRecall++;
            }
            if (bench > TH && mine <= TH) {
                console.log(
                    `MINE-ONLY: ${p.seed}/${f.label} bench=${bench.toFixed(3)} mine=${mine.toFixed(3)}`,
                );
            }
            if (bench <= TH && mine > TH) {
                console.log(
                    `DROPPED: ${p.seed}/${f.label} bench=${bench.toFixed(3)} mine=${mine.toFixed(3)}`,
                );
            }
        }
    }
    console.log(`exact-benchmark-full-search recall ${benchRecall}/32`);

    // Timing: bulk-rejection cost on cross-photo pairs (the common case), plus
    // the same-photo escalation case.
    const perPair = (pairs: { a: string; b: string }[], label: string): number => {
        const start = performance.now();
        for (const p of pairs) {
            templateMatchScore(p.a, p.b);
        }
        const elapsed = performance.now() - start;
        console.log(
            `${label}: ${pairs.length} pairs in ${elapsed.toFixed(0)}ms = ${(elapsed / pairs.length).toFixed(2)}ms/pair`,
        );
        return elapsed / pairs.length;
    };
    const crossPairs: { a: string; b: string }[] = [];
    for (let i = 0; i < photos.length; i++) {
        for (let j = i + 1; j < photos.length; j++) {
            crossPairs.push({ a: photos[i]!.srcGrid, b: photos[j]!.srcGrid });
        }
    }
    const perPairCross = perPair(crossPairs, "cross-photo (reject)");
    const samePairs: { a: string; b: string }[] = photos.map((p) => ({
        a: p.srcGrid,
        b: p.crops[0]!.grid,
    }));
    perPair(samePairs, "same-photo (match)");

    const n = 5000;
    const checks = (n * 8) / 2;
    console.log(
        `estimate @5k lib: ${checks.toFixed(0)} checks; reject-only ${(checks * perPairCross / 1000).toFixed(1)}s async (non-blocking)`,
    );

    // Template-only score vs full areCropMatches gate.
    for (const useGate of [false, true]) {
        let recall = 0;
        const totalSame = photos.length * 4;
        for (const p of photos) {
            for (const f of p.crops) {
                const hit = useGate
                    ? areCropMatches(p.srcColor, p.srcGrid, f.color, f.grid)
                    : templateMatchScore(p.srcGrid, f.grid) <= TH;
                recall += hit ? 1 : 0;
            }
        }
        let fp = 0;
        for (let i = 0; i < photos.length; i++) {
            for (let j = i + 1; j < photos.length; j++) {
                const hit = useGate
                    ? areCropMatches(
                          photos[i]!.srcColor,
                          photos[i]!.srcGrid,
                          photos[j]!.srcColor,
                          photos[j]!.srcGrid,
                      )
                    : templateMatchScore(photos[i]!.srcGrid, photos[j]!.srcGrid) <= TH;
                fp += hit ? 1 : 0;
            }
        }
        console.log(
            `gate=${useGate}: rotate/crop recall ${recall}/${totalSame}, cross-photo FP ${fp}/28`,
        );
    }
};

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
