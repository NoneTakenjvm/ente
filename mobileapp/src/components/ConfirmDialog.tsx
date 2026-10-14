import type { JSX, ReactNode } from "react";
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

interface ConfirmDialogProps {
    open: boolean;
    title: ReactNode;
    description: ReactNode;
    confirmLabel: ReactNode;
    /** Shown next to the spinner while `isWorking`. */
    workingLabel?: string;
    destructive?: boolean;
    isWorking?: boolean;
    confirmDisabled?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * Confirmation dialog with Cancel and a confirm button. Dismissal is blocked
 * while `isWorking`.
 */
export function ConfirmDialog({
    open,
    title,
    description,
    confirmLabel,
    workingLabel = "Working…",
    destructive = false,
    isWorking = false,
    confirmDisabled = false,
    onCancel,
    onConfirm,
}: ConfirmDialogProps): JSX.Element {
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
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {description}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isWorking}>
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant={destructive ? "destructive" : "default"}
                        disabled={isWorking || confirmDisabled}
                        onClick={onConfirm}
                    >
                        {isWorking ? (
                            <>
                                <Spinner data-icon="inline-start" />
                                {workingLabel}
                            </>
                        ) : (
                            confirmLabel
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
