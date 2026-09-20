/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as compressModule from "@/lib/compress";
import { DEFAULT_JPEG_QUALITY } from "@/lib/compress";
import { prepareLocalImage } from "@/lib/prepare-local-image";

vi.mock("ente-media/heic-convert", () => ({
    heicToJPEG: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], {
        type: "image/jpeg",
    })),
}));

vi.mock("@/lib/compress", async () => {
    const actual = await vi.importActual<typeof compressModule>("@/lib/compress");
    return {
        ...actual,
        encodeJpegFromBytes: vi.fn(actual.encodeJpegFromBytes),
    };
});

const mockEncodeJpegFromBytes = vi.mocked(compressModule.encodeJpegFromBytes);

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);

afterEach(() => {
    vi.restoreAllMocks();
    mockEncodeJpegFromBytes.mockReset();
});

describe("prepareLocalImage", () => {
    it("passes through JPEG bytes without re-encoding", async () => {
        const bitmapClose = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({
                width: 4032,
                height: 3024,
                close: bitmapClose,
            })),
        );

        const file = new File([jpegBytes], "photo.jpg", { type: "image/jpeg" });
        const prepared = await prepareLocalImage(file);

        expect(mockEncodeJpegFromBytes).not.toHaveBeenCalled();
        expect(prepared).toEqual({
            bytes: jpegBytes,
            width: 4032,
            height: 3024,
        });
        expect(bitmapClose).toHaveBeenCalledOnce();
    });

    it("re-encodes non-JPEG sources", async () => {
        const pngBytes = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        mockEncodeJpegFromBytes.mockResolvedValue({
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
            width: 100,
            height: 80,
        });

        const file = new File([pngBytes], "photo.png", { type: "image/png" });
        const prepared = await prepareLocalImage(file);

        expect(mockEncodeJpegFromBytes).toHaveBeenCalledWith(
            pngBytes,
            DEFAULT_JPEG_QUALITY,
        );
        expect(prepared.width).toBe(100);
    });

    it("converts HEIC via heicToJPEG instead of the compress worker", async () => {
        const { heicToJPEG } = await import("ente-media/heic-convert");
        const bitmapClose = vi.fn();
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({
                width: 200,
                height: 100,
                close: bitmapClose,
            })),
        );

        // ftyp box with heic brand (see detectImageFormatFromBytes).
        const heicBytes = new Uint8Array([
            0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
        ]);
        const file = new File([heicBytes], "photo.heic", { type: "image/heic" });
        const prepared = await prepareLocalImage(file);

        expect(heicToJPEG).toHaveBeenCalledOnce();
        expect(mockEncodeJpegFromBytes).not.toHaveBeenCalled();
        expect(prepared.width).toBe(200);
        expect(prepared.height).toBe(100);
        expect(bitmapClose).toHaveBeenCalledOnce();
    });
});
