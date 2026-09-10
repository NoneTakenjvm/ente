import { describe, expect, it } from "vitest";
import type { PhashEntry } from "@/lib/crop-match";
import {
    buildAnonymisedKitNearnessCorpus,
    deriveExactTagSetKits,
    KIT_NEARNESS_CORPUS_PRIVACY_NOTICE,
    KIT_NEARNESS_CORPUS_VERSION,
    serializeAnonymisedKitNearnessCorpus,
} from "@/lib/kit-nearness-corpus-export";
import type { TagPreset } from "@/lib/tag-presets";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import type { EnteFile } from "ente-media/file";

const fileWithTags = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

/** Deterministic LCG for stable shuffle in tests. */
const makeRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

describe("buildAnonymisedKitNearnessCorpus", () => {
    it("remaps tags and kits; omits Ente ids, names, grids, and untagged hashes", () => {
        const files = [
            fileWithTags(101, ["beach", "vietnam"]),
            fileWithTags(102, ["beach", "vietnam"]),
            fileWithTags(202, ["beach"]),
            fileWithTags(303, []),
            fileWithTags(404, ["compressed", "rotated"]),
        ];
        const phashEntries = new Map<number, PhashEntry>([
            [
                101,
                {
                    hashes: ["aaaaaaaaaaaaaaaa"],
                    color: "bbbbbbbbbbbbbbbb",
                    grid: "SHOULD_NOT_EXPORT",
                },
            ],
            [303, { hashes: ["cccccccccccccccc"] }],
            [404, { hashes: ["dddddddddddddddd"] }],
        ]);
        const kits: TagPreset[] = [
            {
                id: "preset-secret",
                name: "Vietnam beach",
                tags: ["beach", "vietnam"],
            },
        ];

        const embedding = Array.from({ length: 512 }, (_, i) => i / 512);
        const corpus = buildAnonymisedKitNearnessCorpus({
            files,
            phashEntries,
            kits,
            embeddings: new Map([[101, embedding]]),
            random: makeRandom(42),
        });

        expect(corpus.version).toBe(KIT_NEARNESS_CORPUS_VERSION);
        expect(corpus.privacyNotice).toBe(KIT_NEARNESS_CORPUS_PRIVACY_NOTICE);
        expect(corpus.embeddingModelId).toBe("Xenova/mobileclip_s2");
        expect(corpus.embeddingDims).toBe(512);
        expect(corpus.photos).toHaveLength(3);
        expect(corpus.kits).toHaveLength(1);
        expect(corpus.derivedKits).toHaveLength(1);
        expect(corpus.derivedKits[0]!.count).toBe(2);
        expect(corpus.derivedKits[0]!.id).toMatch(/^d_\d+$/);
        expect(corpus.derivedKits[0]!.tags).toHaveLength(2);
        expect(
            corpus.photos.filter((photo) => photo.embedding?.length === 512),
        ).toHaveLength(1);

        const json = serializeAnonymisedKitNearnessCorpus(corpus);
        expect(json).not.toContain("beach");
        expect(json).not.toContain("vietnam");
        expect(json).not.toContain("Vietnam beach");
        expect(json).not.toContain("preset-secret");
        expect(json).not.toContain("SHOULD_NOT_EXPORT");
        expect(json).not.toContain("cccccccccccccccc");

        const parsed = JSON.parse(json) as {
            photos: Array<Record<string, unknown>>;
            kits: Array<Record<string, unknown>>;
            derivedKits: Array<Record<string, unknown>>;
            embeddingModelId?: string;
            embeddingDims?: number;
        };
        expect(Object.keys(parsed).sort()).toEqual([
            "derivedKits",
            "embeddingDims",
            "embeddingModelId",
            "kits",
            "photos",
            "privacyNotice",
            "version",
        ]);
        expect(parsed.embeddingModelId).toBe("Xenova/mobileclip_s2");
        expect(parsed.embeddingDims).toBe(512);
        for (const kit of parsed.derivedKits) {
            expect(Object.keys(kit).sort()).toEqual(["count", "id", "tags"]);
        }
    });

    it("packs tile vectors into one matrix and records offsets per photo", () => {
        const tile = (fill: number): Float32Array =>
            new Float32Array(512).fill(fill);
        const twoTiles = new Float32Array(2 * 512);
        twoTiles.set(tile(0.25), 0);
        twoTiles.set(tile(0.5), 512);
        const corpus = buildAnonymisedKitNearnessCorpus({
            files: [
                fileWithTags(1, ["beach"]),
                fileWithTags(2, ["beach"]),
                fileWithTags(3, ["beach"]),
            ],
            phashEntries: new Map(),
            kits: [],
            tileEmbeddings: new Map([
                [1, { rows: 1, columns: 2, vectors: twoTiles }],
                [3, { rows: 1, columns: 1, vectors: tile(0.75) }],
                // Wrong shape — must be dropped, not exported half-packed.
                [2, { rows: 2, columns: 2, vectors: tile(1) }],
            ]),
            random: makeRandom(5),
        });

        expect(corpus.tileLayout).toBe("thirds-v1");
        expect(corpus.tileVectors).toHaveLength(3 * 512);
        const withTiles = corpus.photos.filter((photo) => photo.tiles);
        expect(withTiles).toHaveLength(2);
        // Offsets index the concatenated matrix in (shuffled) photo order.
        for (const photo of withTiles) {
            const { offset, rows, columns } = photo.tiles!;
            const expected = rows * columns === 2 ? 0.25 : 0.75;
            expect(corpus.tileVectors![offset * 512]).toBe(expected);
        }
        const [first, second] = [...withTiles].sort(
            (a, b) => a.tiles!.offset - b.tiles!.offset,
        );
        expect(first!.tiles!.offset).toBe(0);
        expect(second!.tiles!.offset).toBe(
            first!.tiles!.rows * first!.tiles!.columns,
        );

        const json = serializeAnonymisedKitNearnessCorpus(corpus, "c-tiles.f32");
        const parsed = JSON.parse(json) as {
            tileLayout?: string;
            tileRows?: number;
            tileSidecar?: string;
            photos: Array<{ tiles?: Record<string, unknown> }>;
        };
        expect(parsed.tileLayout).toBe("thirds-v1");
        expect(parsed.tileRows).toBe(3);
        expect(parsed.tileSidecar).toBe("c-tiles.f32");
        expect(json).not.toContain("tileVectors");
        for (const photo of parsed.photos) {
            if (photo.tiles) {
                expect(Object.keys(photo.tiles).sort()).toEqual([
                    "columns",
                    "offset",
                    "rows",
                ]);
            }
        }
    });

    it("omits tile fields entirely when no photo has tiles", () => {
        const corpus = buildAnonymisedKitNearnessCorpus({
            files: [fileWithTags(1, ["beach"])],
            phashEntries: new Map(),
            kits: [],
            random: makeRandom(1),
        });
        expect(corpus.tileLayout).toBeUndefined();
        expect(corpus.tileVectors).toBeUndefined();
        const json = serializeAnonymisedKitNearnessCorpus(corpus);
        expect(json).not.toContain("tile");
    });

    it("skips untagged files even when hashed", () => {
        const corpus = buildAnonymisedKitNearnessCorpus({
            files: [fileWithTags(1, []), fileWithTags(2, ["alone"])],
            phashEntries: new Map([
                [1, { hashes: ["eeeeeeeeeeeeeeee"] }],
            ]),
            kits: [],
            random: makeRandom(7),
        });
        expect(corpus.photos).toHaveLength(1);
        expect(corpus.derivedKits).toEqual([]);
        expect(JSON.stringify(corpus)).not.toContain("eeeeeeeeeeeeeeee");
    });

    it("skips archived files", () => {
        const archived = {
            ...fileWithTags(9, ["beach", "vietnam"]),
            magicMetadata: {
                version: 1,
                count: 1,
                data: { visibility: 1 },
            },
        } as EnteFile;
        const corpus = buildAnonymisedKitNearnessCorpus({
            files: [
                fileWithTags(1, ["beach", "vietnam"]),
                fileWithTags(2, ["beach", "vietnam"]),
                archived,
            ],
            phashEntries: new Map(),
            kits: [],
            random: makeRandom(3),
        });
        expect(corpus.photos).toHaveLength(2);
        expect(corpus.derivedKits[0]!.count).toBe(2);
    });
});

describe("deriveExactTagSetKits", () => {
    it("counts exact sets only, not subsets", () => {
        const derived = deriveExactTagSetKits([
            { id: 1, hashes: [], tags: ["t_0001", "t_0002"] },
            { id: 2, hashes: [], tags: ["t_0001", "t_0002"] },
            { id: 3, hashes: [], tags: ["t_0001", "t_0002", "t_0003"] },
            { id: 4, hashes: [], tags: ["t_0001"] },
        ]);
        expect(derived).toHaveLength(1);
        expect(derived[0]!.tags).toEqual(["t_0001", "t_0002"]);
        expect(derived[0]!.count).toBe(2);
    });
});
