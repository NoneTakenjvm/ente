import type { EnteFile } from "ente-media/file";

/** Long-edge cap for analysis bitmaps (same idea as compress-classify). */
export const QUALITY_ANALYSIS_MAX = 512;

/** Gallery reorder by persisted image quality score (session-only). */
export type ImageQualitySort = "none" | "worst" | "best";

/**
 * Persisted index schema version. Bump when the score formula changes so old
 * scores are discarded and Manage → Scan must run again.
 */
export const QUALITY_INDEX_VERSION = 2 as const;

const BLOCK = 16;
/** Long-edge px where resolution score reaches 0 / 1. */
const RES_LONG_EDGE_FLOOR = 640;
const RES_LONG_EDGE_CEIL = 4000;
/** Laplacian variance on mildly blurred luma that maps to full sharpness. */
const REF_LAPLACIAN_VAR = 180;
/** Flat-region residual that maps to full grain penalty. */
const REF_GRAIN = 10;
const BLOCKINESS_START = 1.8;
const BLOCKINESS_FULL = 3.5;

const clamp = (n: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, n));

const luminance = (r: number, g: number, b: number): number =>
    0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Resolution in `[0, 1]` from original long edge. Sub-VGA ≈ 0; ≥4K long edge ≈ 1.
 */
export const resolutionQualityScore = (
    originalWidth: number,
    originalHeight: number,
): number => {
    const longEdge = Math.max(1, originalWidth, originalHeight);
    if (longEdge <= RES_LONG_EDGE_FLOOR) {
        return 0;
    }
    if (longEdge >= RES_LONG_EDGE_CEIL) {
        return 1;
    }
    return (
        (Math.log2(longEdge) - Math.log2(RES_LONG_EDGE_FLOOR)) /
        (Math.log2(RES_LONG_EDGE_CEIL) - Math.log2(RES_LONG_EDGE_FLOOR))
    );
};

/**
 * Combined quality in `[0, 1]` (higher = better).
 *
 * Primary signal is **resolution × structured sharpness** (product), so low-res
 * or soft thumbs cannot float to the top of Best. Grain and pixelation are
 * mild extra penalties only.
 *
 * {@link imageData} should already be capped at {@link QUALITY_ANALYSIS_MAX}.
 */
export const scoreImageQuality = (
    imageData: ImageData,
    originalWidth: number,
    originalHeight: number,
    fileBytes: number,
): number => {
    const ow = Math.max(0, originalWidth);
    const oh = Math.max(0, originalHeight);
    const pixels = Math.max(1, ow * oh);
    const megapixels = pixels / 1e6;
    const bpp = fileBytes > 0 ? (fileBytes * 8) / pixels : 0;

    const resolutionScore = resolutionQualityScore(ow, oh);

    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;
    const idx = (x: number, y: number): number => (y * w + x) * 4;
    const yAt = (x: number, y: number): number => {
        const i = idx(x, y);
        return luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    };

    const luma = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            luma[y * w + x] = yAt(x, y);
        }
    }
    const lAt = (x: number, y: number): number => luma[y * w + x] ?? 0;

    // 3×3 blur: structure survives, fine grain averages. Sharpness uses this
    // so noise does not look crisp; residual vs original is the grain signal.
    const blurred = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) {
                    continue;
                }
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) {
                        continue;
                    }
                    sum += luma[yy * w + xx] ?? 0;
                    n += 1;
                }
            }
            blurred[y * w + x] = n ? sum / n : lAt(x, y);
        }
    }
    const bAt = (x: number, y: number): number => blurred[y * w + x] ?? 0;

    let lapSumSq = 0;
    let lapCount = 0;
    let grainSum = 0;
    let grainCount = 0;
    let boundarySum = 0;
    let boundaryCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const bc = bAt(x, y);
            const lap =
                4 * bc -
                bAt(x - 1, y) -
                bAt(x + 1, y) -
                bAt(x, y - 1) -
                bAt(x, y + 1);
            lapSumSq += lap * lap;
            lapCount += 1;

            const gx = bAt(x + 1, y) - bAt(x - 1, y);
            const gy = bAt(x, y + 1) - bAt(x, y - 1);
            if (Math.hypot(gx, gy) < 18) {
                grainSum += Math.abs(lAt(x, y) - bc);
                grainCount += 1;
            }

            const c = lAt(x, y);
            const rightDiff = Math.abs(lAt(x + 1, y) - c);
            if (x % BLOCK === BLOCK - 1 && x + 1 < w) {
                boundarySum += rightDiff;
                boundaryCount += 1;
            } else if (x % BLOCK !== 0) {
                interiorSum += rightDiff;
                interiorCount += 1;
            }
            const downDiff = Math.abs(lAt(x, y + 1) - c);
            if (y % BLOCK === BLOCK - 1 && y + 1 < h) {
                boundarySum += downDiff;
                boundaryCount += 1;
            } else if (y % BLOCK !== 0) {
                interiorSum += downDiff;
                interiorCount += 1;
            }
        }
    }

    const laplacianVar = lapCount ? lapSumSq / lapCount : 0;
    const sharpnessScore = clamp(
        Math.sqrt(laplacianVar) / Math.sqrt(REF_LAPLACIAN_VAR),
        0,
        1,
    );

    const grainMean = grainCount ? grainSum / grainCount : 0;
    const grainPenalty = clamp(grainMean / REF_GRAIN, 0, 1);

    const boundaryMean = boundaryCount ? boundarySum / boundaryCount : 0;
    const interiorMean = interiorCount ? interiorSum / interiorCount : 0;
    const blockiness =
        interiorMean > 1e-3 ? boundaryMean / interiorMean : boundaryMean > 0 ? 3 : 1;
    const pixelationPenalty = clamp(
        (blockiness - BLOCKINESS_START) / (BLOCKINESS_FULL - BLOCKINESS_START),
        0,
        1,
    );

    const crushPenalty =
        megapixels >= 1 && bpp > 0 && bpp < 1.4 ?
            clamp((1.4 - bpp) / 1.4, 0, 1) :
            0;

    // Resolution × sharpness is the ranking spine. Extra defects are mild.
    const score =
        resolutionScore *
        (0.08 + 0.92 * sharpnessScore) *
        (1 - 0.35 * grainPenalty) *
        (1 - 0.35 * pixelationPenalty) *
        (1 - 0.3 * crushPenalty);

    return clamp(Number(score.toFixed(4)), 0, 1);
};

/**
 * Reorder files by persisted quality score.
 *
 * - `worst`: lowest score first.
 * - `best`: highest score first.
 * - `none`: shallow copy unchanged.
 *
 * Unscanned files (missing from {@link scores}) always sort last.
 */
export const sortFilesByImageQuality = (
    files: EnteFile[],
    mode: ImageQualitySort,
    scores: ReadonlyMap<number, number>,
): EnteFile[] => {
    if (mode === "none") {
        return [...files];
    }
    const ascending = mode === "worst";
    return [...files].sort((a, b) => {
        const scoreA = scores.get(a.id);
        const scoreB = scores.get(b.id);
        const knownA = scoreA !== undefined;
        const knownB = scoreB !== undefined;
        if (knownA !== knownB) {
            return knownA ? -1 : 1;
        }
        if (!knownA || !knownB) {
            return a.id - b.id;
        }
        if (scoreA !== scoreB) {
            return ascending ? scoreA - scoreB : scoreB - scoreA;
        }
        return a.id - b.id;
    });
};
