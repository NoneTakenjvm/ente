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

interface ConfirmBatchTrashModalProps {
    open: boolean;
    count: number;
    isWorking: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ConfirmBatchTrashModal({
    open,
    count,
    isWorking,
    onCancel,
    onConfirm,
}: ConfirmBatchTrashModalProps): JSX.Element {
    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (!next && !isWorking) {
                    onCancel();
                }
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        Move {count} item{count === 1 ? "" : "s"} to trash?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        They can be restored from the Ente app.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isWorking}>
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={isWorking}
                        onClick={onConfirm}
                    >
                        {isWorking ? (
                            <>
                                <Spinner data-icon="inline-start" />
                                Working…
                            </>
                        ) : (
                            "Move to trash"
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
