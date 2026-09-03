/**
 * Crop matching for the "similar photos" feature, layered on top of the Stage-1
 * dHash variants.
 *
 * The pipeline has two signals verified on real photos:
 *
 * - **Color-palette** (`colorHashFromImageData`): a 64-bit signature over a 4x4x4
 *   RGB cube. Translation-invariant, so crops of the same photo share most
 *   populated color bins. Used as a *candidate generator* (which pairs to check).
 * - **Template-match** (`templateMatchScore`): a tiny 48x48 grayscale grid is
 *   numerically aligned over scale + offset. The coarse tier uses raw luminance
 *   MAD for fast reject; plausible orientations escalate to a full sweep that
 *   scores residual MAD after a per-alignment gain+bias fit (`a·src + b ≈ crop`)
 *   so global brightness/contrast shifts still match. Rotating the source grid
 *   through its 8 canonical orientations also catches "rotate-then-crop" combos.
 *   The full tier also tries a few anisotropic (sx≠sy) scales for non-uniform
 *   zooms.
 *
 * Cost control: a coarse 48x48 raw-SAD alignment with early termination rejects
 * clearly-different pairs in a couple of ms (it aborts an offset as soon as its
 * running mean exceeds a loose bound), and only orientations the coarse tier
 * flags as plausible run the expensive photometric sweep — so recall is never
 * capped by the cheap tier while bulk rejection stays fast.
 *
 * Both signals are pure and dependency-free (no ML, no WASM).
 */
import { hammingDistance } from "@/lib/phash";

export { hammingDistance };

export const TEMPLATE_GRID_SIZE = 48;

/**
 * The per-file signal trio persisted in the phash index. The dHash variants
 * catch rotation/mirror duplicates; color proposes crop candidates; the grid
 * verifies them. `color`/`grid` are optional so legacy hashes-only entries
 * hydrate cleanly (the crop stage is skipped for those files).
 */
export interface PhashEntry {
    hashes: string[];
    /** 64-bit color-palette signature (hex). */
    color?: string;
    /** Base64 48x48 luminance grid for crop template-match. */
    grid?: string;
}

/**
 * Threshold on the match score (0..1). Coarse reject uses raw MAD; the full
 * tier uses photometric residual after gain+bias fit. Tuned with a secondary
 * color-distance soft-gate so cross-photo false positives stay near zero on an
 * expanded Picsum pool.
 */
export const CROP_SAD_THRESHOLD = 0.08;

/**
 * Color Hamming gate for candidate generation. Lenient on purpose — the
 * template residual (+ soft color gate in {@link areCropMatchesGrids}) is the
 * precision filter.
 */
export const COLOR_PALETTE_THRESHOLD = 12;

/**
 * When palette Hamming is at least this high, demand a stronger template score
 * (`<= {@link CROP_SAD_THRESHOLD} * {@link SOFT_COLOR_SCORE_FACTOR}`) so soft
 * photometric fits between unrelated-but-palette-adjacent photos don't pass.
 */
const SOFT_COLOR_HAMMING = 6;
const SOFT_COLOR_SCORE_FACTOR = 0.55;

/**
 * Above this fast-pass raw-SAD score the pair is clearly not a crop under any
 * orientation, so the expensive full (photometric) sweep is skipped. Mild
 * exposure shifts (raw MAD ~0.1–0.2) still escalate; tighter than 0.3 so
 * unrelated photos rarely pay for a full photometric search.
 */
export const CROP_REJECT_THRESHOLD = 0.25;

/** Nearest fast orientations (within this margin of the best) also escalate. */
const ESCALATE_NEIGHBOR_MARGIN = 0.05;

/** Clamp gain so a flat unrelated patch cannot invent an arbitrary match. */
const GAIN_MIN = 0.55;
const GAIN_MAX = 1.85;

/** Scale steps for the full template search (fraction of the full frame). */
const SCALES = [
    0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.75, 0.85, 1.0,
];

