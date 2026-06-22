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

const popcountNibble = (value: number): number => {
    let count = 0;
    let n = value;
    while (n > 0) {
        count += n & 1;
        n >>= 1;
    }
    return count;
};

/**
 * Hamming distance between two 64-bit dHash hex strings.
 */
export const hammingDistance = (left: string, right: string): number => {
    let distance = 0;
    for (let i = 0; i < left.length; i++) {
        const xor = Number.parseInt(left[i]!, 16) ^ Number.parseInt(right[i]!, 16);
        distance += popcountNibble(xor);
    }
    return distance;
};

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
