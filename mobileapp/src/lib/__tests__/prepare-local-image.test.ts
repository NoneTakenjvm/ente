/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as compressModule from "@/lib/compress";
import { DEFAULT_JPEG_QUALITY } from "@/lib/compress";
import { prepareLocalImage } from "@/lib/prepare-local-image";

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
});
