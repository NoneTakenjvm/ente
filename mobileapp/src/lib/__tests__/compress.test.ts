import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import {
    buildCompressedOrganizerTags,
    canCompress,
    canCompressMedia,
    compressManageCandidates,
    compressedReplaceTitle,
    encodeCompressedStillFromBytes,
    CompressionSkippedError,
    filterCompressCandidatesByMinSize,
    fileByteSize,
    formatSizeDelta,
    isAlreadyCompressed,
    isCompressibleMediaType,
    isWorthReplacing,
    sortCompressCandidatesBySize,
    MIN_SIZE_FILTER_PRESETS,
    DEFAULT_MIN_SIZE_BYTES,
    COMPRESSED_TAG,
} from "@/lib/compress";

const fileWithTags = (
    id: number,
    fileType: number,
    tags: string[],
    title = "vacation.png",
    fileSize?: number,
): EnteFile =>
    ({
        id,
        collectionID: 1,
        key: "key",
        info: fileSize !== undefined ? { fileSize } : undefined,
        metadata: {
            fileType,
            title,
            creationTime: 1,
            modificationTime: 1,
        },
        pubMagicMetadata: tags.length ?
            {
                version: 1,
                count: 1,
                data: {
                    _organizer_v1: { tags, updatedAt: 1 },
                },
            } :
            undefined,
    }) as unknown as EnteFile;

describe("compress", () => {
    it("isCompressibleMediaType allows images and videos", () => {
        expect(
            isCompressibleMediaType(fileWithTags(1, FileType.image, [])),
        ).toBe(true);
        expect(
            isCompressibleMediaType(fileWithTags(1, FileType.video, [])),
        ).toBe(true);
    });

    it("canCompress allows already-compressed images for re-compression", () => {
        expect(
            canCompress(fileWithTags(1, FileType.image, [COMPRESSED_TAG])),
        ).toBe(true);
    });

    it("canCompressMedia allows videos with compressed tag", () => {
        expect(
            canCompressMedia(fileWithTags(1, FileType.video, [COMPRESSED_TAG])),
        ).toBe(true);
    });

    it("isAlreadyCompressed detects the compressed tag", () => {
        expect(
            isAlreadyCompressed(fileWithTags(1, FileType.image, [])),
        ).toBe(false);
        expect(
            isAlreadyCompressed(fileWithTags(1, FileType.image, [COMPRESSED_TAG])),
        ).toBe(true);
    });

    it("compressManageCandidates excludes compressed files by default", () => {
        const files = [
            fileWithTags(1, FileType.image, []),
            fileWithTags(2, FileType.image, [COMPRESSED_TAG]),
        ];
        expect(compressManageCandidates(files, false).map((file) => file.id)).toEqual([
            1,
        ]);
        expect(compressManageCandidates(files, true).map((file) => file.id)).toEqual([
            1, 2,
        ]);
    });

    it("compressManageCandidates excludes archived files", () => {
        const active = fileWithTags(1, FileType.image, []);
        const archived = {
            ...fileWithTags(2, FileType.image, []),
            magicMetadata: {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            },
        } as EnteFile;
        expect(
            compressManageCandidates([active, archived], false).map(
                (file) => file.id,
            ),
        ).toEqual([1]);
    });

    it("buildCompressedOrganizerTags merges source tags", () => {
        expect(
            buildCompressedOrganizerTags(
                fileWithTags(1, FileType.image, ["vacation"]),
            ),
        ).toEqual(["vacation", COMPRESSED_TAG]);
    });

    it("formatSizeDelta reports saved bytes and percent", () => {
        const delta = formatSizeDelta(2 * 1024 * 1024, 800_000);
        expect(delta.savedBytes).toBe(1_297_152);
        expect(delta.savedPercent).toBe(62);
        expect(delta.originalLabel).toContain("MB");
    });

    it("compressedReplaceTitle defaults images to avif", () => {
        expect(compressedReplaceTitle(fileWithTags(1, FileType.image, []))).toBe(
            "vacation.avif",
        );
    });

    it("compressedReplaceTitle uses the encoded extension when given", () => {
        expect(
            compressedReplaceTitle(fileWithTags(1, FileType.image, []), "webp"),
        ).toBe("vacation.webp");
    });

    it("compressedReplaceTitle keeps gif extension", () => {
        expect(
            compressedReplaceTitle(
                fileWithTags(1, FileType.image, [], "animation.gif"),
            ),
        ).toBe("animation.gif");
    });

    it("compressedReplaceTitle uses mp4 for videos", () => {
        expect(
            compressedReplaceTitle(
                fileWithTags(1, FileType.video, [], "clip.mov"),
            ),
        ).toBe("clip.mp4");
    });

    it("sortCompressCandidatesBySize orders largest first", () => {
        const files = [
            fileWithTags(1, FileType.image, [], "small.jpg", 100_000),
            fileWithTags(2, FileType.image, [], "large.jpg", 5_000_000),
            fileWithTags(3, FileType.image, [], "medium.jpg", 1_000_000),
        ];
        expect(
            sortCompressCandidatesBySize(files).map((file) => file.id),
        ).toEqual([2, 3, 1]);
    });

    it("filterCompressCandidatesByMinSize hides small files", () => {
        const files = [
            fileWithTags(1, FileType.image, [], "small.jpg", 100_000),
            fileWithTags(2, FileType.image, [], "large.jpg", 2_000_000),
        ];
        expect(
            filterCompressCandidatesByMinSize(files, 1_024_000).map((file) => file.id),
        ).toEqual([2]);
    });

    it("isWorthReplacing rejects larger outputs", () => {
        expect(isWorthReplacing(1_000_000, 900_000)).toBe(true);
        expect(isWorthReplacing(100_000, 120_000)).toBe(false);
        expect(isWorthReplacing(100_000, 99_000)).toBe(false);
    });

    it("MIN_SIZE_FILTER_PRESETS includes the 800 KB PhotoHoard floor", () => {
        expect(
            MIN_SIZE_FILTER_PRESETS.some(
                (preset) => preset.bytes === DEFAULT_MIN_SIZE_BYTES,
            ),
        ).toBe(true);
    });

    it("fileByteSize reads info.fileSize", () => {
        expect(fileByteSize(fileWithTags(1, FileType.image, [], "a.jpg", 42))).toBe(42);
        expect(fileByteSize(fileWithTags(1, FileType.image, [], "a.jpg"))).toBe(0);
    });

    it("encodeCompressedStillFromBytes skips files under the size floor", async () => {
        await expect(
            encodeCompressedStillFromBytes(new Uint8Array(100), 800 * 1024),
        ).rejects.toBeInstanceOf(CompressionSkippedError);
    });
});