/** Coarse-tier scales and offset step for the cheap reject gate. */
const COARSE_SCALES = [0.4, 0.6, 0.85, 1.0];
const COARSE_OFFSET_STEPS = 8;

/** Offsets to try per axis in the full pass. */
const FULL_OFFSET_STEPS = 6;

interface ScalePair {
    sx: number;
    sy: number;
}

const isotropicPairs = (scales: number[]): ScalePair[] =>
    scales.map((scale) => ({ sx: scale, sy: scale }));

/** Full isotropic scales; anisotropic is tried only when isotropic is close. */
const FULL_ISOTROPIC_PAIRS = isotropicPairs(SCALES);

/**
 * Extra anisotropic pairs — only used when the isotropic full score is near
 * the accept threshold, so non-uniform zooms can still match without paying
 * this cost on every escalated pair.
 */
const ANISOTROPIC_PAIRS: ScalePair[] = [
    { sx: 0.45, sy: 0.55 },
    { sx: 0.55, sy: 0.45 },
    { sx: 0.55, sy: 0.7 },
    { sx: 0.7, sy: 0.55 },
    { sx: 0.7, sy: 0.85 },
    { sx: 0.85, sy: 0.7 },
];

const COARSE_PAIRS = isotropicPairs(COARSE_SCALES);

/** Encode a 48x48 luminance grid (0..255) as a base64 string. */
export const encodeLuminanceGrid = (grid: Uint8Array): string => {
    let binary = "";
    for (const value of grid) {
        binary += String.fromCharCode(value);
    }
    if (typeof btoa === "function") {
        return btoa(binary);
    }
    // Node fallback (tests / spikes run outside the browser).
    return Buffer.from(grid).toString("base64");
};

/** Decode a base64 48x48 luminance grid back to a Uint8Array. */
export const decodeLuminanceGrid = (encoded: string): Uint8Array => {
    if (typeof atob === "function") {
        const binary = atob(encoded);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }
    return new Uint8Array(Buffer.from(encoded, "base64"));
};

/**
 * Downsample RGBA ImageData pixels to a TEMPLATE_GRID_SIZE x TEMPLATE_GRID_SIZE
 * luminance grid (0..255), using the nearest source pixel per cell.
 */
export const luminanceGridFromImageData = (
    data: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
): Uint8Array => {
    const size = TEMPLATE_GRID_SIZE;
    const grid = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const sourceX = Math.min(
                sourceWidth - 1,
                Math.floor((col * sourceWidth) / size),
            );
            const sourceY = Math.min(
                sourceHeight - 1,
                Math.floor((row * sourceHeight) / size),
            );
            const index = (sourceY * sourceWidth + sourceX) * 4;
            const r = data[index]!;
            const g = data[index + 1]!;
            const b = data[index + 2]!;
            grid[row * size + col] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
    }
    return grid;
};

/**
 * 64-bit color-palette signature from RGBA ImageData: which of the 4x4x4 RGB
 * bins have any pixels. Translation-invariant.
 */
export const colorHashFromImageData = (
    data: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
): string => {
    const bins = new Uint8Array(64);
    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
            const index = (y * sourceWidth + x) * 4;
            const r = data[index]! >> 6;
            const g = data[index + 1]! >> 6;
            const b = data[index + 2]! >> 6;
            bins[(r | (g << 2) | (b << 4)) & 63] = 1;
        }
    }
    // Two 32-bit words (bins 0..31 low, 32..63 high) so no BigInt is needed.
    let low = 0;
    let high = 0;
    for (let i = 0; i < 32; i++) {
        if (bins[i]) {
            low |= 1 << i;
        }
        if (bins[32 + i]) {
            high |= 1 << i;
        }
    }
    return (
        (high >>> 0).toString(16).padStart(8, "0") +
        (low >>> 0).toString(16).padStart(8, "0")
    );
};

const rot90 = (grid: Uint8Array, size: number): Uint8Array => {
    const out = new Uint8Array(size * size);
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            out[j * size + (size - 1 - i)] = grid[i * size + j]!;
        }
    }
    return out;
};

