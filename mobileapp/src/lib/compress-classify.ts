/**
 * Pixel-stat router for still-image compression (PhotoHoard policy).
 * Default: avif-q60. Only leave default when signals agree with high confidence.
 */

export const ANALYSIS_MAX = 512;
const BLOCK = 16;

export type CompressImagePreset =
    | "skip" |
    "avif-q60" |
    "avif-q70" |
    "avif-q80" |
    "lossless-webp";

export type CompressImageConfidence = "high" | "medium" | "default";

export interface ImageCompressFeatures {
    width: number;
    height: number;
    megapixels: number;
    fileBytes: number;
    bpp: number;
    uniqueColors: number;
    colorScore: number;
    flatRatio: number;
    edgeDensity: number;
    hvDominance: number;
    anisotropy: number;
}

export interface CompressImageDecision {
    preset: CompressImagePreset;
    confidence: CompressImageConfidence;
    reasons: string[];
    features: ImageCompressFeatures;
}

const clamp = (n: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, n));

const luminance = (r: number, g: number, b: number): number =>
    0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Measure palette, flatness, and edge structure on an analysis-sized RGBA bitmap.
 *
 * {@link originalWidth}/{@link originalHeight} are the full-resolution size used
 * for megapixels and bits-per-pixel. {@link imageData} should already be capped
 * at {@link ANALYSIS_MAX} on the long edge.
 */
export const analyzeImageData = (
    imageData: ImageData,
    fileBytes: number,
    originalWidth: number,
    originalHeight: number,
): ImageCompressFeatures => {
    const pixels = Math.max(1, originalWidth * originalHeight);
    const bpp = (fileBytes * 8) / pixels;
    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;
    const channels = 4;
    const idx = (x: number, y: number): number => (y * w + x) * channels;

    const colorSet = new Set<number>();
    for (let i = 0; i < data.length; i += channels) {
        const r = (data[i] ?? 0) >> 3;
        const g = (data[i + 1] ?? 0) >> 3;
        const b = (data[i + 2] ?? 0) >> 3;
        colorSet.add((r << 10) | (g << 5) | b);
    }
    const uniqueColors = colorSet.size;
    const colorScore = clamp(uniqueColors / 2500, 0, 1);

    let flatBlocks = 0;
    let totalBlocks = 0;
    for (let by = 0; by + BLOCK <= h; by += BLOCK) {
        for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
            let sum = 0;
            let sumSq = 0;
            const n = BLOCK * BLOCK;
            for (let y = by; y < by + BLOCK; y++) {
                for (let x = bx; x < bx + BLOCK; x++) {
                    const i = idx(x, y);
                    const yv = luminance(
                        data[i] ?? 0,
                        data[i + 1] ?? 0,
                        data[i + 2] ?? 0,
                    );
                    sum += yv;
                    sumSq += yv * yv;
                }
            }
            const mean = sum / n;
            const variance = sumSq / n - mean * mean;
            totalBlocks += 1;
            if (variance < 40) {
                flatBlocks += 1;
            }
        }
    }
    const flatRatio = totalBlocks ? flatBlocks / totalBlocks : 0;

    let edgeCount = 0;
    let sampleCount = 0;
    const histBins = new Array<number>(8).fill(0);

    for (let y = 1; y < h - 1; y += 2) {
        for (let x = 1; x < w - 1; x += 2) {
            const iL = idx(x - 1, y);
            const iR = idx(x + 1, y);
            const iU = idx(x, y - 1);
            const iD = idx(x, y + 1);
            const gx =
                luminance(data[iR] ?? 0, data[iR + 1] ?? 0, data[iR + 2] ?? 0) -
                luminance(data[iL] ?? 0, data[iL + 1] ?? 0, data[iL + 2] ?? 0);
            const gy =
                luminance(data[iD] ?? 0, data[iD + 1] ?? 0, data[iD + 2] ?? 0) -
                luminance(data[iU] ?? 0, data[iU + 1] ?? 0, data[iU + 2] ?? 0);
            const mag = Math.hypot(gx, gy);
            sampleCount += 1;
            if (mag > 28) {
                edgeCount += 1;
                let angle = Math.atan2(gy, gx);
                if (angle < 0) {
                    angle += Math.PI;
                }
                const bin = Math.min(7, Math.floor((angle / Math.PI) * 8));
                histBins[bin] = (histBins[bin] ?? 0) + 1;
            }
        }
    }

    const edgeDensity = sampleCount ? edgeCount / sampleCount : 0;
    const edgeTotal = histBins.reduce((a, b) => a + b, 0) || 1;
    const strictHV =
        (histBins[0] ?? 0) +
        (histBins[7] ?? 0) +
        (histBins[3] ?? 0) +
        (histBins[4] ?? 0);
    const hvDominance = strictHV / edgeTotal;
    const maxBin = Math.max(...histBins);
    const meanBin = edgeTotal / 8;
    const anisotropy = meanBin ? maxBin / meanBin : 1;

    return {
        width: originalWidth,
        height: originalHeight,
        megapixels: pixels / 1e6,
        fileBytes,
        bpp: Number(bpp.toFixed(3)),
        uniqueColors,
        colorScore: Number(colorScore.toFixed(3)),
        flatRatio: Number(flatRatio.toFixed(3)),
        edgeDensity: Number(edgeDensity.toFixed(3)),
        hvDominance: Number(hvDominance.toFixed(3)),
        anisotropy: Number(anisotropy.toFixed(2)),
    };
};

