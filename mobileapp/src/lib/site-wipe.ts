/**
 * Hard wipe of browser storage used by the Photos PWA (panic / re-auth).
 */

const wipeOrganizerIndexedDatabases = async (): Promise<void> => {
    if (typeof indexedDB === "undefined") {
        return;
    }
    const databases =
        typeof indexedDB.databases === "function" ?
            await indexedDB.databases() :
            [];
    await Promise.all(
        databases.map(async (entry) => {
            const name = entry.name;
            if (!name?.startsWith("ente-organizer-")) {
                return;
            }
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = (): void => {
                    resolve();
                };
                request.onerror = (): void => {
                    reject(
                        request.error ??
                            new Error(`Failed to delete IndexedDB ${name}`),
                    );
                };
                // `onblocked` is ignored: the delete completes (success) once
                // other connections close. Callers close this tab's own first.
            });
        }),
    );
};

const wipeCaches = async (): Promise<void> => {
    if (typeof caches === "undefined") {
        return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
};

const unregisterServiceWorkers = async (): Promise<void> => {
    if (
        typeof navigator === "undefined" ||
        !("serviceWorker" in navigator)
    ) {
        return;
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
        registrations.map((registration) => registration.unregister()),
    );
};

/**
 * Clear localStorage, sessionStorage, organizer IndexedDBs, caches, and SWs.
 */
export const wipeSiteStorage = async (): Promise<void> => {
    if (typeof window === "undefined") {
        return;
    }
    try {
        window.localStorage.clear();
    } catch {
        // Ignore quota / security errors during panic wipe.
    }
    try {
        window.sessionStorage.clear();
    } catch {
        // Ignore.
    }
    await Promise.all([
        wipeOrganizerIndexedDatabases(),
        wipeCaches(),
        unregisterServiceWorkers(),
    ]);
};
