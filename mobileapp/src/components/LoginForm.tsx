import { useState, type FormEvent, type JSX } from "react";
import { useRouter } from "next/router";
import { testAccountCredentials } from "@/dev/test-account";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Field,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
    isSessionAuthenticated,
    useSessionStore,
} from "@/stores/session-store";

const isDev = process.env.NODE_ENV === "development";

export function LoginForm(): JSX.Element {
    const router = useRouter();
    const login = useSessionStore((s) => s.login);
    const status = useSessionStore((s) => s.status);
    const errorMessage = useSessionStore((s) => s.errorMessage);

    const [email, setEmail] = useState<string>("");
    const [password, setPassword] = useState<string>("");
    const [totp, setTotp] = useState<string>("");

    const loading: boolean = status === "loading";

    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        try {
            await login({
                email: email.trim(),
                password,
                totp: totp.trim() || undefined,
            });
            if (isSessionAuthenticated()) {
                await router.replace("/gallery");
            }
        } catch {
            // Error state is set in the session store.
        }
    };

    const handleDevLogin = async (): Promise<void> => {
        try {
            await login(testAccountCredentials);
            if (isSessionAuthenticated()) {
                await router.replace("/gallery");
            }
        } catch {
            // Error state is set in the session store.
        }
    };

    return (
        <Card className="w-full max-w-sm border-border/60 shadow-lg">
            <CardHeader className="text-center">
                <CardTitle className="text-xl">NTPhotos</CardTitle>
                <CardDescription>Sign in to view your library</CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit}>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="login-email">Email</FieldLabel>
                            <Input
                                id="login-email"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                disabled={loading}
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="login-password">
                                Password
                            </FieldLabel>
                            <Input
                                id="login-password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                disabled={loading}
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="login-totp">
                                2FA code (if enabled)
                            </FieldLabel>
                            <Input
                                id="login-totp"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="123456"
                                value={totp}
                                onChange={(e) => setTotp(e.target.value)}
                                disabled={loading}
                            />
                        </Field>

                        {errorMessage ? (
                            <Alert variant="destructive">
                                <AlertDescription>{errorMessage}</AlertDescription>
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
                                    Signing in…
                                </>
                            ) : (
                                "Sign in"
                            )}
                        </Button>

                        {isDev ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="w-full"
                                disabled={loading}
                                onClick={() => void handleDevLogin()}
                            >
                                {loading ? (
                                    <>
                                        <Spinner data-icon="inline-start" />
                                        Signing in…
                                    </>
                                ) : (
                                    "Dev: test account"
                                )}
                            </Button>
                        ) : null}
                    </FieldGroup>
                </form>
            </CardContent>
        </Card>
    );
}
