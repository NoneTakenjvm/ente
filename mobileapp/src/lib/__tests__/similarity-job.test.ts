import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import { imageFilesForPhash } from "@/lib/similarity-job";

const userId = 1;

const imageFile = (id: number, archived = false): EnteFile =>
    ({
        id,
        ownerID: userId,
        collectionID: 1,
        metadata: {
            fileType: FileType.image,
            title: `photo-${id}.jpg`,
            creationTime: id,
            modificationTime: id,
        },
        magicMetadata: archived ?
            {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            } :
            undefined,
    }) as unknown as EnteFile;

describe("imageFilesForPhash", () => {
    it("keeps owned still images and skips archived", () => {
        const files = [
            imageFile(1),
            imageFile(2, true),
            {
                ...imageFile(3),
                ownerID: 99,
            } as EnteFile,
            {
                ...imageFile(4),
                metadata: {
                    fileType: FileType.video,
                    title: "clip.mp4",
                    creationTime: 4,
                    modificationTime: 4,
                },
            } as EnteFile,
        ];
        expect(imageFilesForPhash(files, userId).map((file) => file.id)).toEqual(
            [1],
        );
    });
});