const mirrorH = (grid: Uint8Array, size: number): Uint8Array => {
    const out = new Uint8Array(size * size);
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            out[i * size + (size - 1 - j)] = grid[i * size + j]!;
        }
    }
    return out;
};

/** The 8 canonical rotation/mirror variants of a grid (L3). */
const gridVariants = (grid: Uint8Array, size: number): Uint8Array[] => {
    const r90 = rot90(grid, size);
    const r180 = rot90(r90, size);
    const r270 = rot90(r180, size);
    const m = mirrorH(grid, size);
    return [
        grid,
        r90,
        r180,
        r270,
        m,
        rot90(m, size),
        rot90(rot90(m, size), size),
        rot90(rot90(rot90(m, size), size), size),
    ];
};

/** Reuse orientation variants when the same decoded grid is the source for many pairs. */
const variantCache = new WeakMap<Uint8Array, Uint8Array[]>();

const cachedGridVariants = (grid: Uint8Array, size: number): Uint8Array[] => {
    const cached = variantCache.get(grid);
    if (cached) {
        return cached;
    }
    const variants = gridVariants(grid, size);
    variantCache.set(grid, variants);
    return variants;
};

/** Result of an alignment: the best residual MAD and whether every offset
 * exceeded the abort bound (i.e. this orientation could not be a near-match). */
interface AlignResult {
    score: number;
    aborted: boolean;
}

/**
 * Fit `a·src + b ≈ crop` with clamped gain, then residual MAD / 255.
 * Degenerate (near-constant) patches fall back to bias-only.
 */
const photometricResidual = (
    sumS: number,
    sumC: number,
    sumSS: number,
    sumCS: number,
    n: number,
): { a: number; b: number } => {
    const denom = sumSS * n - sumS * sumS;
    if (Math.abs(denom) <= 1e-6) {
        return { a: 1, b: sumC / n - sumS / n };
    }
    const a = Math.min(
        GAIN_MAX,
        Math.max(GAIN_MIN, (sumCS * n - sumS * sumC) / denom),
    );
    return { a, b: (sumC - a * sumS) / n };
};

/**
 * Best match of `crop` within `src` over the given scale pairs and offset step.
 *
 * - `raw`: mean-absolute luminance difference (fast reject / coarse tier).
 * - `photometric`: residual MAD after per-offset gain+bias fit (full tier) so
 *   exposure/contrast shifts still match.
 *
 * `abortAbove` stops an offset once its running score cannot beat the best
 * seen so far.
 */
