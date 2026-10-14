import { useLibraryStore } from "@/stores/library-store";

/**
 * True while the first cache load / sync is still running and there is nothing
 * to show yet. Pass `fileCount` to also require an empty list.
 */
export function useLibraryLoading(
    initialLoadDone: boolean,
    fileCount?: number,
): boolean {
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    return (
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing") &&
        (fileCount === undefined || fileCount === 0)
    );
}