/**
 * Decide encode preset from features. Conservative: only leave avif-q60 when
 * multiple signals agree. {@link minSizeBytes} of 0 disables the size skip.
 */
export const routeFromFeatures = (
    features: ImageCompressFeatures,
    minSizeBytes = 0,
): CompressImageDecision => {
    const reasons: string[] = [];

    if (minSizeBytes > 0 && features.fileBytes < minSizeBytes) {
        reasons.push("already under minimum size");
        return {
            preset: "skip",
            confidence: "high",
            reasons,
            features,
        };
    }

    const alreadyCrushed = features.bpp < 1.6 && features.megapixels <= 4;
    const veryCrushed = features.bpp < 1.2 && features.megapixels <= 3;

    const lowColor = features.colorScore < 0.35;
    const manyFlats = features.flatRatio >= 0.35;
    const structuredEdges =
        features.edgeDensity >= 0.08 &&
        features.hvDominance >= 0.55 &&
        features.anisotropy >= 1.8;
    const graphicsLike =
        (lowColor && manyFlats) ||
        (manyFlats && structuredEdges) ||
        (lowColor && structuredEdges && features.flatRatio >= 0.22);
    const graphicsStrong =
        lowColor && manyFlats && (structuredEdges || features.flatRatio >= 0.5);

    if (graphicsStrong) {
        reasons.push("graphics-strong");
        return {
            preset: "lossless-webp",
            confidence: "high",
            reasons,
            features,
        };
    }

    if (graphicsLike) {
        reasons.push("graphics-ish");
        return {
            preset: "avif-q80",
            confidence: "medium",
            reasons,
            features,
        };
    }

    if (veryCrushed) {
        reasons.push("already-crushed");
        return {
            preset: "avif-q80",
            confidence: "high",
            reasons,
            features,
        };
    }

    if (alreadyCrushed) {
        reasons.push("likely re-encoded");
        return {
            preset: "avif-q70",
            confidence: "medium",
            reasons,
            features,
        };
    }

    reasons.push("default photo");
    return {
        preset: "avif-q60",
        confidence: "default",
        reasons,
        features,
    };
};

export const mimeTypeForPreset = (
    preset: Exclude<CompressImagePreset, "skip">,
): { mimeType: string; extension: string } => {
    if (preset === "lossless-webp") {
        return { mimeType: "image/webp", extension: "webp" };
    }
    return { mimeType: "image/avif", extension: "avif" };
};

export const avifQualityForPreset = (
    preset: CompressImagePreset,
): number | undefined => {
    if (preset === "avif-q60") {
        return 60;
    }
    if (preset === "avif-q70") {
        return 70;
    }
    if (preset === "avif-q80") {
        return 80;
    }
    return undefined;
};