const align = (
    src: Uint8Array,
    crop: Uint8Array,
    size: number,
    pairs: ScalePair[],
    offsetStep: number,
    mode: "raw" | "photometric",
    abortAbove = Number.POSITIVE_INFINITY,
): AlignResult => {
    let best = abortAbove;
    let aborted = true;
    const minCells = Math.floor(size * size * 0.6);
    const abortAfter = Math.floor(size * size * 0.25);

    for (const { sx, sy } of pairs) {
        const spanX = Math.max(1, Math.ceil(size - size * sx));
        const spanY = Math.max(1, Math.ceil(size - size * sy));
        const dxs = Math.max(1, Math.floor(spanX / offsetStep));
        const dys = Math.max(1, Math.floor(spanY / offsetStep));
        for (let ox = 0; ox <= spanX; ox += dxs) {
            for (let oy = 0; oy <= spanY; oy += dys) {
                if (mode === "raw") {
                    let sum = 0;
                    let n = 0;
                    let offsetAborted = false;
                    for (let i = 0; i < size; i++) {
                        for (let j = 0; j < size; j++) {
                            const srcRow = Math.round(oy + j * sy);
                            const srcCol = Math.round(ox + i * sx);
                            if (
                                srcCol < 0 ||
                                srcCol >= size ||
                                srcRow < 0 ||
                                srcRow >= size
                            ) {
                                continue;
                            }
                            sum += Math.abs(
                                crop[j * size + i]! -
                                    src[srcRow * size + srcCol]!,
                            );
                            n++;
                            if (n >= abortAfter && sum / n / 255 > best) {
                                offsetAborted = true;
                                break;
                            }
                        }
                        if (offsetAborted) {
                            break;
                        }
                    }
                    if (n < minCells || offsetAborted) {
                        continue;
                    }
                    aborted = false;
                    const normalized = sum / n / 255;
                    if (normalized < best) {
                        best = normalized;
                    }
                    continue;
                }

                let sumS = 0;
                let sumC = 0;
                let sumSS = 0;
                let sumCS = 0;
                let n = 0;
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        const srcRow = Math.round(oy + j * sy);
                        const srcCol = Math.round(ox + i * sx);
                        if (
                            srcCol < 0 ||
                            srcCol >= size ||
                            srcRow < 0 ||
                            srcRow >= size
                        ) {
                            continue;
                        }
                        const s = src[srcRow * size + srcCol]!;
                        const c = crop[j * size + i]!;
                        sumS += s;
                        sumC += c;
                        sumSS += s * s;
                        sumCS += c * s;
                        n++;
                    }
                }
                if (n < minCells) {
                    continue;
                }

                const { a, b } = photometricResidual(
                    sumS,
                    sumC,
                    sumSS,
                    sumCS,
                    n,
                );

                let sum = 0;
                let counted = 0;
                let offsetAborted = false;
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        const srcRow = Math.round(oy + j * sy);
                        const srcCol = Math.round(ox + i * sx);
                        if (
                            srcCol < 0 ||
                            srcCol >= size ||
                            srcRow < 0 ||
                            srcRow >= size
                        ) {
                            continue;
                        }
                        const predicted = a * src[srcRow * size + srcCol]! + b;
                        sum += Math.abs(crop[j * size + i]! - predicted);
                        counted++;
                        if (
                            counted >= abortAfter &&
                            sum / counted / 255 > best
                        ) {
                            offsetAborted = true;
                            break;
                        }
                    }
                    if (offsetAborted) {
                        break;
                    }
                }
                if (offsetAborted || counted < minCells) {
                    continue;
                }
                aborted = false;
                let normalized = sum / counted / 255;
                // Flat patches can fit an arbitrary gain/bias; demand a near-exact
                // residual there so soft matches on sky/blur don't pass.
                const meanS = sumS / n;
                const variance = sumSS / n - meanS * meanS;
                if (variance < 100 && normalized > 0.02) {
                    normalized = Math.max(normalized, 0.12);
                }
                if (normalized < best) {
                    best = normalized;
                }
            }
        }
    }
    return { score: best, aborted };
};

/** Coarse 48x48 alignment used as the cheap reject gate (raw SAD). */
const coarseAlign = (
    src: Uint8Array,
    crop: Uint8Array,
): AlignResult =>
    align(
        src,
        crop,
        TEMPLATE_GRID_SIZE,
        COARSE_PAIRS,
        COARSE_OFFSET_STEPS,
        "raw",
        CROP_REJECT_THRESHOLD,
    );

/** Full 48x48 isotropic photometric alignment. */
const fullAlignIsotropic = (
    src: Uint8Array,
    crop: Uint8Array,
): number =>
    align(
        src,
        crop,
        TEMPLATE_GRID_SIZE,
        FULL_ISOTROPIC_PAIRS,
        FULL_OFFSET_STEPS,
        "photometric",
    ).score;

/** Limited anisotropic photometric refinement. */
const fullAlignAnisotropic = (
    src: Uint8Array,
    crop: Uint8Array,
): number =>
    align(
        src,
        crop,
        TEMPLATE_GRID_SIZE,
        ANISOTROPIC_PAIRS,
        FULL_OFFSET_STEPS,
        "photometric",
    ).score;

