/**
 * Gzip helpers for Ente `mldata` payloads (CompressionStream / DecompressionStream).
 */

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
    // Copy into a plain ArrayBuffer-backed view — Blob rejects SharedArrayBuffer views.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const decompressed = new Blob([copy])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).text();
};
