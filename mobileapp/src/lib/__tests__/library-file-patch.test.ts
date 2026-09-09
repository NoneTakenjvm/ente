import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { ItemVisibility } from "ente-media/file-metadata";
import {
    planLibraryFilePatches,
    patchFileInLibrary,
    patchFileInPlace,
    patchFilesInLibrary,
} from "@/lib/library-file-patch";
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

describe("patchFileInPlace", () => {
    it("mutates one slot without copying the array", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const files = [a, b];
        const patched = stubFile(1, ["z"]);
        expect(patchFileInPlace(files, 1, patched)).toBe(true);
        expect(files[0]).toBe(patched);
        expect(files[1]).toBe(b);
        expect(files).toHaveLength(2);
    });

    it("uses an optional id index for O(1) lookup", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const files = [a, b];
        const patched = stubFile(2, ["yy"]);
        expect(
            patchFileInPlace(files, 2, patched, new Map([[1, 0], [2, 1]])),
        ).toBe(true);
        expect(files[1]).toBe(patched);
    });
});

describe("patchFileInLibrary", () => {
    it("replaces one slot and keeps other identities", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const patched = stubFile(1, ["z"]);
        const next = patchFileInLibrary([a, b], 1, patched);
        expect(next).not.toBeNull();
        expect(next![0]).toBe(patched);
        expect(next![1]).toBe(b);
    });

    it("returns null when id is missing", () => {
        expect(
            patchFileInLibrary([stubFile(1, [])], 9, stubFile(9, [])),
        ).toBeNull();
    });
});

describe("patchFilesInLibrary", () => {
    it("applies a sparse map in one copy", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const c = stubFile(3, ["z"]);
        const patchedB = stubFile(2, ["yy"]);
        const next = patchFilesInLibrary(
            [a, b, c],
            new Map([[2, patchedB]]),
        );
        expect(next![0]).toBe(a);
        expect(next![1]).toBe(patchedB);
        expect(next![2]).toBe(c);
    });

    it("returns null when nothing matches", () => {
        const a = stubFile(1, ["x"]);
        expect(
            patchFilesInLibrary([a], new Map([[9, stubFile(9, [])]])),
        ).toBeNull();
    });
});

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
