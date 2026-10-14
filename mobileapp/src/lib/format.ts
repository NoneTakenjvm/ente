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
 * User-facing text for a caught value: the `Error` message, else
 * {@link fallback}, else the stringified value.
 */
export const errorMessage = (error: unknown, fallback?: string): string =>
    error instanceof Error ? error.message : fallback ?? String(error);
