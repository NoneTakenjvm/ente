/**
 * Coalesce IndexedDB LRU `lastAccess` updates in memory and flush in batches.
 *
 * Ciphertext rows are large; rewriting them on every cache hit amplifies IDB
 * traffic. Callers note touches here, overlay pending times when ranking
 * eviction, and flush periodically / on hide.
 */

/** Flush after this many distinct pending file ids. */
const FLUSH_EVERY = 32;

export type LruTouchWriter = (
    fileId: number,
    lastAccess: number,
) => Promise<void>;

/**
 * In-memory lastAccess pending map with batched flush.
 */
export class LruTouchCoalescer {
    private readonly pending = new Map<number, number>();
    private flushChain: Promise<void> = Promise.resolve();
    private readonly write: LruTouchWriter;

    constructor(write: LruTouchWriter) {
        this.write = write;
    }

    /** Record a hit without touching IndexedDB yet. */
    note(fileId: number, lastAccess: number = Date.now()): void {
        this.pending.set(fileId, lastAccess);
        if (this.pending.size >= FLUSH_EVERY) {
            void this.flush();
        }
    }

    /** Prefer pending touch time when ranking eviction. */
    overlay(fileId: number, diskLastAccess: number): number {
        return this.pending.get(fileId) ?? diskLastAccess;
    }

    /** Drop a pending touch (row deleted / replaced). */
    forget(fileId: number): void {
        this.pending.delete(fileId);
    }

    /** True when there are unflushed touches. */
    get hasPending(): boolean {
        return this.pending.size > 0;
    }

    /**
     * Write all pending lastAccess values. Concurrent callers share one chain.
     */
    flush(): Promise<void> {
        if (this.pending.size === 0) {
            return this.flushChain;
        }
        const batch = new Map(this.pending);
        this.pending.clear();
        this.flushChain = this.flushChain
            .catch(() => undefined)
            .then(async () => {
                for (const [fileId, lastAccess] of batch) {
                    try {
                        await this.write(fileId, lastAccess);
                    } catch {
                        // Re-queue so a later flush can retry.
                        if (!this.pending.has(fileId)) {
                            this.pending.set(fileId, lastAccess);
                        }
                    }
                }
            });
        return this.flushChain;
    }
}
