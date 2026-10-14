import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import type * as OutboxRunner from "@/lib/outbox-runner";
import type * as TagOutbox from "@/lib/tag-outbox";
import type * as VisibilityOutbox from "@/lib/visibility-outbox";

const mocks = vi.hoisted(() => ({
    removeFavoriteOutbox: vi.fn(async () => undefined),
    removeFavoriteMembership: vi.fn(async () => undefined),
    removeTagOutbox: vi.fn(async () => undefined),
    removeVisibilityOutbox: vi.fn(async () => undefined),
    removeDerivedReplaceOutbox: vi.fn(async () => undefined),
    seedTrashedFiles: vi.fn(async () => undefined),
    saveEncryptedFiles: vi.fn(async () => undefined),
}));

vi.mock("@/core", () => ({
    getEnteCore: () => ({
        getUserID: () => 1,
        moveFilesToTrash: vi.fn(async () => undefined),
        getCollectionFilesContext: () => ({}),
    }),
}));
vi.mock("@/db/file-shards", () => ({
    loadEncryptedFilesSharded: vi.fn(),
    markLibraryCacheFilesDirty: vi.fn(),
    saveEncryptedFilesSharded: mocks.saveEncryptedFiles,
}));
vi.mock("@/db/kv", () => ({
    loadKv: vi.fn(),
    saveKv: vi.fn(),
}));
vi.mock("@/lib/cache-key", () => ({
    initSessionCacheKey: vi.fn(),
    getSessionCacheKey: () => "key",
    hasSessionCacheKey: () => false,
}));
vi.mock("@/lib/dedup-prune", () => ({
    planDuplicateGroupPrune: (groups: Array<{ filesToTrash: EnteFile[] }>) => ({
        filesToTrash: groups.flatMap((group) => group.filesToTrash),
    }),
    pruneDuplicateGroups: vi.fn(async () => undefined),
}));
vi.mock("@/lib/favorite-outbox", () => ({
    ensureFavoriteOutboxHydrated: vi.fn(),
    getFavoriteOutboxEntries: () => [],
    hydrateFavoriteOutbox: vi.fn(),
    reconcileFavoriteOutboxWithLibrary: vi.fn(),
    removeFavoriteOutboxForFileIds: mocks.removeFavoriteOutbox,
    upsertFavoriteOutboxEntry: vi.fn(),
    remapFavoriteOutboxFileId: vi.fn(),
}));
vi.mock("@/lib/favorite-membership", () => ({
    ensureFavoriteMembershipHydrated: vi.fn(),
    hydrateFavoriteMembership: vi.fn(),
    remapFavoriteMembershipFileId: vi.fn(),
    removeFavoriteMembershipForFileIds: mocks.removeFavoriteMembership,
    resetFavoriteMembershipForFullSync: vi.fn(),
}));
vi.mock("@/lib/derived-replace-outbox", () => ({
    remapDerivedReplaceOutboxFileId: vi.fn(),
    removeDerivedReplaceOutboxEntries: mocks.removeDerivedReplaceOutbox,
    removeDerivedReplaceOutboxEntryIfCurrent: vi.fn(),
    upsertDerivedReplaceOutboxEntry: vi.fn(),
}));
vi.mock("@/lib/tag-outbox", async (importActual) => ({
    ...(await importActual<typeof TagOutbox>()),
    removeTagOutboxEntries: mocks.removeTagOutbox,
}));
vi.mock("@/lib/visibility-outbox", async (importActual) => ({
    ...(await importActual<typeof VisibilityOutbox>()),
    removeVisibilityOutboxEntries: mocks.removeVisibilityOutbox,
    upsertVisibilityOutboxEntry: vi.fn(async () => undefined),
}));
vi.mock("@/lib/outbox-runner", async (importActual) => ({
    ...(await importActual<typeof OutboxRunner>()),
    drainTagOutbox: vi.fn(async () => undefined),
}));
vi.mock("@/stores/trash-store", () => ({
    useTrashStore: {
        getState: () => ({ items: [], seedTrashedFiles: mocks.seedTrashedFiles }),
    },
}));

import { useLibraryStore } from "../library-store";

const file = (id: number): EnteFile => ({ id } as EnteFile);

describe("library-store file removal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useLibraryStore.setState({
            allFiles: [file(1), file(2), file(3)],
            fileIndexById: new Map([[1, 0], [2, 1], [3, 2]]),
        });
    });

    const expectAllStateCleared = (ids: number[]): void => {
        expect(mocks.seedTrashedFiles).toHaveBeenCalled();
        expect(mocks.removeFavoriteOutbox).toHaveBeenCalledWith(ids);
        expect(mocks.removeFavoriteMembership).toHaveBeenCalledWith(ids);
        expect(mocks.removeTagOutbox).toHaveBeenCalledWith(ids);
        expect(mocks.removeVisibilityOutbox).toHaveBeenCalledWith(ids);
        expect(mocks.removeDerivedReplaceOutbox).toHaveBeenCalledWith(ids);
    };

    it("moveFilesToTrash drops the files and clears every outbox", async () => {
        await useLibraryStore.getState().moveFilesToTrash([2]);
        expect(useLibraryStore.getState().allFiles.map((f) => f.id)).toEqual([
            1,
            3,
        ]);
        expect([...useLibraryStore.getState().fileIndexById]).toEqual([
            [1, 0],
            [3, 1],
        ]);
        expectAllStateCleared([2]);
    });

    it("pruneDuplicateGroups clears the same state as trash", async () => {
        const syncRemote = vi.fn(async () => undefined);
        useLibraryStore.setState({ syncRemote });
        await useLibraryStore.getState().pruneDuplicateGroups([
            { isSelected: true, filesToTrash: [file(3)] } as never,
        ]);
        expect(useLibraryStore.getState().allFiles.map((f) => f.id)).toEqual([
            1,
            2,
        ]);
        expectAllStateCleared([3]);
    });

    it("patches copy the library array instead of mutating it", async () => {
        const before = useLibraryStore.getState().allFiles;
        const untouched = before[0];
        await useLibraryStore.getState().batchSetArchived([2], true);
        const after = useLibraryStore.getState().allFiles;
        expect(after).not.toBe(before);
        expect(before.map((f) => f.id)).toEqual([1, 2, 3]);
        expect(before[1]!.magicMetadata).toBeUndefined();
        expect(after[1]!.magicMetadata?.data?.visibility).toBeDefined();
        expect(after[0]).toBe(untouched);
    });
});
