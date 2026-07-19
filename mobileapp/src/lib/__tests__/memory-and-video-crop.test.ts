import { describe, expect, it } from "vitest";
import { blobFromUint8Array } from "@/lib/bytes-blob";
import {
    formatBytesShort,
    isJsHeapUnderPressure,
    readJsHeapSnapshot,
    type JsHeapSnapshot,
} from "@/lib/memory-probe";
import { normalizeVideoCropRect } from "@/lib/video-edit";

describe("blobFromUint8Array", () => {
    it("creates a blob with the given type and byte length", async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const blob = blobFromUint8Array(bytes, "application/octet-stream");
        expect(blob.type).toBe("application/octet-stream");
        expect(blob.size).toBe(4);
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    });
});

describe("memory-probe", () => {
    it("formatBytesShort formats common magnitudes", () => {
        expect(formatBytesShort(512)).toBe("512B");
        expect(formatBytesShort(2048)).toBe("2.0KB");
        expect(formatBytesShort(5 * 1024 * 1024)).toBe("5.0MB");
    });

    it("isJsHeapUnderPressure uses the soft ratio", () => {
        const ok: JsHeapSnapshot = {
            usedJsHeapBytes: 50,
            totalJsHeapBytes: 80,
            jsHeapSizeLimitBytes: 100,
            usedRatio: 0.5,
        };
        const hot: JsHeapSnapshot = {
            ...ok,
            usedRatio: 0.75,
        };
        expect(isJsHeapUnderPressure(ok)).toBe(false);
        expect(isJsHeapUnderPressure(hot)).toBe(true);
    });

    it("readJsHeapSnapshot returns undefined or a valid shape", () => {
        const snapshot = readJsHeapSnapshot();
        if (snapshot === undefined) {
            expect(snapshot).toBeUndefined();
            return;
        }
        expect(snapshot.usedJsHeapBytes).toBeGreaterThanOrEqual(0);
        expect(snapshot.jsHeapSizeLimitBytes).toBeGreaterThan(0);
        expect(snapshot.usedRatio).toBeGreaterThanOrEqual(0);
    });
});

describe("normalizeVideoCropRect", () => {
    it("forces even dimensions and clamps inside the frame", () => {
        expect(
            normalizeVideoCropRect(
                { x: 1, y: 1, width: 101, height: 51 },
                { width: 1920, height: 1080 },
            ),
        ).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    });

    it("clamps oversized crops to the source frame", () => {
        const rect = normalizeVideoCropRect(
            { x: 1900, y: 1000, width: 80, height: 80 },
            { width: 1920, height: 1080 },
        );
        expect(rect.x + rect.width).toBeLessThanOrEqual(1920);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1080);
        expect(rect.width % 2).toBe(0);
        expect(rect.height % 2).toBe(0);
    });
});
