import { useEffect, useMemo, useState } from "react";
import {
    countKitPresence,
    type KitPresenceEstimate,
} from "@/lib/kit-nearness-margins";
import { estimateKitPresenceInWorker } from "@/lib/kit-nearness-margins-job";
import type { TagPreset } from "@/lib/tag-presets";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore, type GalleryOrdering } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

/** Load the embedding / quality indexes the active ordering depends on. */
export const useHydrateIndexesForOrdering = (
    ordering: GalleryOrdering | undefined,
    hasKits: boolean,
): void => {
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.ensureHydrated);
    const qualityHydrated = useQualityIndexStore((s) => s.isHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.ensureHydrated);

    const kind = ordering?.kind;
    const needsEmbeddings =
        kind === "tagFilterFit" ||
        kind === "relative" ||
        kind === "nearness" ||
        kind === "textMatch" ||
        hasKits;

    useEffect(() => {
        if (kind !== "imageQuality" || qualityHydrated) {
            return;
        }
        void hydrateQuality();
    }, [hydrateQuality, kind, qualityHydrated]);

    useEffect(() => {
        if (!needsEmbeddings || embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings, needsEmbeddings]);
};

/**
 * Shown files that fit each kit. Tag probabilities come from the worker;
 * counts are derived here so toggling a kit recounts immediately. Only
 * computed while the menu (where counts show) is open.
 */
export const useKitPresenceCounts = (
    presets: TagPreset[],
    matchingFiles: EnteFile[],
    menuOpen: boolean,
): ReadonlyMap<string, number> => {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.typeConfig.includeInKitNearnessByName,
    );
    const embeddingCount = useEmbeddingIndexStore((s) => s.entries.size);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const excludedKitLikenessIds = useUIStore(
        (s) => s.excludedKitLikenessIds,
    );
    const [presenceEstimate, setPresenceEstimate] =
        useState<KitPresenceEstimate | null>(null);

    useEffect(() => {
        if (!presets.length || !embeddingHydrated || !menuOpen) {
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            estimateKitPresenceInWorker({
                kits: presets,
                libraryFiles: allFiles,
                viewFiles: matchingFiles,
                embeddings: useEmbeddingIndexStore.getState().entries,
                fileIdsByTag,
                includeInKitNearnessByName,
            })
                .then((estimate) => {
                    if (!cancelled && estimate) {
                        setPresenceEstimate(estimate);
                    }
                })
                .catch((error: unknown) => {
                    console.warn("Kit presence unavailable", error);
                });
        }, 160);
        return (): void => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [
        allFiles,
        embeddingCount,
        embeddingHydrated,
        fileIdsByTag,
        includeInKitNearnessByName,
        matchingFiles,
        menuOpen,
        presets,
    ]);

    return useMemo((): ReadonlyMap<string, number> => {
        if (!presets.length || !menuOpen) {
            return new Map();
        }
        return countKitPresence(
            presets,
            matchingFiles.map((file) => file.id),
            fileIdsByTag,
            (embeddingHydrated ? presenceEstimate : null) ?? {
                tagNames: [],
                candidateIds: [],
                tagProbabilities: new Float32Array(0),
            },
            excludedKitLikenessIds,
        );
    }, [
        excludedKitLikenessIds,
        embeddingHydrated,
        fileIdsByTag,
        matchingFiles,
        menuOpen,
        presenceEstimate,
        presets,
    ]);
};
