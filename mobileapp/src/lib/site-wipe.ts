/**
 * Hard wipe of browser storage used by the Photos PWA (panic / re-auth).
 */

const storageKeyPrefixes = ["ntphotos-", "mobileapp-"] as const;

const clearStorageByPrefix = (storage: Storage): void => {
    const toRemove: string[] = [];
    for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key) {
            continue;
        }
        if (
            storageKeyPrefixes.some((prefix) => key.startsWith(prefix))
        ) {
            toRemove.push(key);
        }
    }
    for (const key of toRemove) {
        storage.removeItem(key);
    }
};

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
                request.onblocked = (): void => {
                    resolve();
                };
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
        clearStorageByPrefix(window.localStorage);
    } catch {
        // Ignore quota / security errors during panic wipe.
    }
    try {
        clearStorageByPrefix(window.sessionStorage);
    } catch {
        // Ignore.
    }
    await wipeOrganizerIndexedDatabases();
    await wipeCaches();
    await unregisterServiceWorkers();
};
