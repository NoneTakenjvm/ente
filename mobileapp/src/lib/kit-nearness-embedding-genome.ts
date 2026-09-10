/**
 * Per-kit CLIP nearness parameters (tunable genome).
 *
 * Defaults match the global production constants. A successful Manage → Tune
 * run may persist a kit-specific genome on {@link TagPreset.nearnessTune}.
 */
import {
    KIT_EMBEDDING_MEDOID_MIN_SEPARATION,
    KIT_EMBEDDING_RIVAL_LAMBDA,
    KIT_EMBEDDING_RIVAL_TAU,
    MAX_KIT_EMBEDDING_MEDOIDS,
} from "@/lib/kit-nearness-sort";

export type KitEmbeddingNearnessGenome = {
    /** Rival distinctiveness scale (cosine distance). */
    rivalTau: number;
    /** Multiplier on strongest rival steal penalty. */
    rivalLambda: number;
    /** Max CLIP medoids when not using centroid. */
    maxMedoids: number;
    /** Min cosine distance between medoids. */
    minSeparation: number;
    /**
     * Prototype mode: ≥0.5 → mean centroid of seeds; &lt;0.5 → densest medoids.
     * Continuous in the type so a search can treat it as a gene; baked to 0 or 1.
     */
    useCentroid: number;
};

/** Persisted tune outcome for one kit (only kept when it beats the default). */
export const KIT_NEARNESS_TUNE_VERSION = 2;

export type KitNearnessTuneResult = {
    genome: KitEmbeddingNearnessGenome;
    fitness: number;
    holdoutAuc: number;
    holdoutTopK: number;
    baselineFitness: number;
    /** Epoch ms when the tune finished. */
    tunedAt: number;
    memberCount: number;
    /** Required on persist; old blobs without it are ignored. */
    tuneVersion: number;
};

export const DEFAULT_KIT_EMBEDDING_GENOME: KitEmbeddingNearnessGenome = {
    rivalTau: KIT_EMBEDDING_RIVAL_TAU,
    rivalLambda: KIT_EMBEDDING_RIVAL_LAMBDA,
    maxMedoids: MAX_KIT_EMBEDDING_MEDOIDS,
    minSeparation: KIT_EMBEDDING_MEDOID_MIN_SEPARATION,
    useCentroid: 1,
};

/** Minimum fitness lift over the default genome before we persist a tune. */
export const KIT_NEARNESS_TUNE_MIN_LIFT = 0.02;

/** Need enough embedded members for a meaningful holdout. */
export const KIT_NEARNESS_TUNE_MIN_MEMBERS = 12;

export type KitEmbeddingGeneSpec = {
    key: keyof KitEmbeddingNearnessGenome;
    lo: number;
    hi: number;
    integer: boolean;
};

export const KIT_EMBEDDING_GENE_SPECS: readonly KitEmbeddingGeneSpec[] = [
    { key: "rivalTau", lo: 0.02, hi: 0.4, integer: false },
    { key: "rivalLambda", lo: 0, hi: 24, integer: false },
    { key: "maxMedoids", lo: 1, hi: 5, integer: true },
    { key: "minSeparation", lo: 0.02, hi: 0.22, integer: false },
    { key: "useCentroid", lo: 0, hi: 1, integer: true },
];

const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, value));

/**
 * Clamp / round a genome into legal gene bounds (bake useCentroid to 0|1).
 */
export const clampKitEmbeddingNearnessGenome = (
    raw: Partial<KitEmbeddingNearnessGenome> | undefined,
): KitEmbeddingNearnessGenome => {
    const base = { ...DEFAULT_KIT_EMBEDDING_GENOME, ...raw };
    const out = { ...DEFAULT_KIT_EMBEDDING_GENOME };
    for (const spec of KIT_EMBEDDING_GENE_SPECS) {
        let v = Number(base[spec.key]);
        if (!Number.isFinite(v)) {
            v = DEFAULT_KIT_EMBEDDING_GENOME[spec.key];
        }
        v = clamp(v, spec.lo, spec.hi);
        if (spec.integer) {
            v = Math.round(v);
        }
        out[spec.key] = v;
    }
    return out;
};

/**
 * Parse a persisted tune blob; invalid → undefined.
 */
export const parseKitNearnessTuneResult = (
    raw: unknown,
): KitNearnessTuneResult | undefined => {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }
    const row = raw as Record<string, unknown>;
    const genome = clampKitEmbeddingNearnessGenome(
        row.genome as Partial<KitEmbeddingNearnessGenome> | undefined,
    );
    const fitness = Number(row.fitness);
    const holdoutAuc = Number(row.holdoutAuc);
    const holdoutTopK = Number(row.holdoutTopK);
    const baselineFitness = Number(row.baselineFitness);
    const tunedAt = Number(row.tunedAt);
    const memberCount = Number(row.memberCount);
    const tuneVersion = Number(row.tuneVersion);
    if (
        tuneVersion !== KIT_NEARNESS_TUNE_VERSION ||
        !Number.isFinite(fitness) ||
        !Number.isFinite(holdoutAuc) ||
        !Number.isFinite(holdoutTopK) ||
        !Number.isFinite(baselineFitness) ||
        !Number.isFinite(tunedAt) ||
        !Number.isFinite(memberCount)
    ) {
        return undefined;
    }
    return {
        genome,
        fitness,
        holdoutAuc,
        holdoutTopK,
        baselineFitness,
        tunedAt,
        memberCount: Math.round(memberCount),
        tuneVersion,
    };
};

export const kitEmbeddingGenomeToValues = (
    genome: KitEmbeddingNearnessGenome,
): number[] => KIT_EMBEDDING_GENE_SPECS.map((spec) => genome[spec.key]);

export const valuesToKitEmbeddingGenome = (
    values: number[],
): KitEmbeddingNearnessGenome => {
    const genome = { ...DEFAULT_KIT_EMBEDDING_GENOME };
    for (let i = 0; i < KIT_EMBEDDING_GENE_SPECS.length; i++) {
        const spec = KIT_EMBEDDING_GENE_SPECS[i]!;
        let v = clamp(values[i] ?? spec.lo, spec.lo, spec.hi);
        if (spec.integer) {
            v = Math.round(v);
        }
        genome[spec.key] = v;
    }
    return genome;
};
