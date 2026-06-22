/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { installCanvasPolyfill } from "@/lib/__tests__/canvas-setup";
import { encodeCroppedJpeg } from "@/lib/crop";
import {
    bakeRotation,
    encodeBakedCrop,
    fullFramePixelCrop,
} from "@/lib/crop-editor";
import { rotateImageBytes } from "@/lib/rotate";

beforeAll(() => {
    installCanvasPolyfill();
});

const quadrantFixturePng = (): Uint8Array =>
    new Uint8Array(
        readFileSync(
            join(__dirname, "fixtures", "quadrant-4x2.png"),
        ),
    );

const decodeJpegSize = (
    bytes: Uint8Array,
): Promise<{ width: number; height: number }> =>
    new Promise((resolve, reject) => {
        const url = URL.createObjectURL(
            new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
        );
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(url);
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
        };
        image.onerror = (): void => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not decode JPEG"));
        };
        image.src = url;
    });

describe("rotateImageBytes", () => {
    it("swaps dimensions on 90° rotation", async () => {
        const source = quadrantFixturePng();
        const rotated = await rotateImageBytes(source, "image/png", 90);
        expect(rotated.width).toBe(2);
        expect(rotated.height).toBe(4);
        expect(rotated.bytes.length).toBeGreaterThan(0);
    });

    it("swaps dimensions on 270° rotation", async () => {
        const source = quadrantFixturePng();
        const rotated = await rotateImageBytes(source, "image/png", 270);
        expect(rotated.width).toBe(2);
        expect(rotated.height).toBe(4);
    });

    it("preserves dimensions on 180° rotation", async () => {
        const source = quadrantFixturePng();
        const rotated = await rotateImageBytes(source, "image/png", 180);
        expect(rotated.width).toBe(4);
        expect(rotated.height).toBe(2);
    });
});

describe("baked rotate + crop pipeline (editor path)", () => {
    it("crop after 90° rotation uses rotated dimensions", async () => {
        const source = quadrantFixturePng();
        const rotated = await bakeRotation(source, "image/png", 90);

        const cropped = await encodeBakedCrop(
            rotated.bytes,
            fullFramePixelCrop(1, 2),
            {
                width: 2,
                height: 4,
                naturalWidth: 2,
                naturalHeight: 4,
            },
        );

        expect(cropped.width).toBe(1);
        expect(cropped.height).toBe(2);
    });

    it("full-frame crop after rotate preserves rotated size", async () => {
        const source = quadrantFixturePng();
        const rotated = await bakeRotation(source, "image/png", 90);

        const cropped = await encodeBakedCrop(
            rotated.bytes,
            fullFramePixelCrop(rotated.width, rotated.height),
            {
                width: rotated.width,
                height: rotated.height,
                naturalWidth: rotated.width,
                naturalHeight: rotated.height,
            },
        );

        expect(cropped.width).toBe(2);
        expect(cropped.height).toBe(4);
    });

    it("double 90° rotation returns to original dimensions", async () => {
        const source = quadrantFixturePng();
        const once = await bakeRotation(source, "image/png", 90);
        const twice = await bakeRotation(once.bytes, "image/jpeg", 90);

        expect(twice.width).toBe(4);
        expect(twice.height).toBe(2);
    });

    it("partial crop on unrotated source matches requested region size", async () => {
        const source = quadrantFixturePng();
        const cropped = await encodeBakedCrop(
            source,
            fullFramePixelCrop(2, 1),
            {
                width: 4,
                height: 2,
                naturalWidth: 4,
                naturalHeight: 2,
            },
        );

        expect(cropped.width).toBe(2);
        expect(cropped.height).toBe(1);
    });
});

describe("CSS-rotate encode regression (old broken path)", () => {
    it("encodeCroppedJpeg with rotation=90 misaligns crop rect from display space", async () => {
        const source = quadrantFixturePng();

        const baked = await encodeBakedCrop(
            (await bakeRotation(source, "image/png", 90)).bytes,
            fullFramePixelCrop(1, 2),
            {
                width: 2,
                height: 4,
                naturalWidth: 2,
                naturalHeight: 4,
            },
        );

        const cssStyle = await encodeCroppedJpeg(
            source,
            { x: 0, y: 0, width: 2, height: 1 },
            undefined,
            90,
        );

        expect(baked.width).toBe(1);
        expect(baked.height).toBe(2);
        expect(cssStyle.width).not.toBe(baked.width);
        expect(cssStyle.height).not.toBe(baked.height);
    });
});

describe("decode sanity", () => {
    it("encodeBakedCrop output is a valid JPEG", async () => {
        const source = quadrantFixturePng();
        const cropped = await encodeBakedCrop(
            source,
            fullFramePixelCrop(4, 2),
            {
                width: 4,
                height: 2,
                naturalWidth: 4,
                naturalHeight: 2,
            },
        );

        const size = await decodeJpegSize(cropped.bytes);
        expect(size).toEqual({ width: 4, height: 2 });
    });
});
