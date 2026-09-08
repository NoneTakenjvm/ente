import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { ItemVisibility } from "ente-media/file-metadata";
import { planLibraryFilePatches } from "@/lib/library-file-patch";
import { fileWithOrganizerTags } from "@/lib/tag-writes";

const stubFile = (
    id: number,
    tags: string[],
    version = 1,
    archived = false,
): EnteFile => {
    const withTags = fileWithOrganizerTags({ id } as EnteFile, tags);
    return {
        ...withTags,
        pubMagicMetadata: withTags.pubMagicMetadata ?
            {
                ...withTags.pubMagicMetadata,
                version,
            } :
            withTags.pubMagicMetadata,
        magicMetadata: archived ?
            {
                version: 1,
                count: 1,
                data: { visibility: ItemVisibility.archived },
            } :
            withTags.magicMetadata,
    } as EnteFile;
};

describe("planLibraryFilePatches", () => {
    it("skips notify when only pubMagic version advances and tags match", () => {
        const local = stubFile(1, ["a", "b"], 1);
        const remote = stubFile(1, ["a", "b"], 2);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
        );
        expect(plan.notifyNeeded).toBe(false);
        expect(plan.persistNeeded).toBe(true);
        expect(plan.nextFiles[0]).toBe(remote);
    });

    it("is a true no-op when version and tags already match", () => {
        const local = stubFile(1, ["a"], 3);
        const remote = stubFile(1, ["a"], 3);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
        );
        expect(plan.notifyNeeded).toBe(false);
        expect(plan.persistNeeded).toBe(false);
        expect(plan.nextFiles[0]).toBe(local);
    });

    it("notifies when tags change", () => {
        const local = stubFile(1, ["a"], 1);
        const remote = stubFile(1, ["b"], 2);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
        );
        expect(plan.notifyNeeded).toBe(true);
        expect(plan.persistNeeded).toBe(true);
        expect(plan.nextFiles[0]).toBe(remote);
    });

    it("notifies when archive visibility changes even if tags match", () => {
        const local = stubFile(1, ["a"], 1);
        const remote = stubFile(1, ["a"], 2, true);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
        );
        expect(plan.notifyNeeded).toBe(true);
        expect(plan.persistNeeded).toBe(true);
    });

    it("batches many version-only patches without notify", () => {
        const locals = [stubFile(1, ["x"], 1), stubFile(2, ["y"], 1)];
        const remotes = new Map([
            [1, stubFile(1, ["x"], 2)],
            [2, stubFile(2, ["y"], 2)],
        ]);
        const plan = planLibraryFilePatches(locals, remotes);
        expect(plan.notifyNeeded).toBe(false);
        expect(plan.persistNeeded).toBe(true);
        expect(plan.nextFiles).toEqual([remotes.get(1), remotes.get(2)]);
    });
});
