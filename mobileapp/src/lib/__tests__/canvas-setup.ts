/**
 * Browser canvas polyfill for crop integration tests.
 */
import {
    createCanvas,
    Image as CanvasImage,
    type Canvas,
    type SKRSContext2D,
} from "@napi-rs/canvas";
import { Buffer } from "node:buffer";

let installed = false;

export const installCanvasPolyfill = (): void => {
    if (installed) {
        return;
    }
    installed = true;

    const canvasBacking = new WeakMap<
        HTMLCanvasElement,
        { canvas: Canvas; context: SKRSContext2D }
    >();

    const bytesByBlob = new WeakMap<Blob, Buffer>();

    const OriginalBlob = globalThis.Blob;
    const PatchedBlob = function PatchedBlob(
        parts?: BlobPart[],
        options?: BlobPropertyBag,
    ): Blob {
        const blob = new OriginalBlob(parts ?? [], options);
        const first = parts?.[0];
        if (first instanceof Uint8Array) {
            bytesByBlob.set(blob, Buffer.from(first));
        } else if (Buffer.isBuffer(first)) {
            bytesByBlob.set(blob, first);
        }
        return blob;
    } as unknown as typeof Blob;
    PatchedBlob.prototype = OriginalBlob.prototype;
    globalThis.Blob = PatchedBlob;

    const syncBackingSize = (element: HTMLCanvasElement): void => {
        let backing = canvasBacking.get(element);
        if (!backing) {
            const canvas = createCanvas(element.width || 1, element.height || 1);
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Canvas 2D unavailable in test polyfill");
            }
            backing = { canvas, context };
            canvasBacking.set(element, backing);
            return;
        }
        if (
            backing.canvas.width !== element.width ||
            backing.canvas.height !== element.height
        ) {
            const canvas = createCanvas(element.width || 1, element.height || 1);
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Canvas 2D unavailable in test polyfill");
            }
            canvasBacking.set(element, { canvas, context });
        }
    };

    HTMLCanvasElement.prototype.getContext = function getContext(
        type: string,
    ): CanvasRenderingContext2D | null {
        if (type !== "2d") {
            return null;
        }
        syncBackingSize(this);
        const backing = canvasBacking.get(this);
        return backing?.context as unknown as CanvasRenderingContext2D;
    };

    HTMLCanvasElement.prototype.toBlob = function toBlob(
        callback: BlobCallback,
        type?: string,
        quality?: number,
    ): void {
        syncBackingSize(this);
        const backing = canvasBacking.get(this);
        if (!backing) {
            callback(null);
            return;
        }
        const mime = type ?? "image/png";
        const buffer =
            mime === "image/jpeg" ?
                backing.canvas.toBuffer("image/jpeg", quality ?? 0.92) :
                backing.canvas.toBuffer("image/png");
        callback(new Blob([buffer], { type: mime }));
    };

    URL.createObjectURL = (blob: Blob): string => {
        const bytes = bytesByBlob.get(blob);
        if (!bytes) {
            throw new Error("createObjectURL: unknown blob in test polyfill");
        }
        const mime = blob.type || "application/octet-stream";
        return `data:${mime};base64,${bytes.toString("base64")}`;
    };

    URL.revokeObjectURL = (): void => {
        // data URLs need no cleanup
    };

    const probeContext = createCanvas(1, 1).getContext("2d");
    if (!probeContext) {
        throw new Error("Canvas 2D unavailable in test polyfill");
    }
    const contextPrototype = Object.getPrototypeOf(probeContext) as SKRSContext2D;
    const originalDrawImage = contextPrototype.drawImage.bind(probeContext);
    contextPrototype.drawImage = function drawImage(
        image: CanvasImage | HTMLCanvasElement,
        ...args: number[]
    ): void {
        if (image instanceof HTMLCanvasElement) {
            syncBackingSize(image);
            const backing = canvasBacking.get(image);
            if (backing) {
                originalDrawImage.call(this, backing.canvas, ...args);
                return;
            }
        }
        originalDrawImage.call(this, image, ...args);
    };

    // @ts-expect-error napi-rs Image replaces happy-dom Image for decode paths
    globalThis.Image = CanvasImage;
};
