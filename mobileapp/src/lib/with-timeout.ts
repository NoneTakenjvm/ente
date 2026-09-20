/**
 * Reject {@link promise} if it does not settle within {@link ms} milliseconds.
 */
export const withTimeout = <T>(
    promise: Promise<T>,
    ms: number,
    message: string,
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise.finally(() => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }),
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]);
};
