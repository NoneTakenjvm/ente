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
        expect(corpus.embeddingModelId).toBe("Xenova/clip-vit-base-patch16");
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
        expect(parsed.embeddingModelId).toBe("Xenova/clip-vit-base-patch16");
        expect(parsed.embeddingDims).toBe(512);
        for (const kit of parsed.derivedKits) {
            expect(Object.keys(kit).sort()).toEqual(["count", "id", "tags"]);
        }
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
