import { describe, expect, it, vi } from "vitest";
import {
    buildKitFitModels,
    isFileUntagged,
    listUntaggedImageIds,
    rankKitsForImage,
    type KitFitModel,
} from "@/lib/tag-helper-fit";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import { axis, embMap } from "@/test-utils/fixtures";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";
import type * as ClipText from "@/lib/clip-text";

vi.mock("@/lib/clip-text", async (importOriginal) => ({
    ...(await importOriginal<typeof ClipText>()),
    loadKitTextVector: async () => null,
}));

const libraryFile = (
    id: number,
    {
        ownerID = 1,
        fileType = FileType.image,
        tags = [],
        updatedAt = id,
    }: {
        ownerID?: number;
        fileType?: FileType;
        tags?: string[];
        updatedAt?: number;
    } = {},
): EnteFile =>
    fileWithOrganizerTags(
        {
            id,
            ownerID,
            updationTime: updatedAt,
            metadata: { fileType, creationTime: 1 },
        } as unknown as EnteFile,
        tags,
    );

const fitModel = (
    name: string,
    prototype: Float32Array,
    memberDistances: number[],
): KitFitModel => ({
    preset: { id: name, name, tags: [name] },
    memberCount: memberDistances.length,
    prototypes: [prototype],
    memberDistances: Float64Array.from(memberDistances),
});

const nearMembers = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06];

describe("isFileUntagged", () => {
    it("ignores tags whose presence is turned off", () => {
        const presence = new Map([["beach", false]]);
        expect(
            isFileUntagged(libraryFile(1, { tags: ["beach"] }), presence),
        ).toBe(true);
        expect(
            isFileUntagged(libraryFile(2, { tags: ["beach"] }), new Map()),
        ).toBe(false);
    });

    it("ignores system tags", () => {
        expect(
            isFileUntagged(
                libraryFile(1, { tags: ["compressed"] }),
                new Map(),
            ),
        ).toBe(true);
    });
});

describe("listUntaggedImageIds", () => {
    it("keeps the user's untagged images, newest upload first", () => {
        const files = [
            libraryFile(1, { updatedAt: 100 }),
            libraryFile(2, { updatedAt: 300 }),
            libraryFile(3, { updatedAt: 200, tags: ["beach"] }),
            libraryFile(4, { fileType: FileType.video, updatedAt: 400 }),
            libraryFile(5, { ownerID: 2, updatedAt: 500 }),
        ];
        expect(listUntaggedImageIds(files, 1, new Map())).toEqual([2, 1]);
    });
});

describe("buildKitFitModels", () => {
    it("skips presets without tags", async () => {
        const models = await buildKitFitModels(
            [
                { id: "empty", name: "Empty", tags: [] },
                { id: "dog", name: "Dog", tags: ["dog"] },
            ],
            [],
            new Map(),
            new Map(),
        );
        expect(models.map((model) => model.preset.id)).toEqual(["dog"]);
    });

    it("leaves out members that are themselves the prototype", async () => {
        const ids = [1, 2, 3, 4, 5];
        const models = await buildKitFitModels(
            [{ id: "dog", name: "Dog", tags: ["dog"] }],
            ids.map((id) => libraryFile(id, { tags: ["dog"] })),
            new Map([["dog", new Set(ids)]]),
            embMap(ids.map((id): [number, number[]] => [id, axis(0)])),
        );
        expect(models[0]!.memberCount).toBe(5);
        expect(models[0]!.memberDistances).toHaveLength(0);
    });
});

describe("rankKitsForImage", () => {
    it("puts the kit whose members the photo sits near first", () => {
        const ranked = rankKitsForImage(Float32Array.from(axis(0)), [
            fitModel("Dog", Float32Array.from(axis(1)), nearMembers),
            fitModel("Beach", Float32Array.from(axis(0)), nearMembers),
        ]);
        expect(ranked.map((fit) => fit.preset.name)).toEqual([
            "Beach",
            "Dog",
        ]);
        expect(ranked[0]!.match).toBe(1);
        expect(ranked[1]!.match).toBe(0);
    });

    it("shows no match below five members and ranks those kits after calibrated ones", () => {
        const ranked = rankKitsForImage(Float32Array.from(axis(0)), [
            fitModel("Small", Float32Array.from(axis(0)), [0.01, 0.02, 0.03]),
            fitModel("Beach", Float32Array.from(axis(0)), nearMembers),
        ]);
        expect(ranked.map((fit) => fit.preset.name)).toEqual([
            "Beach",
            "Small",
        ]);
        expect(ranked[1]!.match).toBeUndefined();
    });

    it("orders by member count when the photo has no embedding", () => {
        const ranked = rankKitsForImage(undefined, [
            fitModel("Dog", Float32Array.from(axis(1)), [0.01, 0.02, 0.03]),
            fitModel("Beach", Float32Array.from(axis(0)), nearMembers),
        ]);
        expect(ranked.map((fit) => fit.preset.name)).toEqual([
            "Beach",
            "Dog",
        ]);
        expect(
            ranked.every(
                (fit) => fit.match === undefined && fit.distance === Infinity,
            ),
        ).toBe(true);
    });
});
