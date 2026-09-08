/**
 * Offline Similar CLIP-knob fitness against an anonymised corpus (hashes + embeddings).
 *
 * Positives: near-exact structure pairs (min variant Hamming ≤ 2).
 * Hard negatives: mid Hamming (6–12) with high CLIP distance.
 * Easy negatives: random pairs far in both signals.
 */
import type { AnonymisedKitNearnessCorpus } from "@/lib/kit-nearness-corpus-export";
import {
    DEFAULT_SIMILAR_CLIP_KNOBS,
    embeddingCosineDistance,
    shouldKeepStage1Edge,
    type SimilarClipKnobs,
} from "@/lib/similarity-clip";
import { variantHammingDistanceHex } from "@/lib/phash";

export type SimilarClipEvalBreakdown = {
    fitness: number;
    precision: number;
    recall: number;
    positiveCount: number;
    hardNegCount: number;
    keptHardNeg: number;
    keptPositive: number;
};

const minVariantHamming = (
    left: readonly string[],
    right: readonly string[],
): number => {
    if (!left.length || !right.length) {
        return Number.POSITIVE_INFINITY;
    }
    return variantHammingDistanceHex([...left], [...right]);
};

/**
 * Score gate/rescue knobs on labelled edge decisions (no full clustering).
 */
export const evaluateSimilarClipKnobs = (
    corpus: AnonymisedKitNearnessCorpus,
    knobs: SimilarClipKnobs = DEFAULT_SIMILAR_CLIP_KNOBS,
    clusterThreshold = 8,
    sampleCap = 4000,
): SimilarClipEvalBreakdown => {
    const withBoth = corpus.photos.filter(
        (photo) =>
            photo.hashes.length > 0 &&
            photo.embedding?.length === corpus.embeddingDims,
    );
    const positives: Array<{ h: number; c: number }> = [];
    const hardNegs: Array<{ h: number; c: number }> = [];

    const n = Math.min(withBoth.length, 800);
    for (let i = 0; i < n && positives.length + hardNegs.length < sampleCap; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = withBoth[i]!;
            const b = withBoth[j]!;
            const h = minVariantHamming(a.hashes, b.hashes);
            if (!Number.isFinite(h)) {
                continue;
            }
            const c = embeddingCosineDistance(a.embedding, b.embedding);
            if (!Number.isFinite(c)) {
                continue;
            }
            if (h <= 2) {
                positives.push({ h, c });
            } else if (h >= 6 && h <= 12 && c > 0.4) {
                hardNegs.push({ h, c });
            }
            if (positives.length + hardNegs.length >= sampleCap) {
                break;
            }
        }
    }

    let keptPositive = 0;
    for (const pair of positives) {
        if (shouldKeepStage1Edge(pair.h, pair.c, clusterThreshold, knobs)) {
            keptPositive += 1;
        }
    }
    let keptHardNeg = 0;
    for (const pair of hardNegs) {
        if (shouldKeepStage1Edge(pair.h, pair.c, clusterThreshold, knobs)) {
            keptHardNeg += 1;
        }
    }

    const positiveCount = positives.length;
    const hardNegCount = hardNegs.length;
    const recall =
        positiveCount === 0 ? 1 : keptPositive / positiveCount;
    const precisionDenom = keptPositive + keptHardNeg;
    const precision =
        precisionDenom === 0 ? 1 : keptPositive / precisionDenom;
    // Prefer high recall on near-exact pairs and low false keeps on hard negs.
    const fitness = 0.55 * recall + 0.45 * precision;

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
