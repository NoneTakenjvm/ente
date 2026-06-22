import type { EncodeJpegResult } from "@/lib/compress";

export type RotationDegrees = 90 | 180 | 270;

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

export const rotatedUploadTitle = (title: string): string => {
    const baseName = title.replace(/\.[^.]+$/u, "");
    return `${baseName}-rotated.jpg`;
};
