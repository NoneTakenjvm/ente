import { hydrateSimilarExemptions } from "@/lib/similar-exemptions";
import { createIndexStore } from "./create-index-store";

/** Pairs the user exempted from Similar, as `exemptPairKey` strings. */
export const useSimilarExemptionStore = createIndexStore<Set<string>>(
    () => new Set(),
    hydrateSimilarExemptions,
);
