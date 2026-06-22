/**
 * Login with the dev test account, decrypt sample images, and measure mozjpeg
 * compression vs the old canvas-style baseline (fixed quality, no size search).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/test-compress-encode.ts
 */
import decodeJpeg from "@jsquash/jpeg/decode";
import encodeJpeg from "@jsquash/jpeg/encode";
import decodePng from "@jsquash/png/decode";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { getEnteCore } from "../src/core/instance";
import { testAccountCredentials } from "../src/dev/test-account";
import {
    detectImageFormatFromBytes,
    type DetectedImageFormat,
    fileByteSize,
    isWorthReplacing,
} from "../src/lib/compress";

const qualitySteps = (targetPercent: number): number[] => {
    const steps: number[] = [];
    for (let quality = targetPercent; quality >= 45; quality -= 10) {
        steps.push(quality);
    }
    return steps;
};

const decodeToImageData = async (
    bytes: Uint8Array,
    format: DetectedImageFormat,
): Promise<ImageData> => {
    const buffer = bytes.slice().buffer;
    if (format === "jpeg") {
        return decodeJpeg(buffer);
    }
    if (format === "png") {
        return decodePng(buffer);
    }
    throw new Error(`Unsupported format in script: ${format}`);
};

const mozjpegAdaptive = async (
    bytes: Uint8Array,
    format: DetectedImageFormat,
    targetPercent = 85,
): Promise<{ outputBytes: number; quality: number }> => {
    const imageData = await decodeToImageData(bytes, format);
    let best = { outputBytes: Number.POSITIVE_INFINITY, quality: targetPercent };
    for (const stepQuality of qualitySteps(targetPercent)) {
        const buffer = await encodeJpeg(imageData, { quality: stepQuality });
        const size = buffer.byteLength;
        if (size < best.outputBytes) {
            best = { outputBytes: size, quality: stepQuality };
        }
        if (size < bytes.length) {
            return { outputBytes: size, quality: stepQuality };
        }
    }
    return best;
};

const formatKb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

const main = async (): Promise<void> => {
    const core = getEnteCore();
    console.log("Logging in…");
    await core.login(testAccountCredentials);

    console.log("Syncing library…");
    const files = await core.syncLibrary({});
    const images = files
        .filter((file) => file.metadata.fileType === FileType.image)
        .sort((a, b) => fileByteSize(b) - fileByteSize(a));

    const samples: EnteFile[] = [];
    const smallJpeg = images.find((file) => {
        const size = fileByteSize(file);
        return size >= 300_000 && size <= 700_000;
    });
    const large = images.find((file) => fileByteSize(file) >= 1_500_000);
    if (smallJpeg) {
        samples.push(smallJpeg);
    }
    if (large && large.id !== smallJpeg?.id) {
        samples.push(large);
    }
    if (samples.length === 0) {
        samples.push(...images.slice(0, 3));
    }

    console.log(`Testing ${samples.length} image(s)…\n`);

    for (const file of samples) {
        try {
            const bytes = await core.getDecryptedFile(file);
            const format = detectImageFormatFromBytes(bytes);
            const startedAt = performance.now();

            if (format !== "jpeg" && format !== "png") {
                console.log(
                    `- ${file.metadata.title} (${formatKb(bytes.length)}, ${format}): skipped`,
                );
                continue;
            }

            const imageData = await decodeToImageData(bytes, format);
            const fixedBuffer = await encodeJpeg(imageData, { quality: 85 });
            const adaptive = await mozjpegAdaptive(bytes, format, 85);
            const durationMs = Math.round(performance.now() - startedAt);

            console.log(`- ${file.metadata.title}`);
            console.log(`  input:     ${formatKb(bytes.length)} (${format})`);
            console.log(
                `  fixed@85:  ${formatKb(fixedBuffer.byteLength)} (ratio ${(fixedBuffer.byteLength / bytes.length).toFixed(2)}x)`,
            );
            console.log(
                `  mozjpeg:   ${formatKb(adaptive.outputBytes)} @ q${adaptive.quality} (ratio ${(adaptive.outputBytes / bytes.length).toFixed(2)}x)`,
            );
            console.log(
                `  worth it:  ${isWorthReplacing(bytes.length, adaptive.outputBytes) ? "yes" : "no"}`,
            );
            console.log(`  time:      ${durationMs} ms\n`);
        } catch (error: unknown) {
            console.log(
                `- ${file.metadata.title}: ERROR ${error instanceof Error ? error.message : error}`,
            );
        }
    }
};

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
