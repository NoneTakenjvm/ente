/**
 * Build an anonymised kit-nearness eval corpus from the in-memory library.
 *
 * Exports perceptual hashes + optional CLIP embeddings + remapped tag/kit ids —
 * no image bytes, Ente file ids, real tag names, kit names, timestamps, or crop
 * luminance grids.
 *
 * [Note: membership fingerprints] dHash / color / CLIP vectors can still prove
 * whether a candidate image appears in the dump. Treat the JSON as private
 * offline eval data, never public or committed.
 */
import type { PhashEntry } from "@/lib/crop-match";
import {
    KIT_EMBEDDING_DIMS,
    KIT_EMBEDDING_MODEL_ID,
    type KitTileEmbeddings,
} from "@/lib/kit-embedding";
import { KIT_TILE_LAYOUT_ID } from "@/lib/kit-tile-layout";
import { tagSetKey, type TagPreset } from "@/lib/tag-presets";
import { extractUserTags } from "@/lib/tags";
import { isEnteVideoFile } from "@/lib/media-kind";
import { isFileArchivedLocally } from "@/lib/visibility-outbox";
import type { EnteFile } from "ente-media/file";

/** Schema version for harness loaders. */
export const KIT_NEARNESS_CORPUS_VERSION = 4 as const;

/** Shown in the JSON so humans do not treat vectors as “anonymous content”. */
export const KIT_NEARNESS_CORPUS_PRIVACY_NOTICE =
    "Private eval corpus: perceptual hashes and CLIP embeddings are membership " +
    "fingerprints. Keep offline. No images, Ente ids, real tag names, or crop grids.";

export type AnonymisedCorpusPhoto = {
    /** Synthetic id (1…n), unrelated to Ente file ids. */
    id: number;
    /** dHash variant hex strings (empty when the file was never scanned). */
    hashes: string[];
    /** Optional color-palette hex; never includes crop grids. */
    color?: string;
    /** Opaque remapped tag ids (`t_0001`, …). */
    tags: string[];
    /**
     * L2-normalized CLIP image embedding when scanned
     * ({@link KIT_EMBEDDING_MODEL_ID}).
     */
    embedding?: number[];
    /** Where this photo's tile vectors sit in the float32 sidecar. */
    tiles?: AnonymisedCorpusTiles;
};

export type AnonymisedCorpusTiles = {
    /** First row of this photo in {@link AnonymisedKitNearnessCorpus.tileVectors}. */
    offset: number;
    /** {@link kitTileGrid} shape; `rows × columns` consecutive rows. */
    rows: number;
    columns: number;
};

export type AnonymisedCorpusKit = {
    /** Opaque kit id (`k_0001`, …) — saved presets. */
    id: string;
    /** Remapped tag ids that define the kit. */
    tags: string[];
};

/**
 * Exact multi-tag set derived like {@link suggestTagKits} (full set only).
 */
export type AnonymisedDerivedKit = {
    /** Opaque id (`d_0001`, …). */
    id: string;
    /** Remapped tag ids (exact set). */
    tags: string[];
    /** Photos whose user tags are exactly this set. */
    count: number;
};

export type AnonymisedKitNearnessCorpus = {
    version: typeof KIT_NEARNESS_CORPUS_VERSION;
    privacyNotice: typeof KIT_NEARNESS_CORPUS_PRIVACY_NOTICE;
    /** CLIP model id when any photo has an embedding. */
    embeddingModelId?: string;
    embeddingDims?: number;
    /** {@link KIT_TILE_LAYOUT_ID} when any photo has tiles. */
    tileLayout?: string;
    /**
     * All tile rows back to back (`embeddingDims` floats each), indexed by
     * {@link AnonymisedCorpusPhoto.tiles}. Written as a binary sidecar, not
     * JSON.
     */
    tileVectors?: Float32Array;
    /** Tagged photos only (user tags; system tags never included). */
    photos: AnonymisedCorpusPhoto[];
    /** Saved presets (names/ids discarded). */
    kits: AnonymisedCorpusKit[];
    /**
     * Exact tag-set kits from {@link photos}, same rules as Manage →
     * View suggestions (minCount 2, no subset pairs).
     */
    derivedKits: AnonymisedDerivedKit[];
};

export type BuildAnonymisedCorpusInput = {
    files: readonly EnteFile[];
    phashEntries: ReadonlyMap<number, PhashEntry>;
    kits: readonly TagPreset[];
    /** Optional CLIP vectors keyed by Ente file id. */
    embeddings?: ReadonlyMap<number, number[]>;
    /** Optional tile vectors ({@link KIT_TILE_LAYOUT_ID}) keyed by Ente file id. */
    tileEmbeddings?: ReadonlyMap<number, KitTileEmbeddings>;
    /**
     * When set, only these tags appear in photos/kits (kit nearness allowlist).
     * Default: all user tags (legacy exports).
     */
    includeInKitNearnessByName?: ReadonlyMap<string, boolean>;
    /**
     * Optional RNG for deterministic tests. Defaults to
     * {@link crypto.getRandomValues}.
     */
    random?: () => number;
};

