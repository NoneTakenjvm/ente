import { useEffect, useState, type JSX } from "react";
import { useRouter } from "next/router";
import {
    isSessionAuthenticated,
    useSessionStore,
} from "@/stores/session-store";

/**
 * Dev-only page: one-click login with the throwaway test account.
 * Open /dev-login while `npm run dev` is running.
 */
export default function DevLoginPage(): JSX.Element {
    const router = useRouter();
    const login = useSessionStore((s) => s.login);
    const status = useSessionStore((s) => s.status);
    const errorMessage = useSessionStore((s) => s.errorMessage);
    const [step, setStep] = useState<string>("idle");

    useEffect(() => {
        if (process.env.NODE_ENV !== "development") {
            void router.replace("/login");
        }
    }, [router]);

    useEffect(() => {
        let cancelled = false;

        const run = async (): Promise<void> => {
            // Inline NODE_ENV block so webpack drops the import (and the test
            // credentials chunk) from production builds.
            if (process.env.NODE_ENV === "development") {
                setStep("logging-in");
                try {
                    const { testAccountCredentials } = await import(
                        "@/dev/test-account"
                    );
                    await login(testAccountCredentials);
                    const coreOk = isSessionAuthenticated();
                    if (!cancelled && coreOk) {
                        setStep("navigating");
                        await router.replace("/gallery");
                    }
                } catch {
                    if (!cancelled) {
                        setStep("error");
                    }
                }
            }
        };

        if (step === "idle") {
            void run();
        }

        return (): void => {
            cancelled = true;
        };
    }, [login, router, step]);

    return (
        <main className="flex min-h-dvh items-center justify-center px-4">
            <p>Dev login: {step}</p>
            <p>Status: {status}</p>
            {errorMessage ? <p role="alert">{errorMessage}</p> : null}
        </main>
    );
}
