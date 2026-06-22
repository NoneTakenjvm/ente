import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import {
    buildCompressedOrganizerTags,
    canCompress,
    canCompressMedia,
    compressManageCandidates,
    compressedReplaceTitle,
    formatSizeDelta,
    COMPRESSED_TAG,
    isAlreadyCompressed,
    isCompressibleMediaType,
} from "@/lib/compress";

const fileWithTags = (
    id: number,
    fileType: number,
    tags: string[],
    title = "vacation.png",
): EnteFile =>
    ({
        id,
        collectionID: 1,
        key: "key",
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

    it("compressedReplaceTitle swaps extension for images", () => {
        expect(compressedReplaceTitle(fileWithTags(1, FileType.image, []))).toBe(
            "vacation.jpg",
        );
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
});