/**
 * Lowest achievable photometric residual between two decoded 48×48 luminance grids.
 * Prefer this when grids are already decoded (batch crop checks).
 */
export const templateMatchScoreGrids = (
    src: Uint8Array,
    crop: Uint8Array,
): number => {
    if (
        src.length !== TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE ||
        crop.length !== TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE
    ) {
        return Number.POSITIVE_INFINITY;
    }

    const variants = cachedGridVariants(src, TEMPLATE_GRID_SIZE);
    const coarse = variants.map((variant) => coarseAlign(variant, crop));
    const bestScore = Math.min(...coarse.map((result) => result.score));
    if (bestScore <= CROP_SAD_THRESHOLD) {
        return bestScore;
    }
    if (coarse.every((result) => result.aborted)) {
        return bestScore;
    }

    let best = bestScore;
    for (let i = 0; i < variants.length; i++) {
        if (coarse[i]!.aborted) {
            continue;
        }
        if (coarse[i]!.score > bestScore + ESCALATE_NEIGHBOR_MARGIN) {
            continue;
        }
        const full = fullAlignIsotropic(variants[i]!, crop);
        if (full < best) {
            best = full;
        }
        if (best <= CROP_SAD_THRESHOLD) {
            return best;
        }
        // Near-miss: try anisotropic scales before giving up on this orientation.
        if (full <= CROP_SAD_THRESHOLD + 0.04) {
            const aniso = fullAlignAnisotropic(variants[i]!, crop);
            if (aniso < best) {
                best = aniso;
            }
            if (best <= CROP_SAD_THRESHOLD) {
                return best;
            }
        }
    }
    return best;
};

/**
 * Lowest achievable score treating either grid as the crop of the other.
 * Production pairs do not know which file is the tighter crop. Second direction
 * is skipped when the first already matches.
 */
export const templateMatchScoreGridsEither = (
    a: Uint8Array,
    b: Uint8Array,
): number => {
    const ab = templateMatchScoreGrids(a, b);
    if (ab <= CROP_SAD_THRESHOLD) {
        return ab;
    }
    return Math.min(ab, templateMatchScoreGrids(b, a));
};

/**
 * Lowest achievable photometric residual between two images. Runs a cheap 48x48
 * coarse alignment against all 8 source orientations with a loose abort bound;
 * a pair whose every orientation aborts is clearly not a crop and is rejected
 * early. Plausible orientations escalate to the unbounded full sweep, so the
 * cheap tier never caps recall. Both orderings are tried (either image may be
 * the crop).
 */
export const templateMatchScore = (aGrid: string, bGrid: string): number =>
    templateMatchScoreGridsEither(
        decodeLuminanceGrid(aGrid),
        decodeLuminanceGrid(bGrid),
    );

/**
 * Whether two images could be the same photo under a crop, using already-decoded
 * luminance grids (batch path — decode once per file).
 */
export const areCropMatchesGrids = (
    aColor: string,
    aGrid: Uint8Array,
    bColor: string,
    bGrid: Uint8Array,
): boolean => {
    const colorDistance = hammingDistance(aColor, bColor);
    if (colorDistance > COLOR_PALETTE_THRESHOLD) {
        return false;
    }
    const score = templateMatchScoreGridsEither(aGrid, bGrid);
    if (score > CROP_SAD_THRESHOLD) {
        return false;
    }
    if (
        colorDistance >= SOFT_COLOR_HAMMING &&
        score > CROP_SAD_THRESHOLD * SOFT_COLOR_SCORE_FACTOR
    ) {
        return false;
    }
    return true;
};

/**
 * Whether two images could be the same photo under a crop. Color is the cheap
 * candidate gate; the template match is the precision gate.
 */
export const areCropMatches = (
    aColor: string,
    aGrid: string,
    bColor: string,
    bGrid: string,
): boolean =>
    areCropMatchesGrids(
        aColor,
        decodeLuminanceGrid(aGrid),
        bColor,
        decodeLuminanceGrid(bGrid),
    );
