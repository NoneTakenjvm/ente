/**
 * Even width/height for libx264-compatible output, optionally capped on the long edge.
 *
 * Lives apart from `webcodecs-h264` so the mediabunny bundle can stay out of
 * the initial chunk; callers that only need sizes import this module.
 */
export const evenOutputSize = (
    width: number,
    height: number,
    maxLongEdge?: number,
): { width: number; height: number } => {
    let nextWidth = Math.max(0, width);
    let nextHeight = Math.max(0, height);
    if (maxLongEdge && maxLongEdge > 0 && Math.max(nextWidth, nextHeight) > maxLongEdge) {
        const scale = maxLongEdge / Math.max(nextWidth, nextHeight);
        nextWidth = Math.round(nextWidth * scale);
        nextHeight = Math.round(nextHeight * scale);
    }
    nextWidth -= nextWidth % 2;
    nextHeight -= nextHeight % 2;
    return {
        width: Math.max(2, nextWidth),
        height: Math.max(2, nextHeight),
    };
};
