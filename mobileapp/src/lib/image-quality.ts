import type { EnteFile } from "ente-media/file";

/** Long-edge cap for analysis bitmaps (same idea as compress-classify). */
export const QUALITY_ANALYSIS_MAX = 512;

/** Gallery reorder by persisted image quality score (session-only). */
export type ImageQualitySort = "none" | "worst" | "best";

const BLOCK = 16;
const REF_MEGAPIXELS = 12;
const REF_EDGE_FRACTION = 0.08;
const REF_GRAIN = 20;
const REF_BLOCKINESS = 2.5;
const REF_BPP = 4;

const WEIGHT_RESOLUTION = 0.25;
const WEIGHT_SHARPNESS = 0.25;
const WEIGHT_CLEANLINESS = 0.2;
const WEIGHT_STRUCTURE = 0.15;
const WEIGHT_BPP = 0.15;

const clamp = (n: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, n));

const luminance = (r: number, g: number, b: number): number =>
    0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Combined quality in `[0, 1]` (higher = better) from an analysis-sized bitmap
 * plus original dimensions and file bytes.
 *
 * Sharpness is measured on a mild 3×3 blur so fine grain does not look
 * "sharp". Grain is the residual |original − blur|.
 *
 * {@link imageData} should already be capped at {@link QUALITY_ANALYSIS_MAX}
 * on the long edge. Scores are relative proxies from thumbnails — good for
 * ranking junk in a library, not absolute fidelity.
 */
export const scoreImageQuality = (
    imageData: ImageData,
    originalWidth: number,
    originalHeight: number,
    fileBytes: number,
): number => {
    const ow = Math.max(1, originalWidth);
    const oh = Math.max(1, originalHeight);
    const pixels = ow * oh;
    const megapixels = pixels / 1e6;
    const bpp = fileBytes > 0 ? (fileBytes * 8) / pixels : 0;

    const resolutionScore = clamp(
        Math.log10(1 + megapixels) / Math.log10(1 + REF_MEGAPIXELS),
        0,
        1,
    );
    const bppScore = clamp(bpp / REF_BPP, 0, 1);

    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;
    const idx = (x: number, y: number): number => (y * w + x) * 4;
    const yAt = (x: number, y: number): number => {
        const i = idx(x, y);
        return luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    };

    // Precompute luminance + 3×3 box blur (structure survives; grain averages).
    const luma = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            luma[y * w + x] = yAt(x, y);
        }
    }
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
            blurred[y * w + x] = n ? sum / n : (luma[y * w + x] ?? 0);
        }
    }

    let strongEdges = 0;
    let sampleCount = 0;
    let grainSum = 0;
    let grainCount = 0;
    let boundarySum = 0;
    let boundaryCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;

    const bAt = (x: number, y: number): number => blurred[y * w + x] ?? 0;
    const lAt = (x: number, y: number): number => luma[y * w + x] ?? 0;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const gx = bAt(x + 1, y) - bAt(x - 1, y);
            const gy = bAt(x, y + 1) - bAt(x, y - 1);
            const mag = Math.hypot(gx, gy);
            sampleCount += 1;
            if (mag > 40) {
                strongEdges += 1;
            }

            grainSum += Math.abs(lAt(x, y) - bAt(x, y));
            grainCount += 1;

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

    const edgeFraction = sampleCount ? strongEdges / sampleCount : 0;
    const sharpnessScore = clamp(edgeFraction / REF_EDGE_FRACTION, 0, 1);

    const grainMean = grainCount ? grainSum / grainCount : 0;
    const cleanlinessScore = 1 - clamp(grainMean / REF_GRAIN, 0, 1);

    const boundaryMean = boundaryCount ? boundarySum / boundaryCount : 0;
    const interiorMean = interiorCount ? interiorSum / interiorCount : 0;
    const blockiness =
        interiorMean > 1e-3 ? boundaryMean / interiorMean : boundaryMean > 0 ? 3 : 1;
    const structureScore = 1 - clamp((blockiness - 1) / (REF_BLOCKINESS - 1), 0, 1);

    const score =
        WEIGHT_RESOLUTION * resolutionScore +
        WEIGHT_SHARPNESS * sharpnessScore +
        WEIGHT_CLEANLINESS * cleanlinessScore +
        WEIGHT_STRUCTURE * structureScore +
        WEIGHT_BPP * bppScore;

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
