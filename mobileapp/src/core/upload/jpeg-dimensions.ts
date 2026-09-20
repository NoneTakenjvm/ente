/**
 * Read width/height from JPEG SOF markers without decoding pixels.
 *
 * Used during upload prepare so we do not pay for {@link createImageBitmap}
 * just to stamp `w`/`h` in public magic metadata.
 */
export const readJpegDimensionsFromBytes = (
    bytes: Uint8Array,
): { width: number; height: number } | undefined => {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return undefined;
    }

    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        const marker = bytes[offset + 1]!;
        // EOI / SOS — stop scanning.
        if (marker === 0xd9 || marker === 0xda) {
            break;
        }
        // Standalone markers without a length field.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }

        const segmentLength = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
            break;
        }

        // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15 (baseline/progressive).
        const isSof =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
            const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
            const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
            if (width > 0 && height > 0) {
                return { width, height };
            }
            return undefined;
        }

        offset += 2 + segmentLength;
    }

    return undefined;
};
