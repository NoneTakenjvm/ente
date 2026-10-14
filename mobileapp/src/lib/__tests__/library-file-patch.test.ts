import { describe, expect, it } from "vitest";
import type { EnteFile } from "ente-media/file";
import { ItemVisibility } from "ente-media/file-metadata";
import {
    planLibraryFilePatches,
    patchFilesInLibrary,
} from "@/lib/library-file-patch";
import { buildFileIndexById } from "@/lib/library-file-index";
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

describe("patchFilesInLibrary", () => {
    it("copies the array and leaves the input untouched", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const files = [a, b];
        const patched = stubFile(1, ["z"]);
        const next = patchFilesInLibrary(files, new Map([[1, patched]]));
        expect(next).not.toBe(files);
        expect(next![0]).toBe(patched);
        expect(next![1]).toBe(b);
        expect(files[0]).toBe(a);
    });

    it("returns null when the patch is the file already in the slot", () => {
        const a = stubFile(1, ["x"]);
        expect(
            patchFilesInLibrary([a], new Map([[1, a]]), new Map([[1, 0]])),
        ).toBeNull();
    });

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

    it("visits only patched slots when given an id index", () => {
        const a = stubFile(1, ["x"]);
        const b = stubFile(2, ["y"]);
        const patchedA = stubFile(1, ["xx"]);
        const next = patchFilesInLibrary(
            [a, b],
            new Map([[1, patchedA], [9, stubFile(9, [])]]),
            new Map([[1, 0], [2, 1]]),
        );
        expect(next![0]).toBe(patchedA);
        expect(next![1]).toBe(b);
    });

    it("returns null when nothing matches", () => {
        const a = stubFile(1, ["x"]);
        expect(
            patchFilesInLibrary([a], new Map([[9, stubFile(9, [])]])),
        ).toBeNull();
    });
});

describe("planLibraryFilePatches", () => {
    it("plans a patch when only the pubMagic version advances", () => {
        const local = stubFile(1, ["a", "b"], 1);
        const remote = stubFile(1, ["a", "b"], 2);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
            new Map([[1, 0]]),
        );
        expect(plan.get(1)).toBe(remote);
    });

    it("is a true no-op when version and tags already match", () => {
        const local = stubFile(1, ["a"], 3);
        const remote = stubFile(1, ["a"], 3);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
            new Map([[1, 0]]),
        );
        expect(plan.size).toBe(0);
    });

    it("plans a patch when tags change", () => {
        const local = stubFile(1, ["a"], 1);
        const remote = stubFile(1, ["b"], 2);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
            new Map([[1, 0]]),
        );
        expect(plan.get(1)).toBe(remote);
    });

    it("plans a patch when archive visibility changes even if tags match", () => {
        const local = stubFile(1, ["a"], 1);
        const remote = stubFile(1, ["a"], 2, true);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[1, remote]]),
            new Map([[1, 0]]),
        );
        expect(plan.get(1)).toBe(remote);
    });

    it("batches many version-only patches", () => {
        const locals = [stubFile(1, ["x"], 1), stubFile(2, ["y"], 1)];
        const remotes = new Map([
            [1, stubFile(1, ["x"], 2)],
            [2, stubFile(2, ["y"], 2)],
        ]);
        const plan = planLibraryFilePatches(
            locals,
            remotes,
            buildFileIndexById(locals),
        );
        expect([...plan]).toEqual([...remotes]);
    });

    it("ignores patches for files not in the library", () => {
        const local = stubFile(1, ["a"], 1);
        const plan = planLibraryFilePatches(
            [local],
            new Map([[9, stubFile(9, ["b"], 2)]]),
            new Map([[1, 0]]),
        );
        expect(plan.size).toBe(0);
    });
});
