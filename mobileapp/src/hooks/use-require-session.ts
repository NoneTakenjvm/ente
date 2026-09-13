"use client";

import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";

const LOGIN_PATHS = new Set(["/login", "/", "/offline"]);

/**
 * Gate protected pages: wait for session restore, then redirect to login when
 * the in-memory core session is missing. Re-checks on visibility / pageshow so
 * idle-lock while backgrounded cannot leave the UI stuck on "Redirecting…".
 */
export function useRequireSession(): {
    ready: boolean;
    authenticated: boolean;
} {
    const router = useRouter();
    const restoreFromPersistence = useSessionStore(
        (s) => s.restoreFromPersistence,
    );
    // Re-render when idle lock / logout clears Zustand so the gate updates.
    useSessionStore((s) => s.status);
    const [ready, setReady] = useState(false);

    const redirectToLogin = useCallback((): void => {
        if (LOGIN_PATHS.has(router.pathname)) {
            return;
        }
        void router.replace("/login");
    }, [router]);

    useEffect(() => {
        let cancelled = false;
        const bootstrap = async (): Promise<void> => {
            reconcileSessionWithCore();
            if (!isSessionAuthenticated()) {
                await restoreFromPersistence();
            }
            if (cancelled) {
                return;
            }
            setReady(true);
            if (!isSessionAuthenticated()) {
                redirectToLogin();
            }
        };
        void bootstrap();
        return (): void => {
            cancelled = true;
        };
    }, [redirectToLogin, restoreFromPersistence]);

    useEffect(() => {
        const onForeground = (): void => {
            if (document.visibilityState === "hidden") {
                return;
            }
            reconcileSessionWithCore();
            if (!isSessionAuthenticated()) {
                redirectToLogin();
            }
        };
        const onVisibility = (): void => {
            if (document.visibilityState === "visible") {
                onForeground();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pageshow", onForeground);
        return (): void => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pageshow", onForeground);
        };
    }, [redirectToLogin]);

    const authenticated = ready && isSessionAuthenticated();

    useEffect(() => {
        if (!ready || authenticated) {
            return;
        }
        redirectToLogin();
    }, [ready, authenticated, redirectToLogin]);

    return { ready, authenticated };
}
