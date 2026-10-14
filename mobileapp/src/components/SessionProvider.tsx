"use client";

import { useRouter } from "next/router";
import { useEffect, type JSX, type ReactNode } from "react";
import { idleLockMs } from "@/lib/session-persistence";
import { installDurableFlushListeners } from "@/lib/durable-flush";
import { LOGIN_PATHS } from "@/hooks/use-require-session";
import {
    ensureSessionRestored,
    isSessionAuthenticated,
    useSessionStore,
} from "@/stores/session-store";

const activityEvents = [
    "mousedown",
    "mousemove",
    "keydown",
    "touchstart",
    "scroll",
    "pointerdown",
] as const;

interface SessionProviderProps {
    children: ReactNode;
}

/**
 * Restore persisted sessions on load and auto-lock after idle time.
 */
export function SessionProvider({ children }: SessionProviderProps): JSX.Element {
    const router = useRouter();
    const lock = useSessionStore((s) => s.lock);

    useEffect(() => {
        installDurableFlushListeners();
        void ensureSessionRestored();
    }, []);

    useEffect(() => {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let lockInFlight = false;

        const scheduleIdleLock = (): void => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            if (!isSessionAuthenticated()) {
                return;
            }
            idleTimer = setTimeout(() => {
                void (async (): Promise<void> => {
                    if (lockInFlight || !isSessionAuthenticated()) {
                        return;
                    }
                    lockInFlight = true;
                    try {
                        // Await flush + key wipe before navigating so login
                        // cannot race restore-and-bounce back to the app.
                        await lock();
                        const path = router.pathname;
                        if (!LOGIN_PATHS.has(path)) {
                            void router.replace("/login");
                        }
                    } finally {
                        lockInFlight = false;
                    }
                })();
            }, idleLockMs);
        };

        scheduleIdleLock();
        for (const event of activityEvents) {
            window.addEventListener(event, scheduleIdleLock, { passive: true });
        }

        return (): void => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            for (const event of activityEvents) {
                window.removeEventListener(event, scheduleIdleLock);
            }
        };
    }, [lock, router]);

    return <>{children}</>;
}
