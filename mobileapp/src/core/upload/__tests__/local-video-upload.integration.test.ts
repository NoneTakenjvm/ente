/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptMetadataJSON, generateKey } from "ente-base/crypto";
import { decryptMagicMetadata } from "ente-media/magic-metadata";
import type { Collection } from "ente-media/collection";
import { FileType } from "ente-media/file-type";
import type { HttpClient } from "@/core/api/http";
import { uploadLocalVideo } from "@/core/upload/upload-video";
import { prepareLocalVideo } from "@/lib/transcode/prepare-local-video";

const {
    mockExtractVideoFrameJpeg,
    mockGenerateImageThumbnail,
    mockTakeUploadURL,
    mockPutFile,
    mockPostEnteFile,
} = vi.hoisted(() => ({
    mockExtractVideoFrameJpeg: vi.fn(),
    mockGenerateImageThumbnail: vi.fn(),
    mockTakeUploadURL: vi.fn(),
    mockPutFile: vi.fn(),
    mockPostEnteFile: vi.fn(),
}));

vi.mock("@/lib/ffmpeg", () => ({
    extractVideoFrameJpeg: mockExtractVideoFrameJpeg,
}));

vi.mock("@/core/upload/thumbnail", () => ({
    generateImageThumbnail: mockGenerateImageThumbnail,
}));

vi.mock("@/core/upload/upload-url-pool", () => ({
    takeUploadURL: mockTakeUploadURL,
    markBatchUploadFileComplete: vi.fn(),
}));

vi.mock("@/core/upload/remote", () => ({
    putFile: mockPutFile,
    postEnteFile: mockPostEnteFile,
}));

const http = {} as HttpClient;

const stubVideoProbe = (width: number, height: number, duration: number): void => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
        if (tag !== "video") {
            return originalCreateElement(tag);
        }
        const element = document.createElement.bind(document)("div");
        const video = element as unknown as HTMLVideoElement;
        Object.defineProperty(video, "videoWidth", { value: width });
        Object.defineProperty(video, "videoHeight", { value: height });
        Object.defineProperty(video, "duration", { value: duration });
        Object.defineProperty(video, "src", {
            set(): void {
                queueMicrotask(() => video.onloadedmetadata?.(new Event("loadedmetadata")));
            },
        });
        return video;
    });
};

afterEach(() => {
    vi.restoreAllMocks();
    mockExtractVideoFrameJpeg.mockReset();
    mockGenerateImageThumbnail.mockReset();
    mockTakeUploadURL.mockReset();
    mockPutFile.mockReset();
    mockPostEnteFile.mockReset();
});

describe("local video upload pipeline", () => {
    it("prepares device video then uploads encrypted video metadata", async () => {
        const collectionKey = await generateKey();
        const collection = {
            id: 42,
            key: collectionKey,
        } as Collection;

        const sourceBytes = new Uint8Array([5, 6, 7]);
        const frameJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
        const thumbnail = new Uint8Array([1, 2, 3]);

        mockExtractVideoFrameJpeg.mockResolvedValue(frameJpeg);
        mockGenerateImageThumbnail.mockResolvedValue(thumbnail);
        stubVideoProbe(1920, 1080, 8.2);

        mockTakeUploadURL
            .mockResolvedValueOnce({ objectKey: "file-object", url: "https://upload/file" })
            .mockResolvedValueOnce({ objectKey: "thumb-object", url: "https://upload/thumb" });
        mockPutFile.mockResolvedValue(undefined);
        mockPostEnteFile.mockImplementation(async (_http, request) => ({
            id: 9001,
            collectionID: request.collectionID,
            ownerID: 1,
            updationTime: 1,
            encryptedKey: request.encryptedKey,
            keyDecryptionNonce: request.keyDecryptionNonce,
            metadata: request.metadata,
            pubMagicMetadata: request.pubMagicMetadata,
            file: {
                objectKey: request.file.objectKey,
                decryptionHeader: request.file.decryptionHeader,
                size: request.file.size,
            },
            thumbnail: {
                objectKey: request.thumbnail.objectKey,
                decryptionHeader: request.thumbnail.decryptionHeader,
                size: request.thumbnail.size,
            },
            isDeleted: false,
        }));

        const source = new File(sourceBytes, "holiday.mov", {
            type: "video/quicktime",
        });
        const prepared = await prepareLocalVideo(source);

        const uploaded = await uploadLocalVideo(http, collection, prepared.bytes, {
            title: "holiday.mov",
            creationTime: 1_700_000_000_000,
            width: prepared.width,
            height: prepared.height,
            duration: prepared.duration,
            mimeType: prepared.mimeType,
        });

        expect(mockExtractVideoFrameJpeg).toHaveBeenCalledWith(
            prepared.bytes,
            "video/quicktime",
        );
        expect(mockPutFile).toHaveBeenCalledTimes(2);
        expect(mockPostEnteFile).toHaveBeenCalledOnce();

        expect(uploaded.metadata.fileType).toBe(FileType.video);
        expect(uploaded.metadata.title).toBe("holiday.mov");
        expect(uploaded.metadata.duration).toBe(8);
        expect(uploaded.pubMagicMetadata?.data).toMatchObject({
            w: 1920,
            h: 1080,
        });

        const posted = mockPostEnteFile.mock.calls[0]![1];
        const decryptedMetadata = await decryptMetadataJSON(
            posted.metadata,
            uploaded.key,
        );
        expect(decryptedMetadata).toMatchObject({
            fileType: FileType.video,
            title: "holiday.mov",
            duration: 8,
        });

        if (!posted.pubMagicMetadata) {
            throw new Error("Expected pubMagicMetadata on upload request");
        }
        const decryptedPubMagic = await decryptMagicMetadata(
            posted.pubMagicMetadata,
            uploaded.key,
        );
        const pubData = decryptedPubMagic.data as Record<string, unknown>;
        expect(pubData).toMatchObject({ w: 1920, h: 1080 });
        expect(pubData.uploadedAt).toEqual(expect.any(Number));
        expect(pubData.editedAt).toEqual(expect.any(Number));
    });
});
