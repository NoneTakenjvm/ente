import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/kv", () => ({ saveKv: vi.fn(async () => undefined) }));
vi.mock("@/lib/organizer-config-save-queue", () => ({
    enqueueOrganizerConfigPatch: vi.fn(),
}));

import { enqueueOrganizerConfigPatch } from "@/lib/organizer-config-save-queue";
import { setTagFilterModeOnFilter } from "@/lib/tag-filter-mutations";
import { useTagStore } from "../tag-store";

const seed = (options: {
    fileIdsByTag: Record<string, number[]>;
    tagTypeByName?: Record<string, string>;
    kitNearness?: string[];
    effectsExcluded?: string[];
    registered?: string[];
}): void => {
    const store = useTagStore.getState();
    store.reset();
    store.hydrateTagTypes({
        types: ["default", "genre"],
        tagTypeByName: options.tagTypeByName ?? {},
        includeInKitNearnessByName: Object.fromEntries(
            (options.kitNearness ?? []).map((name) => [name, true]),
        ),
        includeInEffectsPresenceByName: Object.fromEntries(
            (options.effectsExcluded ?? []).map((name) => [name, false]),
        ),
    });
    store.hydrateFromPersisted({
        tags: Object.keys(options.fileIdsByTag).sort(),
        fileIdsByTag: options.fileIdsByTag,
    });
    store.hydrateRegisteredTags(options.registered);
};

const effectsPresence = (name: string): boolean | undefined =>
    useTagStore.getState().typeConfig.includeInEffectsPresenceByName.get(name);

const fileIds = (name: string): number[] | undefined => {
    const ids = useTagStore.getState().fileIdsByTag.get(name);
    return ids && [...ids].sort();
};

beforeEach(() => {
    vi.mocked(enqueueOrganizerConfigPatch).mockClear();
});

describe("applyTagRename", () => {
    it("moves files, type, kit nearness and the filter clause onto the new name", () => {
        seed({
            fileIdsByTag: { old: [1, 2], other: [3] },
            tagTypeByName: { old: "genre" },
            kitNearness: ["old"],
        });
        useTagStore.getState().updateTagFilter("gallery", (filter) =>
            setTagFilterModeOnFilter(filter, "old", "include"));
        useTagStore.getState().applyTagRename("old", "fresh");

        const state = useTagStore.getState();
        expect(state.tags).toEqual(["fresh", "other"]);
        expect(fileIds("fresh")).toEqual([1, 2]);
        expect(state.fileIdsByTag.has("old")).toBe(false);
        expect(state.typeConfig.tagTypeByName.get("fresh")).toBe("genre");
        expect(state.typeConfig.tagTypeByName.has("old")).toBe(false);
        expect(state.typeConfig.includeInKitNearnessByName.get("fresh")).toBe(true);
        expect(state.typeConfig.includeInKitNearnessByName.has("old")).toBe(false);
        expect(state.tagFilter.root.children).toMatchObject([
            { kind: "clause", tag: "fresh" },
        ]);
    });

    it("unions files onto an existing tag and keeps that tag's type", () => {
        seed({
            fileIdsByTag: { old: [1], fresh: [2] },
            tagTypeByName: { old: "genre", fresh: "default" },
        });
        useTagStore.getState().applyTagRename("old", "fresh");

        expect(fileIds("fresh")).toEqual([1, 2]);
        expect(useTagStore.getState().typeConfig.tagTypeByName.get("fresh")).toBe(
            "default",
        );
    });

    it("transfers an effects-presence exclusion onto a brand-new name", () => {
        seed({ fileIdsByTag: { old: [1] }, effectsExcluded: ["old"] });
        useTagStore.getState().applyTagRename("old", "fresh");

        expect(effectsPresence("fresh")).toBe(false);
        expect(effectsPresence("old")).toBeUndefined();
    });

    it("keeps an existing included tag included when an excluded tag is renamed onto it", () => {
        seed({
            fileIdsByTag: { old: [1], fresh: [2] },
            effectsExcluded: ["old"],
        });
        useTagStore.getState().applyTagRename("old", "fresh");

        expect(effectsPresence("fresh")).toBeUndefined();
        expect(effectsPresence("old")).toBeUndefined();
    });

    it("keeps an existing excluded tag excluded when an excluded tag is renamed onto it", () => {
        seed({
            fileIdsByTag: { old: [1], fresh: [2] },
            effectsExcluded: ["old", "fresh"],
        });
        useTagStore.getState().applyTagRename("old", "fresh");

        expect(effectsPresence("fresh")).toBe(false);
    });

    it("includes an existing excluded tag when an included tag is renamed onto it", () => {
        seed({
            fileIdsByTag: { old: [1], fresh: [2] },
            effectsExcluded: ["fresh"],
        });
        useTagStore.getState().applyTagRename("old", "fresh");

        expect(effectsPresence("fresh")).toBeUndefined();
    });

    it("does nothing for a tag that is not in the index", () => {
        seed({ fileIdsByTag: { other: [1] } });
        useTagStore.getState().applyTagRename("missing", "fresh");

        expect(useTagStore.getState().tags).toEqual(["other"]);
    });

    it("renames a registered empty tag", () => {
        seed({ fileIdsByTag: {}, registered: ["old"] });
        useTagStore.getState().applyTagRename("old", "fresh");

        const state = useTagStore.getState();
        expect(state.registeredTagNames).toEqual(["fresh"]);
        expect(state.tags).toEqual(["fresh"]);
    });
});

