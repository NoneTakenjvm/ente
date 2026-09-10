import { describe, expect, it } from "vitest";
import {
    bitrateForVideoCrf,
    evenOutputSize,
    isWebCodecsVideoEncoderAvailable,
} from "@/lib/transcode/webcodecs-h264";

describe("evenOutputSize", () => {
    it("forces even dimensions", () => {
        expect(evenOutputSize(1921, 1081)).toEqual({ width: 1920, height: 1080 });
    });

    it("caps the long edge and keeps even sizes", () => {
        expect(evenOutputSize(3840, 2160, 1280)).toEqual({
            width: 1280,
            height: 720,
        });
    });
});

describe("bitrateForVideoCrf", () => {
    it("uses a higher bitrate at CRF 18 than CRF 32", () => {
        const high = bitrateForVideoCrf(1920, 1080, 30, 18);
        const low = bitrateForVideoCrf(1920, 1080, 30, 32);
        expect(high).toBeGreaterThan(low);
        expect(low).toBeGreaterThanOrEqual(150_000);
    });
});

describe("isWebCodecsVideoEncoderAvailable", () => {
    it("is false in the Node test environment", () => {
        expect(isWebCodecsVideoEncoderAvailable()).toBe(false);
    });
});
