/**
 * Validation: run the real src/lib/crop-match implementation against an expanded
 * real-photo pool (rotate/crop, offset crops, brightness/contrast), confirming
 * recall and cross-photo FP.
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
    templateMatchScoreGrids,
    CROP_SAD_THRESHOLD,
} from "../src/lib/crop-match";

const outDir = join(process.cwd(), ".spike-out");
mkdirSync(outDir, { recursive: true });
const G = 48;
const TH = CROP_SAD_THRESHOLD;

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

/** Crop a fractional window starting at (fx,fy) and scale up to full grid. */
const cropWindowScaleUp = (
    g: Grid,
    fx: number,
    fy: number,
    fw: number,
    fh: number,
): Grid => {
    const out = new Float32Array(G * G);
    const x0 = Math.floor(G * fx);
    const y0 = Math.floor(G * fy);
    const w = Math.max(1, Math.floor(G * fw));
    const h = Math.max(1, Math.floor(G * fh));
    for (let i = 0; i < G; i++) {
        for (let j = 0; j < G; j++) {
            const px = x0 + Math.min(w - 1, Math.floor((i * w) / G));
            const py = y0 + Math.min(h - 1, Math.floor((j * h) / G));
            out[j * G + i] = g[py * G + px]!;
        }
    }
    return out;
};

const center60ScaleUp = (g: Grid): Grid =>
    cropWindowScaleUp(g, 0.2, 0.2, 0.6, 0.6);

const shadeGrid = (g: Grid, gain: number, bias: number): Grid => {
    const out = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) {
        out[i] = Math.max(0, Math.min(255, g[i]! * gain + bias));
    }
    return out;
};

const encodeFloatGrid = (g: Grid): string => {
    const u8 = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) {
        u8[i] = Math.round(Math.max(0, Math.min(255, g[i]!)));
    }
    return encodeLuminanceGrid(u8);
};

type Fixture = { label: string; grid: string; color: string };

