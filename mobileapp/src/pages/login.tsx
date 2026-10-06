import { useEffect, useLayoutEffect, useState, type JSX } from "react";
import { useRouter } from "next/router";
import { LoginForm } from "@/components/LoginForm";
import { UnlockForm } from "@/components/UnlockForm";
import {
    isSessionAuthenticated,
    isSessionLockedForLogin,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";

export default function LoginPage(): JSX.Element {
    const router = useRouter();
    const restoreFromPersistence = useSessionStore((s) => s.restoreFromPersistence);
    // Lock state lives in sessionStorage; read it after hydration (before paint)
    // so the static HTML and the first client render match.
    const [showUnlock, setShowUnlock] = useState<boolean>(false);

    useLayoutEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after hydration
        setShowUnlock(isSessionLockedForLogin());
    }, []);

    useEffect(() => {
        const bootstrap = async (): Promise<void> => {
            reconcileSessionWithCore();
            if (!isSessionAuthenticated()) {
                await restoreFromPersistence();
            }
            if (isSessionAuthenticated()) {
                void router.replace("/gallery");
                return;
            }
            setShowUnlock(isSessionLockedForLogin());
        };
        void bootstrap();
    }, [restoreFromPersistence, router]);

    return (
        <main className="flex min-h-dvh items-center justify-center px-4 py-8 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            {showUnlock ? (
                <UnlockForm onUseDifferentAccount={() => setShowUnlock(false)} />
            ) : (
                <LoginForm />
            )}
        </main>
    );
}
