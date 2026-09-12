/**
 * Content-space marquee selection helpers (iOS Photos-style drag-select).
 *
 * Pointer coords are tracked in content space (viewport + scrollTop) so the
 * selection grows correctly when the gallery auto-scrolls at the edges.
 */

export interface MarqueeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MarqueePoint {
    x: number;
    y: number;
}

/** Movement before a pointer drag becomes a marquee (vs a tap). */
export const MARQUEE_ARM_THRESHOLD_PX = 12;

/** Viewport inset where holding the pointer triggers auto-scroll. */
export const MARQUEE_EDGE_ZONE_PX = 48;

/** Max auto-scroll speed at the extreme edge (px per frame at 60fps-ish). */
export const MARQUEE_EDGE_MAX_SPEED_PX = 28;

/** Axis-aligned rect from two content-space points. */
export const normalizeRect = (
    a: MarqueePoint,
    b: MarqueePoint,
): MarqueeRect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
});

/**
 * Arm marquee after any-direction drag past the threshold.
 * Vertical free-scroll is replaced by edge auto-scroll once armed.
 */
export const shouldArmMarquee = (
    dx: number,
    dy: number,
    thresholdPx: number = MARQUEE_ARM_THRESHOLD_PX,
): boolean => Math.abs(dx) >= thresholdPx || Math.abs(dy) >= thresholdPx;

/**
 * Scroll delta for the current pointer Y within the viewport.
 * Negative = scroll up, positive = scroll down, 0 = no edge scroll.
 */
export const marqueeEdgeScrollDelta = (
    pointerY: number,
    viewportHeight: number,
    edgeZonePx: number = MARQUEE_EDGE_ZONE_PX,
    maxSpeedPx: number = MARQUEE_EDGE_MAX_SPEED_PX,
): number => {
    if (viewportHeight <= 0 || edgeZonePx <= 0) {
        return 0;
    }
    if (pointerY < edgeZonePx) {
        const t = 1 - Math.max(0, pointerY) / edgeZonePx;
        return -maxSpeedPx * t;
    }
    const bottomDist = viewportHeight - pointerY;
    if (bottomDist < edgeZonePx) {
        const t = 1 - Math.max(0, bottomDist) / edgeZonePx;
        return maxSpeedPx * t;
    }
    return 0;
};

/** Map a content-space rect into viewport coordinates for the overlay. */
export const contentRectToViewport = (
    rect: MarqueeRect,
    scrollTop: number,
): MarqueeRect => ({
    x: rect.x,
    y: rect.y - scrollTop,
    width: rect.width,
    height: rect.height,
});

/** True when two axis-aligned rects share positive area (not just an edge). */
export const rectsOverlap = (
    a: MarqueeRect,
    b: MarqueeRect,
): boolean =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;

/**
 * Ids whose layout boxes intersect a content-space marquee.
 * Layout `y` values are content coordinates (no scrollTop adjustment).
 */
export const keysInContentMarquee = <T extends string | number>(
    items: ReadonlyArray<{
        key: T;
        x: number;
        y: number;
        width: number;
        height: number;
    }>,
    rect: MarqueeRect,
): T[] => {
    const keys: T[] = [];
    for (const item of items) {
        if (
            rectsOverlap(rect, {
                x: item.x,
                y: item.y,
                width: item.width,
                height: item.height,
            })
        ) {
            keys.push(item.key);
        }
    }
    return keys;
};

/**
 * Grid-layout file/item ids intersecting a content-space marquee.
 */
export const gridIndicesInContentMarquee = (
    itemCount: number,
    columns: number,
    rowHeight: number,
    itemSize: number,
    paddingInline: number,
    gap: number,
    rect: MarqueeRect,
): number[] => {
    const indices: number[] = [];
    const rowCount = Math.ceil(itemCount / columns);
    for (let row = 0; row < rowCount; row += 1) {
        const rowTop = row * rowHeight;
        const rowBottom = rowTop + itemSize;
        if (rowBottom <= rect.y || rowTop >= rect.y + rect.height) {
            continue;
        }
        for (let col = 0; col < columns; col += 1) {
            const index = row * columns + col;
            if (index >= itemCount) {
                break;
            }
            const cellLeft = paddingInline + col * (itemSize + gap);
            if (
                rectsOverlap(rect, {
                    x: cellLeft,
                    y: rowTop,
                    width: itemSize,
                    height: itemSize,
                })
            ) {
                indices.push(index);
            }
        }
    }
    return indices;
};
