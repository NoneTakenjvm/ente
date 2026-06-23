import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import {
    buildCroppedOrganizerTags,
    canCrop,
    clampCropRect,
    croppedReplaceTitle,
    croppedUploadTitle,
    CROPPED_TAG,
    pixelCropToSourceRect,
} from "@/lib/crop";

const fileWithTags = (
    id: number,
    fileType: number,
    tags: string[],
): EnteFile =>
    ({
        id,
        collectionID: 1,
        key: "key",
        metadata: {
            fileType,
            title: "vacation.png",
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

describe("crop", () => {
    it("canCrop allows untagged images", () => {
        expect(canCrop(fileWithTags(1, FileType.image, []))).toBe(true);
    });

    it("canCrop allows already-cropped files", () => {
        expect(
            canCrop(fileWithTags(1, FileType.image, [CROPPED_TAG])),
        ).toBe(true);
    });

    it("canCrop rejects non-images", () => {
        expect(canCrop(fileWithTags(1, FileType.video, []))).toBe(false);
    });

    it("croppedUploadTitle appends -cropped.jpg", () => {
        expect(croppedUploadTitle(fileWithTags(1, FileType.image, []))).toBe(
            "vacation-cropped.jpg",
        );
    });

    it("buildCroppedOrganizerTags merges source tags", () => {
        expect(
            buildCroppedOrganizerTags(
                fileWithTags(1, FileType.image, ["vacation", CROPPED_TAG]),
            ),
        ).toEqual(["vacation", CROPPED_TAG]);
    });

    it("croppedReplaceTitle swaps extension for images", () => {
        expect(croppedReplaceTitle(fileWithTags(1, FileType.image, []))).toBe(
            "vacation.jpg",
        );
    });

    it("clampCropRect keeps crop inside image bounds", () => {
        expect(
            clampCropRect({ x: -10, y: 5, width: 500, height: 400 }, 800, 600),
        ).toEqual({ x: 0, y: 5, width: 500, height: 400 });
    });

    it("pixelCropToSourceRect maps display pixels to natural pixels", () => {
        expect(
            pixelCropToSourceRect(
                { x: 10, y: 20, width: 100, height: 50 },
                {
                    width: 400,
                    height: 300,
                    naturalWidth: 800,
                    naturalHeight: 600,
                },
            ),
        ).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    });
});
