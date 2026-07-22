import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { isOrganizerConfigCollection } from "@/lib/organizer-config";
import { useLibraryStore } from "@/stores/library-store";
import { useSessionStore } from "@/stores/session-store";
import { useTrashStore } from "@/stores/trash-store";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";

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
    const errorMessage = useTrashStore((s) => s.errorMessage);
    const hydrateFromCache = useTrashStore((s) => s.hydrateFromCache);
    const syncTrash = useTrashStore((s) => s.syncTrash);
    const restoreToCollection = useTrashStore((s) => s.restoreToCollection);
    const deleteForever = useTrashStore((s) => s.deleteForever);
    const emptyTrash = useTrashStore((s) => s.emptyTrash);

    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState<boolean>(false);
    const [actionError, setActionError] = useState<string | undefined>();
    const [confirm, setConfirm] = useState<PendingConfirm>(undefined);
    const didInitialSyncRef = useRef(false);

    const targets = useMemo(
        () => restoreTargets(collections, userId),
        [collections, userId],
    );
    const defaultTargetId =
        targets.find((collection) => collection.type === "uncategorized")?.id ??
        targets[0]?.id;
    const [restoreCollectionId, setRestoreCollectionId] = useState<
        number | undefined
    >(defaultTargetId);

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

    useEffect(() => {
        if (
            restoreCollectionId === undefined ||
            !targets.some((collection) => collection.id === restoreCollectionId)
        ) {
            setRestoreCollectionId(defaultTargetId);
        }
    }, [defaultTargetId, restoreCollectionId, targets]);

    const trashFiles = useMemo(
        () => items.map((item) => item.file),
        [items],
    );

    const handleToggle = (file: EnteFile): void => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(file.id)) {
                next.delete(file.id);
            } else {
                next.add(file.id);
            }
            return next;
        });
    };

    const runBusy = async (action: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setActionError(undefined);
        try {
            await action();
            setSelectedIds(new Set());
        } catch (error) {
            setActionError(
                error instanceof Error ? error.message : "Trash action failed",
            );
        } finally {
            setBusy(false);
        }
    };

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
        });
    };

    const handleConfirmDestructive = (): void => {
        const pending = confirm;
        setConfirm(undefined);
        if (pending === "empty") {
            void runBusy(async () => {
                await emptyTrash();
            });
            return;
        }
        if (pending === "deleteForever" && selectedIds.size > 0) {
            void runBusy(async () => {
                await deleteForever([...selectedIds]);
            });
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

    const soonestDays = Math.min(
        ...items.map((item) => daysUntilDelete(item.deleteBy)),
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="shrink-0 space-y-1 px-4 pt-3">
                <p className="text-xs text-muted-foreground">
                    {items.length} item{items.length === 1 ? "" : "s"} · earliest
                    permanent delete in {soonestDays} day
                    {soonestDays === 1 ? "" : "s"}
                </p>
                {isSyncing ? (
                    <p className="text-xs text-muted-foreground">Syncing…</p>
                ) : null}
            </div>
            {errorMessage || actionError ? (
                <Alert variant="destructive" className="mx-4 shrink-0">
                    <AlertDescription>
                        {actionError ?? errorMessage}
                    </AlertDescription>
                </Alert>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col px-2">
                <ThumbnailGrid
                    files={trashFiles}
                    selection={{
                        selectedIds,
                        onToggle: handleToggle,
                        disabled: busy,
                    }}
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
                                setRestoreCollectionId(Number(value));
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

            <AlertDialog
                open={confirm !== undefined}
                onOpenChange={(open) => {
                    if (!open && !busy) {
                        setConfirm(undefined);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirm === "empty" ?
                                "Empty trash permanently?" :
                                "Delete forever?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm === "empty" ?
                                `Permanently delete all ${items.length} item${items.length === 1 ? "" : "s"} in trash. This cannot be undone.` :
                                `Permanently delete ${selectedIds.size} selected item${selectedIds.size === 1 ? "" : "s"}. This cannot be undone.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={busy}
                            onClick={handleConfirmDestructive}
                        >
                            {busy ? <Spinner /> : "Delete permanently"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
