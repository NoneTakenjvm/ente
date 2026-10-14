export type DetectedImageFormat =
    | "jpeg" |
    "png" |
    "webp" |
    "gif" |
    "heic" |
    "avif" |
    "unknown";

/**
 * Detect container format from magic bytes (for encode strategy and diagnostics).
 */
export const detectImageFormatFromBytes = (
    bytes: Uint8Array,
): DetectedImageFormat => {
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "jpeg";
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return "png";
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "webp";
    }
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46
    ) {
        return "gif";
    }
    if (bytes.length >= 12) {
        const brand = String.fromCharCode(
            bytes[4] ?? 0,
            bytes[5] ?? 0,
            bytes[6] ?? 0,
            bytes[7] ?? 0,
        );
        if (brand === "ftyp") {
            const subtype = String.fromCharCode(
                bytes[8] ?? 0,
                bytes[9] ?? 0,
                bytes[10] ?? 0,
                bytes[11] ?? 0,
            );
            if (
                subtype.startsWith("avif") ||
                subtype.startsWith("avis")
            ) {
                return "avif";
            }
            if (
                subtype.startsWith("heic") ||
                subtype.startsWith("heix") ||
                subtype.startsWith("mif1")
            ) {
                return "heic";
            }
        }
    }
    return "unknown";
};
