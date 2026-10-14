import { loadKv, saveKv } from "@/db/kv";
import { registerFlush, registerReset } from "@/lib/session-lifecycle";

/** `kv` records that hold an outbox's entry list. */
type OutboxKvKey =
    | "tagOutbox" |
    "favoriteOutbox" |
    "visibilityOutbox" |
    "derivedReplaceOutbox";

interface OutboxConfig<E, Key extends string | number> {
    kvKey: OutboxKvKey;
    keyOf: (entry: E) => Key;
    /** Prefix for the persist-failure warning. */
    label: string;
    /**
     * Extra check, beyond `enqueuedAt`, that {@link Outbox.removeIfUnchanged}
     * uses to decide the current entry is the one that was sent.
     */
    sameIntent?: (current: E, sent: E) => boolean;
    /** Rewrite entries as loaded from disk (drop or convert old rows). */
    normalize?: (persisted: E[]) => Promise<E[]> | E[];
}

export interface Outbox<E, Key extends string | number> {
    /** Load from disk once; concurrent and later calls share the result. */
    hydrate: () => Promise<void>;
    isHydrated: () => boolean;
    entries: () => E[];
    get: (key: Key) => E | undefined;
    size: () => number;
    /** In-memory set only; follow with {@link Outbox.persist}. */
    put: (entry: E) => void;
    persist: () => Promise<void>;
    /** Set many entries (one persist). Sets synchronously when hydrated. */
    upsert: (entries: E[]) => Promise<void>;
    /**
     * Remove each entry in `sent` only if it is still the entry that was sent
     * (same `enqueuedAt`), so a newer intent queued mid-flight survives the ack.
     */
    removeIfUnchanged: (sent: E[]) => Promise<void>;
    removeWhere: (shouldRemove: (entry: E) => boolean) => Promise<void>;
    /** Re-key the entry at `from` to `to`; `rekey` returns the moved entry. */
    remap: (from: Key, to: Key, rekey: (entry: E) => E) => Promise<void>;
    /** Await the in-flight write; re-writes only if the last write failed. */
    flush: () => Promise<void>;
    /** Drop memory state (logout / lock). Disk is untouched. */
    clear: () => void;
}

/**
 * Persisted map of pending mutation intents, encrypted in `kv` under `kvKey`.
 *
 * Registers itself with the session lifecycle: flushed on hide / logout and
 * cleared on session reset. Callers keep only their domain code.
 */
export const createOutbox = <
    E extends { enqueuedAt: number },
    Key extends string | number,
>(
    config: OutboxConfig<E, Key>,
): Outbox<E, Key> => {
    const { kvKey, keyOf, label, sameIntent, normalize } = config;
    const byKey = new Map<Key, E>();
    let hydrated = false;
    let hydrateInFlight: Promise<void> | undefined;

    // The four outbox kv records differ only in entry type; `E` is that type.
    const writer = createCoalescedWriter(
        () => saveKv(kvKey, [...byKey.values()] as never),
        label,
    );

    const hydrate = (): Promise<void> => {
        if (hydrated) {
            return Promise.resolve();
        }
        hydrateInFlight ??= (async () => {
            const loaded = ((await loadKv(kvKey)) ?? []) as unknown as E[];
            const persisted = normalize ? await normalize(loaded) : loaded;
            byKey.clear();
            for (const entry of persisted) {
                byKey.set(keyOf(entry), entry);
            }
            hydrated = true;
        })().finally(() => {
            hydrateInFlight = undefined;
        });
        return hydrateInFlight;
    };

    const put = (entry: E): void => {
        byKey.set(keyOf(entry), entry);
    };

    const removeWhere = async (
        shouldRemove: (entry: E) => boolean,
    ): Promise<void> => {
        await hydrate();
        let removed = false;
        for (const [key, entry] of byKey) {
            if (shouldRemove(entry)) {
                byKey.delete(key);
                removed = true;
            }
        }
        if (removed) {
            await writer.persist();
        }
    };

    const clear = (): void => {
        byKey.clear();
        hydrated = false;
        hydrateInFlight = undefined;
        writer.reset();
    };

    const flush = (): Promise<void> => writer.flush();

    registerFlush(flush);
    registerReset(clear);

    return {
        hydrate,
        isHydrated: (): boolean => hydrated,
        entries: (): E[] => [...byKey.values()],
        get: (key: Key): E | undefined => byKey.get(key),
        size: (): number => byKey.size,
        put,
        persist: writer.persist,
        upsert: async (entries: E[]): Promise<void> => {
            if (!hydrated) {
                await hydrate();
            }
            for (const entry of entries) {
                put(entry);
            }
            await writer.persist();
        },
        removeIfUnchanged: async (sent: E[]): Promise<void> => {
            // Match by identity so an entry replaced before the removal runs
            // is kept.
            const unchanged = new Set<E>();
            for (const entry of sent) {
                const current = byKey.get(keyOf(entry));
                if (
                    current &&
                    current.enqueuedAt === entry.enqueuedAt &&
                    (sameIntent?.(current, entry) ?? true)
                ) {
                    unchanged.add(current);
                }
            }
            if (unchanged.size > 0) {
                await removeWhere((entry) => unchanged.has(entry));
            }
        },
        removeWhere,
        remap: async (
            from: Key,
            to: Key,
            rekey: (entry: E) => E,
        ): Promise<void> => {
            await hydrate();
            const existing = byKey.get(from);
            if (!existing) {
                return;
            }
            byKey.delete(from);
            byKey.set(to, rekey(existing));
            await writer.persist();
        },
        flush,
        clear,
    };
};

interface CoalescedWriter {
    /** Queue a write; calls made before it starts share that one write. */
    persist: () => Promise<void>;
    /** Await the in-flight write; queue another only if the last one failed. */
    flush: () => Promise<void>;
    /** Forget queued and failed state (a queued write becomes a no-op). */
    reset: () => void;
}

/**
 * Serialize `write` so a burst of {@link CoalescedWriter.persist} calls costs
 * one encrypt+put. `write` snapshots current state when it runs, so a call
 * made while a write is in progress queues exactly one follow-up. Failures are
 * logged, never thrown.
 */
export const createCoalescedWriter = (
    write: () => Promise<void>,
    label: string,
): CoalescedWriter => {
    let queued = false;
    let failed = false;
    let generation = 0;
    let chain: Promise<void> = Promise.resolve();

    const persist = (): Promise<void> => {
        if (!queued) {
            queued = true;
            const queuedGeneration = generation;
            chain = chain
                .catch(() => undefined)
                .then(async () => {
                    if (generation !== queuedGeneration) {
                        return;
                    }
                    queued = false;
                    failed = false;
                    await write();
                })
                .catch((error: unknown) => {
                    failed = true;
                    console.warn(`${label} persist failed`, error);
                });
        }
        return chain;
    };

    return {
        persist,
        flush: (): Promise<void> => (failed ? persist() : chain),
        reset: (): void => {
            generation += 1;
            queued = false;
            failed = false;
            chain = Promise.resolve();
        },
    };
};