const padIndex = (index: number, width: number): string =>
    String(index).padStart(width, "0");

/**
 * Fisher–Yates shuffle (copy). Uses {@link random} in `[0, 1)`.
 */
const shuffleCopy = <T>(items: readonly T[], random: () => number): T[] => {
    const next = [...items];
    for (let i = next.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = next[i]!;
        next[i] = next[j]!;
        next[j] = tmp;
    }
    return next;
};

const defaultRandom = (): number => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! / 0x1_0000_0000;
};

/**
 * Allowlisted photo record — never spreads {@link PhashEntry} (would leak `grid`).
 */
const toCorpusPhoto = (
    syntheticId: number,
    entry: PhashEntry | undefined,
    tags: string[],
    embedding?: number[],
): AnonymisedCorpusPhoto => {
    const photo: AnonymisedCorpusPhoto = {
        id: syntheticId,
        hashes: entry?.hashes?.length ? [...entry.hashes] : [],
        tags,
    };
    if (typeof entry?.color === "string" && entry.color.length > 0) {
        photo.color = entry.color;
    }
    if (embedding?.length === KIT_EMBEDDING_DIMS) {
        photo.embedding = [...embedding];
    }
    return photo;
};

const hasCompleteGrid = (tiles: KitTileEmbeddings): boolean =>
    tiles.vectors.length === tiles.rows * tiles.columns * KIT_EMBEDDING_DIMS;

/**
 * Rank exact multi-tag sets from corpus photos (mirrors {@link suggestTagKits}).
 *
 * @param photos anonymised photos with remapped tag ids
 * @param minCount minimum exact-set frequency (default 2)
 */
export const deriveExactTagSetKits = (
    photos: readonly AnonymisedCorpusPhoto[],
    minCount: number = 2,
): AnonymisedDerivedKit[] => {
    const counts = new Map<string, { tags: string[]; count: number }>();
    for (const photo of photos) {
        const tags = [...new Set(photo.tags)].sort((a, b) =>
            a.localeCompare(b));
        if (tags.length < 2) {
            continue;
        }
        const key = tagSetKey(tags);
        const existing = counts.get(key);
        if (existing) {
            existing.count += 1;
            continue;
        }
        counts.set(key, { tags, count: 1 });
    }

    const ranked = [...counts.values()]
        .filter((entry) => entry.count >= minCount)
        .sort(
            (a, b) =>
                b.count - a.count ||
                a.tags.length - b.tags.length ||
                a.tags.join("\0").localeCompare(b.tags.join("\0")),
        );

    const width = Math.max(4, String(ranked.length).length);
    return ranked.map((entry, index) => ({
        id: `d_${padIndex(index + 1, width)}`,
        tags: entry.tags,
        count: entry.count,
    }));
};

/**
 * Build the anonymised corpus document.
 *
 * Only photos with ≥1 user tag are included (untagged hashes are omitted to
 * shrink membership surface). Tag strings become opaque ids via a fresh random
 * bijection; photo/kit order is shuffled before synthetic ids are assigned.
 * {@link derivedKits} are computed from the remapped photo tags.
 */
