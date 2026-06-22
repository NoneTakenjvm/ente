import { useEffect, useState, type JSX } from "react";
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
    const [showUnlock, setShowUnlock] = useState<boolean>(isSessionLockedForLogin());

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
