import { hydrateQualityIndex } from "@/lib/quality-index";
import { createIndexStore } from "./create-index-store";

export const useQualityIndexStore = createIndexStore<Map<number, number>>(
    () => new Map(),
    hydrateQualityIndex,
);
