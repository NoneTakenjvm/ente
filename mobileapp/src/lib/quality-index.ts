import { loadKv, saveKv } from "@/db/kv";
import { QUALITY_INDEX_VERSION } from "@/lib/image-quality";

/**
 * Load the encrypted quality index, or an empty map when missing/stale.
 *
 * [Note: quality index version] Scores are discarded when
 * `persisted.version !== QUALITY_INDEX_VERSION` so formula changes force a
 * rescan rather than ranking with incompatible numbers. The phash index has
 * its own versioning, so a quality bump only recomputes quality.
 */
export const hydrateQualityIndex = async (): Promise<Map<number, number>> => {
    const persisted = await loadKv("qualityIndex");
    if (persisted?.version !== QUALITY_INDEX_VERSION) {
        return new Map();
    }
    const entries = new Map<number, number>();
    for (const [fileId, score] of Object.entries(persisted.entries)) {
        if (typeof score === "number" && Number.isFinite(score)) {
            entries.set(Number(fileId), score);
        }
    }
    return entries;
};

/** Write the whole quality index at the current version. */
export const persistQualityIndex = (
    entries: ReadonlyMap<number, number>,
): Promise<void> =>
    saveKv("qualityIndex", {
        version: QUALITY_INDEX_VERSION,
        entries: Object.fromEntries(entries),
    });
