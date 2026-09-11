import type { EnteFile } from "ente-media/file";
import { fileFileName } from "ente-media/file-metadata";
import type { EncodeJpegResult } from "@/lib/compress";
import { extractTags } from "@/lib/tags";
import { addTagNames } from "@/lib/tag-writes";

export type RotationDegrees = 90 | 180 | 270;

export const ROTATED_TAG = "rotated";

/**
 * Rotate image bytes clockwise by the given angle using canvas.
 */
export const rotateImageBytes = async (
    bytes: Uint8Array,
    mimeType: string,
    degrees: RotationDegrees,
): Promise<EncodeJpegResult> =>
    new Promise((resolve, reject) => {
        const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = (): void => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement("canvas");
            const swap = degrees === 90 || degrees === 270;
            canvas.width = swap ? image.height : image.width;
            canvas.height = swap ? image.width : image.height;
            const context = canvas.getContext("2d");
            if (!context) {
                reject(new Error("Canvas unavailable"));
                return;
            }
            context.translate(canvas.width / 2, canvas.height / 2);
            context.rotate((degrees * Math.PI) / 180);
            context.drawImage(
                image,
                -image.width / 2,
                -image.height / 2,
            );
            canvas.toBlob(
                (jpegBlob) => {
                    if (!jpegBlob) {
                        reject(new Error("Rotate encode failed"));
                        return;
                    }
                    void jpegBlob.arrayBuffer().then((buffer) => {
                        resolve({
                            bytes: new Uint8Array(buffer),
                            width: canvas.width,
                            height: canvas.height,
                        });
                    });
                },
                "image/jpeg",
                0.92,
            );
        };
        image.onerror = (): void => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not decode image for rotation"));
        };
        image.src = url;
    });

/**
 * Merge source organizer tags and ensure the rotated tag is present.
 */
export const buildRotatedOrganizerTags = (sourceFile: EnteFile): string[] =>
    addTagNames(extractTags(sourceFile), ROTATED_TAG);

/**
 * Derive the replacement title for a rotated image (basename, .jpg).
 */
export const rotatedReplaceTitle = (sourceFile: EnteFile): string => {
    const baseName = fileFileName(sourceFile).replace(/\.[^.]+$/u, "");
    return `${baseName}.jpg`;
};
