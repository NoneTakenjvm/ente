import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useGridSelection } from "@/hooks/use-grid-selection";
import { isOrganizerConfigCollection } from "@/lib/organizer-config";
import { useLibraryStore } from "@/stores/library-store";
import { useSessionStore } from "@/stores/session-store";
import { useTrashStore } from "@/stores/trash-store";
import type { Collection } from "ente-media/collection";
import { plural } from "@/lib/format";

const daysUntilDelete = (deleteByMicros: number): number => {
    const msLeft = deleteByMicros / 1000 - Date.now();
    return Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
};

const restoreTargets = (
    collections: Collection[],
    userId: number,
): Collection[] =>
    collections
        .filter(
            (collection) =>
                collection.owner.id === userId &&
                !isOrganizerConfigCollection(collection) &&
                collection.type !== "favorites",
        )
        .sort((a, b) => a.name.localeCompare(b.name));

type PendingConfirm = "empty" | "deleteForever" | undefined;

/**
 * Browse Ente trash: restore to an album, permanently delete, or empty.
 */
export function ManageTrashPanel(): JSX.Element {
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const collections = useLibraryStore((s) => s.collections);
    const reinsertRestoredFiles = useLibraryStore(
        (s) => s.reinsertRestoredFiles,
    );

    const items = useTrashStore((s) => s.items);
    const isHydrated = useTrashStore((s) => s.isHydrated);
    const isSyncing = useTrashStore((s) => s.isSyncing);
    const storeError = useTrashStore((s) => s.errorMessage);
    const hydrateFromCache = useTrashStore((s) => s.hydrateFromCache);
    const syncTrash = useTrashStore((s) => s.syncTrash);
    const restoreToCollection = useTrashStore((s) => s.restoreToCollection);
    const deleteForever = useTrashStore((s) => s.deleteForever);
    const emptyTrash = useTrashStore((s) => s.emptyTrash);

    const [confirm, setConfirm] = useState<PendingConfirm>(undefined);
    const didInitialSyncRef = useRef(false);

    const targets = useMemo(
        () => restoreTargets(collections, userId),
        [collections, userId],
    );
    const defaultTargetId =
        targets.find((collection) => collection.type === "uncategorized")?.id ??
        targets[0]?.id;
    const [pickedRestoreId, setPickedRestoreId] = useState<
        number | undefined
    >();
    const restoreCollectionId = targets.some(
        (collection) => collection.id === pickedRestoreId,
    ) ?
        pickedRestoreId :
        defaultTargetId;

    useEffect(() => {
        if (didInitialSyncRef.current) {
            return;
        }
        didInitialSyncRef.current = true;
        void (async (): Promise<void> => {
            if (!useTrashStore.getState().isHydrated) {
                await hydrateFromCache();
            }
            await syncTrash(
                useLibraryStore.getState().collections,
            ).catch(() => undefined);
        })();
    }, [hydrateFromCache, syncTrash]);

    const trashFiles = useMemo(
        () => items.map((item) => item.file),
        [items],
    );

    const { selectedIds, selection, busy, actionError, runBusy } =
        useGridSelection(trashFiles);

    const handleRestore = (): void => {
        const collection = targets.find(
            (entry) => entry.id === restoreCollectionId,
        );
        if (!collection || selectedIds.size === 0) {
            return;
        }
        void runBusy(async () => {
            const restored = await restoreToCollection(
                [...selectedIds],
                collection,
            );
            await reinsertRestoredFiles(restored);
        }, "Trash action failed");
    };

    const handleConfirmDestructive = (): void => {
        const pending = confirm;
        setConfirm(undefined);
        if (pending === "empty") {
            void runBusy(emptyTrash, "Trash action failed");
            return;
        }
        if (pending === "deleteForever" && selectedIds.size > 0) {
            void runBusy(
                () => deleteForever([...selectedIds]),
                "Trash action failed",
            );
        }
    };

    if (!isHydrated && isSyncing) {
        return (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading trash…
            </div>
        );
    }

    if (trashFiles.length === 0) {
        return (
            <Empty className="flex-1 border-0">
                <EmptyHeader>
                    <EmptyTitle>Trash is empty</EmptyTitle>
                    <EmptyDescription>
                        Deleted photos stay here for 30 days before permanent
                        removal.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    let soonestDays = Number.POSITIVE_INFINITY;
    for (const item of items) {
        soonestDays = Math.min(soonestDays, daysUntilDelete(item.deleteBy));
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="shrink-0 space-y-1 px-4 pt-3">
                <p className="text-xs text-muted-foreground">
                    {plural(items.length, "item")} · earliest
                    permanent delete in {plural(soonestDays, "day")}
                </p>
                {isSyncing ? (
                    <p className="text-xs text-muted-foreground">Syncing…</p>
                ) : null}
            </div>
            {storeError || actionError ? (
                <Alert variant="destructive" className="mx-4 shrink-0">
                    <AlertDescription>
                        {actionError ?? storeError}
                    </AlertDescription>
                </Alert>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col px-2">
                <ThumbnailGrid
                    files={trashFiles}
                    selection={selection}
                />
            </div>
            <footer className="shrink-0 space-y-2 border-t border-border px-4 py-3">
                {selectedIds.size > 0 ? (
                    <>
                        <Select
                            value={
                                restoreCollectionId !== undefined ?
                                    String(restoreCollectionId) :
                                    undefined
                            }
                            onValueChange={(value) => {
                                if (!value) {
                                    return;
                                }
                                setPickedRestoreId(Number(value));
                            }}
                            disabled={busy || targets.length === 0}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Restore to album" />
                            </SelectTrigger>
                            <SelectContent>
                                {targets.map((collection) => (
                                    <SelectItem
                                        key={collection.id}
                                        value={String(collection.id)}
                                    >
                                        {collection.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                className="flex-1 gap-2"
                                disabled={busy || !restoreCollectionId}
                                onClick={handleRestore}
                            >
                                {busy ? <Spinner /> : <RotateCcw />}
                                Restore ({selectedIds.size})
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                className="flex-1 gap-2"
                                disabled={busy}
                                onClick={() => setConfirm("deleteForever")}
                            >
                                {busy ? <Spinner /> : <Trash2 />}
                                Delete forever
                            </Button>
                        </div>
                    </>
                ) : (
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full gap-2"
                        disabled={busy}
                        onClick={() => setConfirm("empty")}
                    >
                        {busy ? <Spinner /> : <Trash2 />}
                        Empty trash
                    </Button>
                )}
            </footer>

            <ConfirmDialog
                open={confirm !== undefined}
                title={
                    confirm === "empty" ?
                        "Empty trash permanently?" :
                        "Delete forever?"
                }
                description={
                    confirm === "empty" ?
                        `Permanently delete all ${plural(items.length, "item")} in trash. This cannot be undone.` :
                        `Permanently delete ${plural(selectedIds.size, "selected item")}. This cannot be undone.`
                }
                confirmLabel="Delete permanently"
                isWorking={busy}
                onCancel={() => setConfirm(undefined)}
                onConfirm={handleConfirmDestructive}
            />
        </div>
    );
}
