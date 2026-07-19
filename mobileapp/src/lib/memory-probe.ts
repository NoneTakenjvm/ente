/**
 * Lightweight JS-heap probe for Chromium (`performance.memory`).
 *
 * Not available in Firefox/Safari or Node by default — returns `undefined`
 * there. Use for desktop Chrome debugging and optional mobile Chrome logging.
 */

export interface JsHeapSnapshot {
    usedJsHeapBytes: number;
    totalJsHeapBytes: number;
    jsHeapSizeLimitBytes: number;
    /** used / limit, 0–1 */
    usedRatio: number;
}

interface PerformanceMemory {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
}

const getPerformanceMemory = (): PerformanceMemory | undefined => {
    if (typeof performance === "undefined") {
        return undefined;
    }
    const memory = (performance as Performance & {
        memory?: PerformanceMemory;
    }).memory;
    if (
        !memory ||
        typeof memory.usedJSHeapSize !== "number" ||
        typeof memory.jsHeapSizeLimit !== "number" ||
        memory.jsHeapSizeLimit <= 0
    ) {
        return undefined;
    }
    return memory;
};

/** Read current JS heap stats when the browser exposes them. */
export const readJsHeapSnapshot = (): JsHeapSnapshot | undefined => {
    const memory = getPerformanceMemory();
    if (!memory) {
        return undefined;
    }
    return {
        usedJsHeapBytes: memory.usedJSHeapSize,
        totalJsHeapBytes: memory.totalJSHeapSize,
        jsHeapSizeLimitBytes: memory.jsHeapSizeLimit,
        usedRatio: memory.usedJSHeapSize / memory.jsHeapSizeLimit,
    };
};

/** Format a byte count for logs (e.g. `42.5MB`). */
export const formatBytesShort = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "?";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/**
 * Log a heap snapshot when Chromium exposes `performance.memory`.
 *
 * No-op when unavailable. Never logs content — only opaque sizes.
 */
export const logJsHeap = (label: string): JsHeapSnapshot | undefined => {
    const snapshot = readJsHeapSnapshot();
    if (!snapshot) {
        return undefined;
    }
    console.warn(
        `[memory] ${label}: used=${formatBytesShort(snapshot.usedJsHeapBytes)} ` +
            `total=${formatBytesShort(snapshot.totalJsHeapBytes)} ` +
            `limit=${formatBytesShort(snapshot.jsHeapSizeLimitBytes)} ` +
            `(${Math.round(snapshot.usedRatio * 100)}%)`,
    );
    return snapshot;
};

/** Soft warning threshold used by heavy media jobs. */
export const JS_HEAP_PRESSURE_RATIO = 0.7;

export const isJsHeapUnderPressure = (
    snapshot: JsHeapSnapshot | undefined = readJsHeapSnapshot(),
): boolean =>
    snapshot !== undefined && snapshot.usedRatio >= JS_HEAP_PRESSURE_RATIO;
