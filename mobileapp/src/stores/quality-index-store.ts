import { hydrateQualityIndex } from "@/lib/image-quality-job";
import { createIndexStore } from "./create-index-store";

export const useQualityIndexStore = createIndexStore<Map<number, number>>(
    () => new Map(),
    hydrateQualityIndex,
);
