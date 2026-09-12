import { describe, expect, it } from "vitest";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import { KIT_EMBEDDING_DIMS } from "@/lib/kit-embedding";
import {
    KIT_MARGIN_MIN_EXAMPLES,
    buildKitMarginsRanking,
    type KitMarginsRankingInput,
} from "@/lib/kit-nearness-margins-job";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

const toEmb = (values: number[]): Float32Array => Float32Array.from(values);
const file = (id: number, tags: string[], fileType = FileType.image): EnteFile =>
    fileWithOrganizerTags(
        { id, metadata: { fileType } } as unknown as EnteFile,
        tags,
    );

const axis = (d: number): number[] => {
    const out = new Array<number>(KIT_EMBEDDING_DIMS).fill(0);
    out[d] = 1;
    return out;
};

/**
 * Library with `count` files per group: members (a+b), a-only, b-only, and
 * c-only (outside the kit but still tagged). Ids are group * 100 + index.
 */
const buildLibrary = (count: number) => {
    const files: EnteFile[] = [];
    const embeddings = new Map<number, Float32Array>();
    const groups: [string[], number][] = [
        [["a", "b"], 0],
        [["a"], 1],
        [["b"], 2],
        [["c"], 3],
    ];
    for (const [tags, group] of groups) {
        for (let i = 0; i < count; i += 1) {
            const id = group * 100 + i;
            files.push(file(id, tags));
            embeddings.set(id, toEmb(axis(group)));
        }
    }
    return { files, embeddings };
};

type OrganizerData = { _organizer_v1?: { tags: string[] } } | undefined;

const indexOf = (files: readonly EnteFile[]): Map<string, Set<number>> => {
    const index = new Map<string, Set<number>>();
    for (const entry of files) {
        const data = entry.pubMagicMetadata?.data as OrganizerData;
        for (const tag of data?._organizer_v1?.tags ?? []) {
            const ids = index.get(tag) ?? new Set<number>();
            ids.add(entry.id);
            index.set(tag, ids);
        }
    }
    return index;
};

const inputFor = (
    library: ReturnType<typeof buildLibrary>,
    overrides?: Partial<KitMarginsRankingInput>,
): KitMarginsRankingInput => ({
    kitTags: ["a", "b"],
    libraryFiles: library.files,
    candidateFiles: library.files,
    embeddings: library.embeddings,
    fileIdsByTag: indexOf(library.files),
    includeInKitNearnessByName: new Map([
        ["a", true],
        ["b", true],
        ["c", true],
    ]),
    productionScore: (fileId) => -fileId,
    ...overrides,
});

describe("buildKitMarginsRanking", () => {
    it("packs the tagged embedded population with per-tag labels", () => {
        const library = buildLibrary(KIT_MARGIN_MIN_EXAMPLES);
        const ranking = buildKitMarginsRanking(inputFor(library));
        expect(ranking).toBeDefined();
        const { request, trailingIds } = ranking!;

        expect(request.dim).toBe(KIT_EMBEDDING_DIMS);
        expect(request.trainingIds.length).toBe(4 * KIT_MARGIN_MIN_EXAMPLES);
        expect(request.trainingVectors.length).toBe(
            request.trainingIds.length * KIT_EMBEDDING_DIMS,
        );
        expect(request.tags.map((tag) => tag.name)).toEqual(["a", "b"]);
        const rowOf = (id: number): number =>
            Array.from(request.trainingIds).indexOf(id);
        expect(request.tags[0]!.labels[rowOf(0)]).toBe(1);
        expect(request.tags[1]!.labels[rowOf(0)]).toBe(1);
        expect(request.tags[0]!.labels[rowOf(100)]).toBe(1);
        expect(request.tags[1]!.labels[rowOf(100)]).toBe(0);
        expect(request.tags[0]!.labels[rowOf(300)]).toBe(0);
        expect(request.trainingProductionScores[rowOf(200)]).toBe(-200);

        expect(request.candidateIds.length).toBe(library.files.length);
        expect(trailingIds).toEqual([]);
    });

    it("excludes videos, untagged and unembedded files from training", () => {
        const library = buildLibrary(KIT_MARGIN_MIN_EXAMPLES);
        const video = file(900, ["a", "b"], FileType.video);
        const untagged = file(901, []);
        const notAllowlisted = file(902, ["z"]);
        const unembedded = file(903, ["a"]);
        library.embeddings.set(900, toEmb(axis(0)));
        library.embeddings.set(901, toEmb(axis(0)));
        library.embeddings.set(902, toEmb(axis(0)));
        const files = [...library.files, video, untagged, notAllowlisted, unembedded];
        const ranking = buildKitMarginsRanking(
            inputFor(library, {
                libraryFiles: files,
                candidateFiles: [unembedded, video, untagged, ...library.files],
                fileIdsByTag: indexOf(files),
            }),
        );
        expect(ranking).toBeDefined();
        const trainingIds = Array.from(ranking!.request.trainingIds);
        expect(trainingIds).not.toContain(900);
        expect(trainingIds).not.toContain(901);
        expect(trainingIds).not.toContain(902);
        expect(trainingIds).not.toContain(903);

        // Candidates: untagged still is still ranked (it is embedded);
        // unembedded still then video trail.
        expect(Array.from(ranking!.request.candidateIds)).toContain(901);
        expect(ranking!.trailingIds).toEqual([903, 900]);
    });

    it("declines single-tag kits", () => {
        const library = buildLibrary(KIT_MARGIN_MIN_EXAMPLES);
        expect(
            buildKitMarginsRanking(inputFor(library, { kitTags: ["a"] })),
        ).toBeUndefined();
    });

    it("declines when the sample has too few complete or partial members", () => {
        const thin = buildLibrary(KIT_MARGIN_MIN_EXAMPLES - 1);
        expect(buildKitMarginsRanking(inputFor(thin))).toBeUndefined();

        const library = buildLibrary(KIT_MARGIN_MIN_EXAMPLES);
        const noPartials = library.files.filter(
            (entry) => entry.id < 100 || entry.id >= 300,
        );
        expect(
            buildKitMarginsRanking(
                inputFor(library, {
                    libraryFiles: noPartials,
                    fileIdsByTag: indexOf(noPartials),
                }),
            ),
        ).toBeUndefined();
    });

    it("declines when a kit tag lacks negatives in the sample", () => {
        const library = buildLibrary(KIT_MARGIN_MIN_EXAMPLES);
        const everyoneHasA = library.files.filter(
            (entry) => entry.id < 200,
        );
        expect(
            buildKitMarginsRanking(
                inputFor(library, {
                    libraryFiles: everyoneHasA,
                    fileIdsByTag: indexOf(everyoneHasA),
                }),
            ),
        ).toBeUndefined();
    });
});
