import type { JSX } from "react";
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
import { Spinner } from "@/components/ui/spinner";

interface ConfirmTrashModalProps {
    open: boolean;
    fileCount: number;
    linkCount: number;
    dryRun: boolean;
    isWorking: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ConfirmTrashModal({
    open,
    fileCount,
    linkCount,
    dryRun,
    isWorking,
    onCancel,
    onConfirm,
}: ConfirmTrashModalProps): JSX.Element {
    return (
        <AlertDialog open={open} onOpenChange={(next) => {
            if (!next && !isWorking) {
                onCancel();
            }
        }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {dryRun ? "Preview cleanup" : "Move duplicates to trash?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {dryRun ? (
                            "Dry run enabled — no files will be changed."
                        ) : null}
                        {fileCount} file{fileCount === 1 ? "" : "s"} will be
                        moved to trash.
                        {linkCount > 0 ?
                            ` ${linkCount} album link${linkCount === 1 ? "" : "s"} will be added so keepers stay visible where copies were.` :
                            ""}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isWorking}>
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant={dryRun ? "default" : "destructive"}
                        disabled={isWorking || fileCount === 0}
                        onClick={onConfirm}
                    >
                        {dryRun ?
                            "Close preview" :
                            isWorking ?
                                <>
                                    <Spinner data-icon="inline-start" />
                                    Working…
                                </> :
                                "Move to trash"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
