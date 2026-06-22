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

interface ConfirmPanicModalProps {
    open: boolean;
    isWorking: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export function ConfirmPanicModal({
    open,
    isWorking,
    onCancel,
    onConfirm,
}: ConfirmPanicModalProps): JSX.Element {
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
                    <AlertDialogTitle>Wipe all local data?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This permanently deletes every cached photo, tag index,
                        and saved session on this device. You will need to sign
                        in and re-sync from scratch.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isWorking}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={isWorking}
                        onClick={(event) => {
                            event.preventDefault();
                            onConfirm();
                        }}
                    >
                        {isWorking ? (
                            <>
                                <Spinner />
                                Wiping…
                            </>
                        ) : (
                            "Wipe everything"
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
