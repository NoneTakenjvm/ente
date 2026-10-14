/**
 * Gzip helpers for Ente `mldata` payloads (CompressionStream / DecompressionStream).
 */

import { ensureArrayBufferBacked } from "ente-base/bytes";

/**
 * Gzip-compress a UTF-8 string to bytes.
 */
export const gzipString = async (text: string): Promise<Uint8Array> => {
    const compressed = new Blob([text])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
};

/**
 * Gunzip bytes to a UTF-8 string.
 */
export const gunzipToString = async (
    data: Uint8Array,
): Promise<string> => {
    // Blob rejects SharedArrayBuffer views.
    const decompressed = new Blob([ensureArrayBufferBacked(data)])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).text();
};
