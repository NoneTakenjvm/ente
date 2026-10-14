import { useEffect, useState, type JSX } from "react";
import { useRouter } from "next/router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
    getLockedSessionEmail,
    hasPersistedSession,
} from "@/lib/session-persistence";
import {
    isSessionAuthenticated,
    useSessionStore,
} from "@/stores/session-store";
import { errorMessage } from "@/lib/format";

interface UnlockFormProps {
    onUseDifferentAccount: () => void;
}

export function UnlockForm({
    onUseDifferentAccount,
}: UnlockFormProps): JSX.Element {
    const router = useRouter();
    const unlock = useSessionStore((s) => s.unlock);
    const signOut = useSessionStore((s) => s.logout);
    const [loading, setLoading] = useState<boolean>(false);
    const [unlockError, setUnlockError] = useState<string | undefined>();

    const email = getLockedSessionEmail();

    useEffect(() => {
        if (!hasPersistedSession()) {
            onUseDifferentAccount();
        }
    }, [onUseDifferentAccount]);

    const handleUnlock = async (): Promise<void> => {
        setLoading(true);
        setUnlockError(undefined);
        try {
            const restored = await unlock();
            if (restored && isSessionAuthenticated()) {
                await router.replace("/gallery");
                return;
            }
            setUnlockError("Could not restore your session. Sign in again.");
        } catch (error) {
            setUnlockError(
                errorMessage(error, "Unlock failed"),
            );
        } finally {
            setLoading(false);
        }
    };

    const handleDifferentAccount = (): void => {
        // Wait for the clear so it cannot wipe a login started right after.
        void signOut().then(onUseDifferentAccount);
    };

    return (
        <Card className="w-full max-w-sm border-border/60 shadow-lg">
            <CardHeader className="text-center">
                <CardTitle className="text-xl">NTPhotos</CardTitle>
                <CardDescription>
                    {email ?
                        `Unlock session for ${email}` :
                        "Unlock your session"}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {unlockError ? (
                    <Alert variant="destructive">
                        <AlertDescription>{unlockError}</AlertDescription>
                    </Alert>
                ) : null}

                <Button
                    type="button"
                    className="w-full"
                    disabled={loading}
                    onClick={() => void handleUnlock()}
                >
                    {loading ? (
                        <>
                            <Spinner data-icon="inline-start" />
                            Unlocking…
                        </>
                    ) : (
                        "Unlock"
                    )}
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={loading}
                    onClick={handleDifferentAccount}
                >
                    Use a different account
                </Button>
            </CardContent>
        </Card>
    );
}
