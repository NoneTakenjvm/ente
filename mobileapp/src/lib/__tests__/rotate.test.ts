import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import {
    buildRotatedOrganizerTags,
    rotatedReplaceTitle,
} from "@/lib/rotate";

const fileWithTags = (id: number, tags: string[]): EnteFile =>
    ({
        id,
        metadata: { title: "photo.heic", fileType: 0 },
        pubMagicMetadata: {
            version: 1,
            count: 1,
            data: {
                _organizer_v1: { tags, updatedAt: 1 },
            },
        },
    }) as EnteFile;

describe("rotate helpers", () => {
    it("buildRotatedOrganizerTags merges source tags", () => {
        expect(buildRotatedOrganizerTags(fileWithTags(1, ["kit", "cropped"]))).toEqual(
            ["kit", "cropped", "rotated"],
        );
    });

    it("rotatedReplaceTitle keeps basename as jpg", () => {
        expect(rotatedReplaceTitle(fileWithTags(1, []))).toBe("photo.jpg");
    });
});
