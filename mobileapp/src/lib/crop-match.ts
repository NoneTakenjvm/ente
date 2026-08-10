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
 *   numerically aligned over scale + offset, and the lowest mean-absolute
 *   luminance difference is compared against a threshold. A true crop lines up
 *   tightly; a different photo never aligns. Rotating the source grid through
 *   its 8 canonical orientations also catches "rotate-then-crop" combos.
 *
 * Cost control: a coarse 48x48 alignment with early termination rejects
 * clearly-different pairs in a couple of ms (it aborts an offset as soon as its
 * running mean exceeds a loose bound), and only orientations the coarse tier
 * flags as plausible run the expensive unbounded sweep — so recall is never
 * capped by the cheap tier while bulk rejection stays fast.
 *
 * Both signals are pure and dependency-free (no ML, no WASM).
 */

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

/** Threshold on the normalized mean-absolute luminance difference (0..1). */
export const CROP_SAD_THRESHOLD = 0.08;

/**
 * Above this fast-pass score the pair is clearly not a crop under any
 * orientation, so the expensive full sweep is skipped. The fast tier is only a
 * reject gate — plausible pairs always escalate to the authoritative 48x48
 * search so recall isn't capped by the cheap tier.
 */
export const CROP_REJECT_THRESHOLD = 0.3;

/** Nearest fast orientations (within this margin of the best) also escalate. */
const ESCALATE_NEIGHBOR_MARGIN = 0.05;

/** Scale steps for the full template search (fraction of the full frame). */
const SCALES = [
    0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.75, 0.85, 1.0,
];

/** Coarse-tier scales and offset step for the cheap reject gate. */
const COARSE_SCALES = [0.4, 0.6, 0.85, 1.0];
const COARSE_OFFSET_STEPS = 8;

/** Offsets to try per axis in the full pass. */
const FULL_OFFSET_STEPS = 6;

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

/** Hamming distance between two 64-bit hex signatures (color or dHash). */
export const hammingDistance = (left: string, right: string): number => {
    let distance = 0;
    for (let i = 0; i < left.length; i++) {
        const xor = Number.parseInt(left[i]!, 16) ^ Number.parseInt(right[i]!, 16);
        for (let bit = 0; bit < 4; bit++) {
            distance += (xor >> bit) & 1;
        }
    }
    return distance;
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

/** Result of an alignment: the best normalized SAD and whether every offset
 * exceeded the abort bound (i.e. this orientation could not be a near-match). */
interface AlignResult {
    score: number;
    aborted: boolean;
}

/**
 * Best match of `crop` within `src` over the given scale steps and offset step.
 * `abortAbove` (normalized SAD) stops evaluating an offset as soon as its
 * running mean exceeds it after a minimum sample, so clearly-mismatched offsets
 * are skipped; that makes reject paths fast while true matches still find their
 * minimum. Both grids are `size` x `size`.
 */
const align = (
    src: Uint8Array,
    crop: Uint8Array,
    size: number,
    sizes: number[],
    offsetStep: number,
    abortAbove = Number.POSITIVE_INFINITY,
): AlignResult => {
    // Seed with the abort bound so the very first offset also aborts early for
    // clearly-mismatched pairs, and every later offset aborts once it can no
    // longer beat the best seen so far.
    let best = abortAbove;
    let aborted = true;
    const minCells = Math.floor(size * size * 0.6);
    const abortAfter = Math.floor(size * size * 0.25);
    for (const scale of sizes) {
        const spanX = Math.max(1, Math.ceil(size - size * scale));
        const spanY = Math.max(1, Math.ceil(size - size * scale));
        const dxs = Math.max(1, Math.floor(spanX / offsetStep));
        const dys = Math.max(1, Math.floor(spanY / offsetStep));
        for (let ox = 0; ox <= spanX; ox += dxs) {
            for (let oy = 0; oy <= spanY; oy += dys) {
                let sum = 0;
                let n = 0;
                let offsetAborted = false;
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        const srcRow = Math.round(oy + j * scale);
                        const srcCol = Math.round(ox + i * scale);
                        if (
                            srcCol < 0 || srcCol >= size ||
                            srcRow < 0 || srcRow >= size
                        ) {
                            continue;
                        }
                        sum += Math.abs(crop[j * size + i]! - src[srcRow * size + srcCol]!);
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
                if (n < minCells) {
                    continue;
                }
                if (offsetAborted) {
                    continue;
                }
                aborted = false;
                const normalized = sum / n / 255;
                if (normalized < best) {
                    best = normalized;
                }
            }
        }
    }
    return { score: best, aborted };
};

/** Coarse 48x48 alignment used as the cheap reject gate (loose bound). */
const coarseAlign = (
    src: Uint8Array,
    crop: Uint8Array,
): AlignResult =>
    align(
        src,
        crop,
        TEMPLATE_GRID_SIZE,
        COARSE_SCALES,
        COARSE_OFFSET_STEPS,
        CROP_REJECT_THRESHOLD,
    );

/** Full 48x48 alignment: all scales, fine offsets, no abort. */
const fullAlign = (
    src: Uint8Array,
    crop: Uint8Array,
): number =>
    align(
        src,
        crop,
        TEMPLATE_GRID_SIZE,
        SCALES,
        FULL_OFFSET_STEPS,
    ).score;

/**
 * Lowest achievable normalized SAD between two images. Runs a cheap 48x48
 * coarse alignment against all 8 source orientations with a loose abort bound;
 * a pair whose every orientation aborts is clearly not a crop and is rejected
 * early. Plausible orientations escalate to the unbounded full sweep, so the
 * cheap tier never caps recall. The crop is held fixed while the source is
 * rotated, which is the validated rotate-then-crop semantics.
 */
export const templateMatchScore = (aGrid: string, bGrid: string): number => {
    const src = decodeLuminanceGrid(aGrid);
    const crop = decodeLuminanceGrid(bGrid);
    if (
        src.length !== TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE ||
        crop.length !== TEMPLATE_GRID_SIZE * TEMPLATE_GRID_SIZE
    ) {
        return Number.POSITIVE_INFINITY;
    }

    const variants = gridVariants(src, TEMPLATE_GRID_SIZE);
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
        const full = fullAlign(variants[i]!, crop);
        if (full < best) {
            best = full;
        }
        if (best <= CROP_SAD_THRESHOLD) {
            return best;
        }
    }
    return best;
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
): boolean => {
    if (hammingDistance(aColor, bColor) > COLOR_PALETTE_THRESHOLD) {
        return false;
    }
    return templateMatchScore(aGrid, bGrid) <= CROP_SAD_THRESHOLD;
};

/**
 * Color Hamming gate. Keep it lenient — it only rejects markedly different
 * palettes so it doesn't drop recall; the template SAD is the precision gate.
 */
export const COLOR_PALETTE_THRESHOLD = 12;
