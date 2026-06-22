import {
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { isSessionAuthenticated } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";

export interface UseLibraryBootstrapOptions {
    /** Extra work after cache load and remote sync (e.g. phash hydrate). */
    afterSync?: () => Promise<void>;
}

/**
 * Load encrypted cache then sync from Ente once per authenticated session.
 */
export const useLibraryBootstrap: (
    options?: UseLibraryBootstrapOptions,
) => boolean = (options: UseLibraryBootstrapOptions = {}): boolean => {
    const bootstrapFromCache: () => Promise<boolean> = useLibraryStore(
        (state: { bootstrapFromCache: () => Promise<boolean> }): (() => Promise<boolean>) =>
            state.bootstrapFromCache,
    );
    const syncRemote: () => Promise<void> = useLibraryStore(
        (state: { syncRemote: () => Promise<void> }): (() => Promise<void>) =>
            state.syncRemote,
    );
    const afterSync: (() => Promise<void>) | undefined = options.afterSync;

    const [initialLoadDone, setInitialLoadDone]: [
        boolean,
        Dispatch<SetStateAction<boolean>>,
    ] = useState<boolean>(false);
    const bootstrapStarted: { current: boolean } = useRef<boolean>(false);

    useEffect((): (() => void) => {
        if (!isSessionAuthenticated() || bootstrapStarted.current) {
            return (): void => {};
        }
        bootstrapStarted.current = true;

        let cancelled: boolean = false;

        const bootstrap: () => Promise<void> = async (): Promise<void> => {
            try {
                await bootstrapFromCache();
                await syncRemote();
                await afterSync?.();
            } finally {
                if (!cancelled) {
                    setInitialLoadDone(true);
                }
            }
        };

        void bootstrap();
        return (): void => {
            cancelled = true;
        };
    }, [afterSync, bootstrapFromCache, syncRemote]);
    return initialLoadDone;
};