export const buildAnonymisedKitNearnessCorpus = (
    input: BuildAnonymisedCorpusInput,
): AnonymisedKitNearnessCorpus => {
    const random = input.random ?? defaultRandom;
    const allowlist = input.includeInKitNearnessByName;
    const filterTags = (tags: readonly string[]): string[] => {
        if (!allowlist) {
            return [...tags];
        }
        return tags.filter((tag) => allowlist.get(tag) === true);
    };

    const eligible = input.files.filter(
        (file) =>
            !isEnteVideoFile(file) &&
            !isFileArchivedLocally(file) &&
            filterTags(extractUserTags(file)).length > 0,
    );

    const tagSet = new Set<string>();
    for (const file of eligible) {
        for (const tag of filterTags(extractUserTags(file))) {
            tagSet.add(tag);
        }
    }
    for (const kit of input.kits) {
        for (const tag of filterTags(kit.tags)) {
            tagSet.add(tag);
        }
    }

    const shuffledTags = shuffleCopy([...tagSet].sort(), random);
    const tagWidth = Math.max(4, String(shuffledTags.length).length);
    const tagIdByName = new Map<string, string>();
    shuffledTags.forEach((tag, index) => {
        tagIdByName.set(tag, `t_${padIndex(index + 1, tagWidth)}`);
    });

    const remapTags = (tags: readonly string[]): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const tag of filterTags(tags)) {
            const id = tagIdByName.get(tag);
            if (!id || seen.has(id)) {
                continue;
            }
            seen.add(id);
            result.push(id);
        }
        result.sort();
        return result;
    };

    const shuffledFiles = shuffleCopy(eligible, random);
    let embeddingCount = 0;
    const tileMatrices: Float32Array[] = [];
    let tileRowCount = 0;
    const photos: AnonymisedCorpusPhoto[] = shuffledFiles.map((file, index) => {
        const embedding = input.embeddings?.get(file.id);
        if (embedding?.length === KIT_EMBEDDING_DIMS) {
            embeddingCount += 1;
        }
        const photo = toCorpusPhoto(
            index + 1,
            input.phashEntries.get(file.id),
            remapTags(extractUserTags(file)),
            embedding,
        );
        const tiles = input.tileEmbeddings?.get(file.id);
        if (tiles && hasCompleteGrid(tiles)) {
            photo.tiles = {
                offset: tileRowCount,
                rows: tiles.rows,
                columns: tiles.columns,
            };
            tileMatrices.push(tiles.vectors);
            tileRowCount += tiles.rows * tiles.columns;
        }
        return photo;
    });

    const kits: AnonymisedCorpusKit[] = [];
    const shuffledKits = shuffleCopy(input.kits, random);
    let kitIndex = 0;
    for (const kit of shuffledKits) {
        const tags = remapTags(kit.tags);
        if (!tags.length) {
            continue;
        }
        kitIndex += 1;
        kits.push({
            id: `k_${padIndex(kitIndex, 4)}`,
            tags,
        });
    }

    const corpus: AnonymisedKitNearnessCorpus = {
        version: KIT_NEARNESS_CORPUS_VERSION,
        privacyNotice: KIT_NEARNESS_CORPUS_PRIVACY_NOTICE,
        photos,
        kits,
        derivedKits: deriveExactTagSetKits(photos),
    };
    if (embeddingCount > 0) {
        corpus.embeddingModelId = KIT_EMBEDDING_MODEL_ID;
        corpus.embeddingDims = KIT_EMBEDDING_DIMS;
    }
    if (tileRowCount > 0) {
        corpus.tileLayout = KIT_TILE_LAYOUT_ID;
        const tileVectors = new Float32Array(tileRowCount * KIT_EMBEDDING_DIMS);
        let offset = 0;
        for (const matrix of tileMatrices) {
            tileVectors.set(matrix, offset);
            offset += matrix.length;
        }
        corpus.tileVectors = tileVectors;
    }
    return corpus;
};

/**
 * Serialize with an explicit allowlist so future fields cannot leak by accident.
 *
 * @param tileSidecar filename of the float32 sidecar holding
 * {@link AnonymisedKitNearnessCorpus.tileVectors}; recorded in the JSON when
 * the corpus has tiles.
 */
export const serializeAnonymisedKitNearnessCorpus = (
    corpus: AnonymisedKitNearnessCorpus,
    tileSidecar?: string,
): string => {
    const photos = corpus.photos.map((photo) => {
        const row: Record<string, unknown> = {
            id: photo.id,
            hashes: photo.hashes,
            tags: photo.tags,
        };
        if (photo.color !== undefined) {
            row.color = photo.color;
        }
        if (photo.embedding !== undefined) {
            row.embedding = photo.embedding;
        }
        if (photo.tiles !== undefined) {
            row.tiles = {
                offset: photo.tiles.offset,
                rows: photo.tiles.rows,
                columns: photo.tiles.columns,
            };
        }
        return row;
    });
    const kits = corpus.kits.map((kit) => ({
        id: kit.id,
        tags: kit.tags,
    }));
    const derivedKits = corpus.derivedKits.map((kit) => ({
        id: kit.id,
        tags: kit.tags,
        count: kit.count,
    }));
    const doc: Record<string, unknown> = {
        version: corpus.version,
        privacyNotice: corpus.privacyNotice,
        photos,
        kits,
        derivedKits,
    };
    if (corpus.embeddingModelId) {
        doc.embeddingModelId = corpus.embeddingModelId;
    }
    if (corpus.embeddingDims) {
        doc.embeddingDims = corpus.embeddingDims;
    }
    if (corpus.tileLayout && corpus.tileVectors) {
        doc.tileLayout = corpus.tileLayout;
        doc.tileRows = corpus.tileVectors.length / KIT_EMBEDDING_DIMS;
        if (tileSidecar) {
            doc.tileSidecar = tileSidecar;
        }
    }
    return `${JSON.stringify(doc)}\n`;
};

/**
 * Trigger a browser download of the corpus JSON, plus a little-endian float32
 * sidecar (`<name>-tiles.f32`) when the corpus has tile vectors. The browser
 * may ask once to allow the second download.
 */
export const downloadAnonymisedKitNearnessCorpus = (
    corpus: AnonymisedKitNearnessCorpus,
    filename = "kit-nearness-corpus.json",
): void => {
    const tileSidecar = corpus.tileVectors ?
        `${filename.replace(/\.json$/, "")}-tiles.f32` :
        undefined;
    downloadBlob(
        new Blob([serializeAnonymisedKitNearnessCorpus(corpus, tileSidecar)], {
            type: "application/json",
        }),
        filename,
    );
    if (corpus.tileVectors && tileSidecar) {
        downloadBlob(
            new Blob([corpus.tileVectors.buffer as ArrayBuffer], {
                type: "application/octet-stream",
            }),
            tileSidecar,
        );
    }
};

const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
};
