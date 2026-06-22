import { useEffect, useState, type JSX } from "react";
import { useRouter } from "next/router";
import { testAccountCredentials } from "@/dev/test-account";
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
            if (process.env.NODE_ENV !== "development") {
                return;
            }
            setStep("logging-in");
            try {
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
