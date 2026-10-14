import { describe, expect, it } from "vitest";
import { formatFileSize } from "@/lib/format";

describe("formatFileSize", () => {
    it("formats common magnitudes", () => {
        expect(formatFileSize(512)).toBe("512 B");
        expect(formatFileSize(2048)).toBe("2 KB");
        expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
        expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    });
});
