/**
 * Offline Similar CLIP-nearest fitness against an anonymised corpus.
 *
 * Positives: pairs with CLIP cosine ≤ 0.10.
 * Negatives: pairs with CLIP cosine ≥ 0.35.
 */
import type { AnonymisedKitNearnessCorpus } from "@/lib/kit-nearness-corpus-export";
import {
    CLIP_CONFIRM_TOP_K,
    CLIP_SCORE_COLLECT_MAX,
    collectConfirmedClipEdges,
    embeddingCosineDistance,
    findClipTopNeighbours,
} from "@/lib/similarity-clip";

export type SimilarClipEvalBreakdown = {
    fitness: number;
    precision: number;
    recall: number;
    positiveCount: number;
    hardNegCount: number;
    keptHardNeg: number;
    keptPositive: number;
};

/**
 * Score CLIP nearest-neighbour confirm on labelled pairs from the corpus.
 */
export const evaluateSimilarClipNearest = (
    corpus: AnonymisedKitNearnessCorpus,
    clusterThreshold = 12,
    sampleCap = 800,
): SimilarClipEvalBreakdown => {
    const withEmb = corpus.photos.filter(
        (photo) => photo.embedding?.length === corpus.embeddingDims,
    );
    const n = Math.min(withEmb.length, sampleCap);
    const sample = withEmb.slice(0, n);
    const vectors = sample.map((photo) => photo.embedding!);
    const top = findClipTopNeighbours(
        vectors,
        CLIP_CONFIRM_TOP_K,
        CLIP_SCORE_COLLECT_MAX,
    );
    const confirmed = new Set(
        collectConfirmedClipEdges(top)
            .filter((edge) => edge.score <= clusterThreshold)
            .map((edge) => `${edge.left}:${edge.right}`),
    );

    let positiveCount = 0;
    let hardNegCount = 0;
    let keptPositive = 0;
    let keptHardNeg = 0;

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = embeddingCosineDistance(vectors[i], vectors[j]);
            if (!Number.isFinite(dist)) {
                continue;
            }
            const key = `${i}:${j}`;
            const kept = confirmed.has(key);
            if (dist <= 0.1) {
                positiveCount += 1;
                if (kept) {
                    keptPositive += 1;
                }
            } else if (dist >= 0.35) {
                hardNegCount += 1;
                if (kept) {
                    keptHardNeg += 1;
                }
            }
        }
    }

    const recall =
        positiveCount === 0 ? 1 : keptPositive / positiveCount;
    const precisionDenom = keptPositive + keptHardNeg;
    const precision =
        precisionDenom === 0 ? 1 : keptPositive / precisionDenom;
    const fitness = recall * 0.65 + precision * 0.35;

    return {
        fitness,
        precision,
        recall,
        positiveCount,
        hardNegCount,
        keptHardNeg,
        keptPositive,
    };
};
