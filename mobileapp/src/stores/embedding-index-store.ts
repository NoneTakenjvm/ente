import { hydrateEmbeddingIndex, type EmbeddingMap } from "@/lib/kit-embedding";
import { createIndexStore } from "./create-index-store";

export const useEmbeddingIndexStore = createIndexStore<EmbeddingMap>(
    () => new Map(),
    hydrateEmbeddingIndex,
);
