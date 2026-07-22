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

interface ConfirmDeleteModalProps {
    open: boolean;
    isWorking: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ConfirmDeleteModal({
    open,
    isWorking,
    onCancel,
    onConfirm,
}: ConfirmDeleteModalProps): JSX.Element {
    return (
        <AlertDialog open={open} onOpenChange={(next) => {
            if (!next && !isWorking) {
                onCancel();
            }
        }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        Move this photo to trash?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        It can be restored from Manage → Trash within 30 days.
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
