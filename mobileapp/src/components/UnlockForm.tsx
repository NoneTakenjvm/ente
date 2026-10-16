import { useEffect, useState, type FormEvent, type JSX } from "react";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { loadPersistedSession } from "@/lib/session-persistence";
import { useSessionStore } from "@/stores/session-store";
import { errorMessage } from "@/lib/format";

interface UnlockFormProps {
    onUseDifferentAccount: () => void;
}

/** Asks for the password only; the master key is derived locally. */
export function UnlockForm({
    onUseDifferentAccount,
}: UnlockFormProps): JSX.Element {
    const router = useRouter();
    const unlock = useSessionStore((s) => s.unlock);
    const signOut = useSessionStore((s) => s.logout);
    const [password, setPassword] = useState<string>("");
    const [loading, setLoading] = useState<boolean>(false);
    const [unlockError, setUnlockError] = useState<string | undefined>();
    const [email] = useState<string | undefined>(
        () => loadPersistedSession()?.email,
    );

    useEffect(() => {
        if (!loadPersistedSession()) {
            onUseDifferentAccount();
        }
    }, [onUseDifferentAccount]);

    const handleUnlock = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setLoading(true);
        setUnlockError(undefined);
        try {
            await unlock(password);
            await router.replace("/gallery");
        } catch (error) {
            setUnlockError(errorMessage(error, "Unlock failed"));
            setLoading(false);
        }
    };

    const handleSignOut = (): void => {
        setLoading(true);
        // Wait for the clear so it cannot wipe a login started right after.
        void signOut().then(onUseDifferentAccount);
    };

    return (
        <Card className="w-full max-w-sm border-border/60 shadow-lg">
            <CardHeader className="text-center">
                <CardTitle className="text-xl">NTPhotos</CardTitle>
                <CardDescription>
                    {email ?
                        `Enter your password to unlock ${email}` :
                        "Enter your password to unlock"}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={(event) => void handleUnlock(event)}>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="unlock-password">
                                Password
                            </FieldLabel>
                            <Input
                                id="unlock-password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                disabled={loading}
                            />
                        </Field>

                        {unlockError ? (
                            <Alert variant="destructive">
                                <AlertDescription>{unlockError}</AlertDescription>
                            </Alert>
                        ) : null}

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={loading}
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
                            onClick={handleSignOut}
                        >
                            Sign out / use a different account
                        </Button>
                    </FieldGroup>
                </form>
            </CardContent>
        </Card>
    );
}
