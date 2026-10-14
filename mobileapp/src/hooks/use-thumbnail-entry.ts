import { useEffect, useSyncExternalStore } from "react";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import type { EnteFile } from "ente-media/file";

/**
 * Subscribe to a file's cached thumbnail and request it when not yet loaded
 * (or when the last load failed; the cache applies its own retry cooldown).
 */
export function useThumbnailEntry(
    file: EnteFile | undefined,
): ReturnType<typeof getThumbnailEntry> {
    const entry = useSyncExternalStore(
        (listener) => subscribeThumbnail(file?.id ?? -1, listener),
        () => getThumbnailEntry(file?.id ?? -1),
        () => getThumbnailEntry(file?.id ?? -1),
    );

    useEffect(() => {
        if (file && (entry.status === "idle" || entry.status === "error")) {
            requestThumbnail(file);
        }
    }, [entry.status, file]);

    return entry;
}
