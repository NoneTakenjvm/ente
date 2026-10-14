import type { PhashEntry } from "@/lib/crop-match";
import { hydratePhashIndex } from "@/lib/similarity-job";
import { createIndexStore } from "./create-index-store";

export const usePhashIndexStore = createIndexStore<Map<number, PhashEntry>>(
    () => new Map(),
    hydratePhashIndex,
);