const main = async (): Promise<void> => {
    // Expanded pool: original 8 + 8 more seeds for broader coverage.
    const seeds = [
        237, 1084, 1025, 429, 522, 765, 903, 1134,
        48, 201, 338, 433, 548, 1100, 823, 996,
    ];

    const photos: {
        seed: string;
        srcGrid: string;
        srcColor: string;
        crops: Fixture[];
        offsets: Fixture[];
        shaded: Fixture[];
    }[] = [];

    for (const seed of seeds) {
        const bytes = downloadPhoto(String(seed));
        const src = await signatureOfImage(bytes);

        const upright = new Float32Array(G * G);
        {
            const img = await loadImage(bytes);
            const small = createCanvas(G, G);
            const ctx = small.getContext("2d");
            ctx.drawImage(img as never, 0, 0, G, G);
            const data = ctx.getImageData(0, 0, G, G).data;
            for (let i = 0; i < G * G; i++) {
                upright[i] =
                    0.299 * data[i * 4]! +
                    0.587 * data[i * 4 + 1]! +
                    0.114 * data[i * 4 + 2]!;
            }
        }

        const crops: Fixture[] = [];
        for (const [label, orient] of [
            ["upright", (g: Grid) => g],
            ["rot90", rot90Grid],
            ["rot270", (g: Grid) => rot90Grid(rot90Grid(rot90Grid(g)))],
            ["mirror", mirrorHGrid],
        ] as const) {
            crops.push({
                label,
                grid: encodeFloatGrid(center60ScaleUp(orient(upright))),
                color: src.color,
            });
        }

        const offsets: Fixture[] = [];
        for (const [label, fx, fy, fw, fh] of [
            ["tl-50", 0.05, 0.05, 0.5, 0.5],
            ["br-50", 0.45, 0.45, 0.5, 0.5],
            ["center-45", 0.275, 0.275, 0.45, 0.45],
            ["wide-70", 0.1, 0.2, 0.8, 0.55],
        ] as const) {
            offsets.push({
                label,
                grid: encodeFloatGrid(cropWindowScaleUp(upright, fx, fy, fw, fh)),
                color: src.color,
            });
        }

        const shaded: Fixture[] = [];
        for (const [label, gain, bias, useCrop] of [
            ["bright", 1.2, 25, false],
            ["dark", 0.7, -15, false],
            ["contrast", 1.4, -20, false],
            ["bright-crop", 1.15, 18, true],
            ["dark-crop", 0.75, -10, true],
        ] as const) {
            const base = useCrop ? center60ScaleUp(upright) : upright;
            shaded.push({
                label,
                grid: encodeFloatGrid(shadeGrid(base, gain, bias)),
                color: src.color,
            });
        }

        photos.push({
            seed: String(seed),
            srcGrid: src.grid,
            srcColor: src.color,
            crops,
            offsets,
            shaded,
        });
    }

    const scorePair = (srcGrid: string, otherGrid: string): number =>
        templateMatchScore(srcGrid, otherGrid);

    const scoreOneWay = (srcGrid: string, otherGrid: string): number =>
        templateMatchScoreGrids(
            decodeLuminanceGrid(srcGrid),
            decodeLuminanceGrid(otherGrid),
        );

    const tally = (
        label: string,
        fixtures: (p: (typeof photos)[0]) => Fixture[],
        useGate: boolean,
    ): { recall: number; total: number } => {
        let recall = 0;
        let total = 0;
        for (const p of photos) {
            for (const f of fixtures(p)) {
                total++;
                const hit = useGate
                    ? areCropMatches(p.srcColor, p.srcGrid, f.color, f.grid)
                    : scorePair(p.srcGrid, f.grid) <= TH;
                recall += hit ? 1 : 0;
                if (!hit) {
                    const score = scorePair(p.srcGrid, f.grid);
                    const oneWay = scoreOneWay(p.srcGrid, f.grid);
                    console.log(
                        `MISS ${label}: ${p.seed}/${f.label} either=${score.toFixed(3)} oneway=${oneWay.toFixed(3)}`,
                    );
                }
            }
        }
        return { recall, total };
    };

    const crossFp = (useGate: boolean): { fp: number; total: number } => {
        let fp = 0;
        let total = 0;
        for (let i = 0; i < photos.length; i++) {
            for (let j = i + 1; j < photos.length; j++) {
                total++;
                const hit = useGate
                    ? areCropMatches(
                          photos[i]!.srcColor,
                          photos[i]!.srcGrid,
                          photos[j]!.srcColor,
                          photos[j]!.srcGrid,
                      )
                    : scorePair(photos[i]!.srcGrid, photos[j]!.srcGrid) <= TH;
                fp += hit ? 1 : 0;
                if (hit) {
                    console.log(
                        `FP: ${photos[i]!.seed} vs ${photos[j]!.seed} score=${scorePair(photos[i]!.srcGrid, photos[j]!.srcGrid).toFixed(3)}`,
                    );
                }
            }
        }
        return { fp, total };
    };

    const perPair = (
        pairs: { a: string; b: string }[],
        label: string,
    ): number => {
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
    perPair(crossPairs, "cross-photo (reject)");
    perPair(
        photos.map((p) => ({ a: p.srcGrid, b: p.crops[0]!.grid })),
        "same-photo (match)",
    );

    for (const useGate of [false, true]) {
        const crop = tally("crop", (p) => p.crops, useGate);
        const offset = tally("offset", (p) => p.offsets, useGate);
        const shade = tally("shade", (p) => p.shaded, useGate);
        const { fp, total: crossTotal } = crossFp(useGate);
        console.log(
            `gate=${useGate}: rotate/crop ${crop.recall}/${crop.total}, offset ${offset.recall}/${offset.total}, shading ${shade.recall}/${shade.total}, cross FP ${fp}/${crossTotal}`,
        );
    }
};

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
