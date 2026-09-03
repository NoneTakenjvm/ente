/**
 * Compute dHash hex string from greyscale luminance samples (9×8 grid).
 *
 * Internally packs 64 bits into two uint32s ({@link PackedDHash}); hex is the
 * persistence / wire form. Stage-1 compares use {@link hammingDistancePacked}.
 */

/** 64-bit dHash as two unsigned 32-bit limbs (high = bits 63–32, low = 31–0). */
export type PackedDHash = {
    high: number;
    low: number;
};

/**
 * Compute dHash hex string from greyscale luminance samples (9×8 grid).
 */
export const computeDHashFromLuminance = (
    samples: Uint8Array,
    width: number,
    height: number,
): string => {
    if (width !== 9 || height !== 8 || samples.length !== width * height) {
        throw new Error("dHash expects 9×8 luminance samples");
    }

    let low = 0;
    let high = 0;
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const bitIndex = row * 8 + col;
            const left = samples[row * width + col]!;
            const right = samples[row * width + col + 1]!;
            if (left <= right) {
                continue;
            }
            if (bitIndex < 32) {
                low |= 1 << bitIndex;
            } else {
                high |= 1 << (bitIndex - 32);
            }
        }
    }

    return (
        (high >>> 0).toString(16).padStart(8, "0") +
        (low >>> 0).toString(16).padStart(8, "0")
    );
};

/** SWAR popcount for a 32-bit unsigned integer. */
const popcount32 = (value: number): number => {
    let x = value >>> 0;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    x = x + (x >>> 8);
    x = x + (x >>> 16);
    return x & 0x3f;
};

/**
 * Parse a 16-char dHash hex string into packed limbs.
 * Invalid nibbles are treated as 0 (matches legacy string Hamming behaviour).
 */
export const parseDHashHex = (hex: string): PackedDHash => {
    let high = 0;
    let low = 0;
    for (let i = 0; i < 8; i++) {
        const nibble = Number.parseInt(hex[i] ?? "0", 16);
        if (!Number.isNaN(nibble)) {
            high |= nibble << ((7 - i) * 4);
        }
    }
    for (let i = 0; i < 8; i++) {
        const nibble = Number.parseInt(hex[8 + i] ?? "0", 16);
        if (!Number.isNaN(nibble)) {
            low |= nibble << ((7 - i) * 4);
        }
    }
    return { high: high >>> 0, low: low >>> 0 };
};

/** Hamming distance between two packed 64-bit dHashes. */
export const hammingDistancePacked = (
    left: PackedDHash,
    right: PackedDHash,
): number =>
    popcount32(left.high ^ right.high) + popcount32(left.low ^ right.low);

/**
 * Hamming distance between two 64-bit dHash hex strings.
 * Prefer {@link hammingDistancePacked} in hot loops after parsing once.
 */
export const hammingDistance = (left: string, right: string): number =>
    hammingDistancePacked(parseDHashHex(left), parseDHashHex(right));

/**
 * Minimum Hamming distance across orientation/mirror variant sets.
 * Compares primary (index 0) first; exits early when an exact match is found.
 */
export const variantHammingDistance = (
    left: PackedDHash[],
    right: PackedDHash[],
): number => {
    if (left.length === 0 || right.length === 0) {
        return Number.MAX_SAFE_INTEGER;
    }

    let best = hammingDistancePacked(left[0]!, right[0]!);
    if (best === 0) {
        return 0;
    }

    for (let i = 0; i < left.length; i++) {
        const leftHash = left[i]!;
        for (let j = 0; j < right.length; j++) {
            if (i === 0 && j === 0) {
                continue;
            }
            const distance = hammingDistancePacked(leftHash, right[j]!);
            if (distance < best) {
                best = distance;
                if (best === 0) {
                    return 0;
                }
            }
        }
    }
    return best;
};

/**
 * Minimum Hamming across hex variant arrays (parses once per call).
 * Prefer packing outside the loop when comparing many pairs.
 */
export const variantHammingDistanceHex = (
    left: string[],
    right: string[],
): number =>
    variantHammingDistance(
        left.map(parseDHashHex),
        right.map(parseDHashHex),
    );

/**
 * Average-channel luminance grid for dHash (9×8) from RGBA ImageData pixels.
 */
export const luminanceGridFromImageData = (
    data: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
): Uint8Array => {
    const targetWidth = 9;
    const targetHeight = 8;
    const samples = new Uint8Array(targetWidth * targetHeight);

    for (let row = 0; row < targetHeight; row++) {
        for (let col = 0; col < targetWidth; col++) {
            const sourceX = Math.min(
                sourceWidth - 1,
                Math.floor((col * sourceWidth) / targetWidth),
            );
            const sourceY = Math.min(
                sourceHeight - 1,
                Math.floor((row * sourceHeight) / targetHeight),
            );
            const index = (sourceY * sourceWidth + sourceX) * 4;
            const r = data[index]!;
            const g = data[index + 1]!;
            const b = data[index + 2]!;
            samples[row * targetWidth + col] = Math.round(
                0.299 * r + 0.587 * g + 0.114 * b,
            );
        }
    }

    return samples;
};

export const computeDHashFromImageData = (
    data: Uint8ClampedArray,
    width: number,
    height: number,
): string => {
    const samples = luminanceGridFromImageData(data, width, height);
    return computeDHashFromLuminance(samples, 9, 8);
};
