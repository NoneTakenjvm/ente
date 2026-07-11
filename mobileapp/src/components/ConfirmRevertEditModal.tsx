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

interface ConfirmRevertEditModalProps {
    open: boolean;
    isWorking: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * Confirm restoring the previous local crop/rotate version of this photo.
 */
export function ConfirmRevertEditModal({
    open,
    isWorking,
    onCancel,
    onConfirm,
}: ConfirmRevertEditModalProps): JSX.Element {
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
                    <AlertDialogTitle>Revert last edit?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This restores the previous version of this photo from
                        this device. The change uploads in the background.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isWorking}>
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        disabled={isWorking}
                        onClick={(event) => {
                            event.preventDefault();
                            onConfirm();
                        }}
                    >
                        {isWorking ? (
                            <>
                                <Spinner data-icon="inline-start" />
                                Reverting…
                            </>
                        ) : (
                            "Revert"
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
