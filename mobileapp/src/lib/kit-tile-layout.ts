/**
 * Square tile grid for the kit nearness tile-embedding pilot.
 *
 * MobileCLIP-S2 sees a 256×256 centre crop of the thumbnail, so a small kit
 * item loses most of its pixels and, near the edges, drops out of frame
 * entirely. Tiles with side = shortest edge ÷ 3 cover the whole frame (the
 * last row / column is snapped to the far edge, overlapping its neighbour) and
 * hand each region to the model at roughly the thumbnail's native resolution.
 *
 * Research: `scripts/kit-nearness-s2-research.md`, pass 5 "avenue 6".
 */

/** Bumping this invalidates stored tile embeddings and corpus sidecars. */
export const KIT_TILE_LAYOUT_ID = "thirds-v1";

export type KitTileRect = { x: number; y: number; size: number };

export type KitTileGrid = {
    rows: number;
    columns: number;
    /** Row-major, `rows × columns` entries. */
    rects: KitTileRect[];
};

/**
 * Row-major square tiles covering a `width × height` image.
 *
 * 3:2 → 3×5, 4:3 → 3×4, square → 3×3, 16:9 → 3×6 (portraits transposed).
 */
export const kitTileGrid = (width: number, height: number): KitTileGrid => {
    const size = Math.max(1, Math.floor(Math.min(width, height) / 3));
    const rows = Math.ceil(height / size);
    const columns = Math.ceil(width / size);
    const rects: KitTileRect[] = [];
    for (let row = 0; row < rows; row += 1) {
        const y = Math.min(row * size, height - size);
        for (let column = 0; column < columns; column += 1) {
            rects.push({ x: Math.min(column * size, width - size), y, size });
        }
    }
    return { rows, columns, rects };
};
