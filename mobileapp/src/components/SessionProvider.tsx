"use client";

import { useRouter } from "next/router";
import { useEffect, type JSX, type ReactNode } from "react";
import { idleLockMs } from "@/lib/session-persistence";
import {
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
    const restoreFromPersistence = useSessionStore((s) => s.restoreFromPersistence);
    const lock = useSessionStore((s) => s.lock);

    useEffect(() => {
        void restoreFromPersistence();
    }, [restoreFromPersistence]);

    useEffect(() => {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;

        const scheduleIdleLock = (): void => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            if (!isSessionAuthenticated()) {
                return;
            }
            idleTimer = setTimeout(() => {
                if (!isSessionAuthenticated()) {
                    return;
                }
                lock();
                const path = router.pathname;
                if (path !== "/login" && path !== "/" && path !== "/offline") {
                    void router.replace("/login");
                }
            }, idleLockMs);
        };

        const onActivity = (): void => {
            scheduleIdleLock();
        };

        scheduleIdleLock();
        for (const event of activityEvents) {
            window.addEventListener(event, onActivity, { passive: true });
        }

        return (): void => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            for (const event of activityEvents) {
                window.removeEventListener(event, onActivity);
            }
        };
    }, [lock, router]);

    return <>{children}</>;
}
