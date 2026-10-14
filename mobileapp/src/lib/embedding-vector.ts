/** L2-normalize into a packed Float32Array; undefined when empty / non-finite. */
export const l2NormalizeEmbedding = (
    data: ArrayLike<number>,
): Float32Array | undefined => {
    let norm = 0;
    // Indexed: ArrayLike is not necessarily Iterable.
    // eslint-disable-next-line @typescript-eslint/prefer-for-of -- ArrayLike
    for (let i = 0; i < data.length; i += 1) {
        const value = data[i]!;
        norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) {
        return undefined;
    }
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
        out[i] = Math.round((data[i]! / norm) * 1e5) / 1e5;
    }
    return out;
};