describe("applyTagDelete", () => {
    it("drops files, type config, registration and filter clauses", () => {
        seed({
            fileIdsByTag: { doomed: [1], other: [2] },
            tagTypeByName: { doomed: "genre" },
            kitNearness: ["doomed"],
            effectsExcluded: ["doomed"],
            registered: ["doomed"],
        });
        useTagStore.getState().updateTagFilter("gallery", (filter) =>
            setTagFilterModeOnFilter(filter, "doomed", "include"));
        useTagStore.getState().applyTagDelete("doomed");

        const state = useTagStore.getState();
        expect(state.tags).toEqual(["other"]);
        expect(state.fileIdsByTag.has("doomed")).toBe(false);
        expect(state.typeConfig.tagTypeByName.has("doomed")).toBe(false);
        expect(state.typeConfig.includeInKitNearnessByName.has("doomed")).toBe(false);
        expect(effectsPresence("doomed")).toBeUndefined();
        expect(state.registeredTagNames).toEqual([]);
        expect(state.tagFilter.root.children).toEqual([]);
    });

    it("persists the type config", () => {
        seed({ fileIdsByTag: { doomed: [1] } });
        vi.mocked(enqueueOrganizerConfigPatch).mockClear();
        useTagStore.getState().applyTagDelete("doomed");

        expect(enqueueOrganizerConfigPatch).toHaveBeenCalledWith(
            expect.objectContaining({ tagTypes: expect.anything() }),
        );
    });
});

describe("applyTagMerge", () => {
    it("unions files into the target and removes the sources", () => {
        seed({ fileIdsByTag: { a: [1], b: [2], target: [3] } });
        useTagStore.getState().applyTagMerge(["a", "b"], "target");

        const state = useTagStore.getState();
        expect(state.tags).toEqual(["target"]);
        expect(fileIds("target")).toEqual([1, 2, 3]);
    });

    it("removes source clauses from the filter", () => {
        seed({ fileIdsByTag: { a: [1], target: [3] } });
        useTagStore.getState().updateTagFilter("gallery", (filter) =>
            setTagFilterModeOnFilter(filter, "a", "include"));
        useTagStore.getState().applyTagMerge(["a"], "target");

        expect(useTagStore.getState().tagFilter.root.children).toEqual([]);
    });

    it("uses the target's type, else the first source with a type", () => {
        seed({
            fileIdsByTag: { a: [1], b: [2], t1: [3], t2: [4] },
            tagTypeByName: { b: "genre", t2: "default" },
        });
        useTagStore.getState().applyTagMerge(["a", "b"], "t1");
        useTagStore.getState().applyTagMerge(["t1"], "t2");

        const { tagTypeByName } = useTagStore.getState().typeConfig;
        expect(tagTypeByName.get("t1")).toBeUndefined();
        expect(tagTypeByName.get("t2")).toBe("default");
        expect(tagTypeByName.has("a")).toBe(false);
        expect(tagTypeByName.has("b")).toBe(false);
    });

    it("gives a new target the first source type", () => {
        seed({
            fileIdsByTag: { a: [1], b: [2] },
            tagTypeByName: { b: "genre" },
        });
        useTagStore.getState().applyTagMerge(["a", "b"], "fresh");

        expect(useTagStore.getState().typeConfig.tagTypeByName.get("fresh")).toBe(
            "genre",
        );
    });

    it("ORs kit-nearness inclusion across sources and target", () => {
        seed({
            fileIdsByTag: { a: [1], b: [2], t: [3] },
            kitNearness: ["b"],
        });
        useTagStore.getState().applyTagMerge(["a", "b"], "t");

        const { includeInKitNearnessByName } = useTagStore.getState().typeConfig;
        expect(includeInKitNearnessByName.get("t")).toBe(true);
        expect(includeInKitNearnessByName.has("b")).toBe(false);
    });

    it("keeps a brand-new target excluded when every source is excluded", () => {
        seed({
            fileIdsByTag: { a: [1], b: [2] },
            effectsExcluded: ["a", "b"],
        });
        useTagStore.getState().applyTagMerge(["a", "b"], "fresh");

        expect(effectsPresence("fresh")).toBe(false);
        expect(effectsPresence("a")).toBeUndefined();
    });

    it("includes the target when any source is included", () => {
        seed({
            fileIdsByTag: { a: [1], b: [2] },
            effectsExcluded: ["a"],
        });
        useTagStore.getState().applyTagMerge(["a", "b"], "fresh");

        expect(effectsPresence("fresh")).toBeUndefined();
    });

    it("includes an existing included target when merging excluded sources", () => {
        seed({
            fileIdsByTag: { a: [1], t: [2] },
            effectsExcluded: ["a"],
        });
        useTagStore.getState().applyTagMerge(["a"], "t");

        expect(effectsPresence("t")).toBeUndefined();
    });

    it("keeps an existing excluded target excluded when merging excluded sources", () => {
        seed({
            fileIdsByTag: { a: [1], t: [2] },
            effectsExcluded: ["a", "t"],
        });
        useTagStore.getState().applyTagMerge(["a"], "t");

        expect(effectsPresence("t")).toBe(false);
    });

    it("registers an empty target and drops registered sources", () => {
        seed({ fileIdsByTag: {}, registered: ["a"] });
        useTagStore.getState().applyTagMerge(["a"], "fresh");

        const state = useTagStore.getState();
        expect(state.registeredTagNames).toEqual(["fresh"]);
        expect(state.tags).toEqual(["fresh"]);
    });

    it("retires the target's registration once it has files", () => {
        seed({
            fileIdsByTag: { a: [1] },
            registered: ["t"],
        });
        useTagStore.getState().applyTagMerge(["a"], "t");

        expect(useTagStore.getState().registeredTagNames).toEqual([]);
        expect(fileIds("t")).toEqual([1]);
    });
});
