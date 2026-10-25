/**
 * `"1 file"` / `"3 files"`. Pass {@link pluralWord} for irregular plurals.
 */
export const plural = (
    count: number,
    word: string,
    pluralWord: string = `${word}s`,
): string => `${count} ${count === 1 ? word : pluralWord}`;

/** Compact byte label for overlays and selection chrome (e.g. `1.2 MB`). */
export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

/**
 * Short age of a moment: `"just now"`, `"5m ago"`, `"3h ago"`, `"6d ago"`,
 * then the plain date once it is over a week old.
 *
 * @param time epoch milliseconds
 * @param now epoch milliseconds to measure from
 */
export const formatTimeAgo = (time: number, now: number = Date.now()): string => {
    const minutes = Math.floor((now - time) / 60_000);
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 24 * 60) {
        return `${Math.floor(minutes / 60)}h ago`;
    }
    if (minutes < 7 * 24 * 60) {
        return `${Math.floor(minutes / (24 * 60))}d ago`;
    }
    return new Date(time).toLocaleDateString(undefined, { dateStyle: "medium" });
};

/**
 * User-facing text for a caught value: the `Error` message, else
 * {@link fallback}, else the stringified value.
 */
export const errorMessage = (error: unknown, fallback?: string): string =>
    error instanceof Error ? error.message : fallback ?? String(error);
