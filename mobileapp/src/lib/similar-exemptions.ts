import { loadKv, saveKv } from "@/db/kv";

/** Load the encrypted set of exempt pair keys (see `exemptPairKey`). */
export const hydrateSimilarExemptions = async (): Promise<Set<string>> =>
    new Set(await loadKv("similarExemptions"));

/** Write the whole exempt-pair set. */
export const persistSimilarExemptions = (
    exemptions: ReadonlySet<string>,
): Promise<void> => saveKv("similarExemptions", [...exemptions]);
