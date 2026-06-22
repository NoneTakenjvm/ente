const defaultBatchSize = 1000;

const batch = <T>(items: T[], size: number): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
};

/**
 * Run {@link op} on fixed-size sequential batches (Ente default: 1000).
 */
export const batched = async <T, U>(
    items: T[],
    op: (batchItems: T[]) => Promise<U>,
    batchSize = defaultBatchSize,
): Promise<U[]> => {
    const result: U[] = [];
    for (const b of batch(items, batchSize)) {
        result.push(await op(b));
    }
    return result;
};

export interface MapBatchedOptions {
    batchSize?: number;
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
}

/**
 * Map an async operation over items with bounded concurrency and progress.
 */
export const mapBatched = async <T>(
    items: T[],
    op: (item: T) => Promise<void>,
    options?: MapBatchedOptions,
): Promise<void> => {
    const batchSize = options?.batchSize ?? defaultBatchSize;
    const concurrency = options?.concurrency ?? 2;
    const total = items.length;
    let completed = 0;

    for (const chunk of batch(items, batchSize)) {
        for (let i = 0; i < chunk.length; i += concurrency) {
            const slice = chunk.slice(i, i + concurrency);
            await Promise.all(
                slice.map(async (item) => {
                    await op(item);
                    completed += 1;
                    options?.onProgress?.(completed, total);
                }),
            );
        }
    }
};
