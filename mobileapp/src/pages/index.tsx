import { useEffect, useState, type JSX } from "react";
import { useRouter } from "next/router";
import {
    isSessionAuthenticated,
    ensureSessionRestored,
} from "@/stores/session-store";

export default function Home(): JSX.Element {
    const router = useRouter();
    const [ready, setReady] = useState<boolean>(false);

    useEffect(() => {
        const bootstrap = async (): Promise<void> => {
            await ensureSessionRestored();
            setReady(true);
        };
        void bootstrap();
    }, []);

    useEffect(() => {
        if (!ready) {
            return;
        }
        if (isSessionAuthenticated()) {
            void router.replace("/gallery");
            return;
        }
        void router.replace("/login");
    }, [ready, router]);

    return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <h1 className="text-3xl font-semibold tracking-tight">NTPhotos</h1>
            <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
    );
}
