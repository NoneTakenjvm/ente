/**
 * Learned kit nearness margins over packed CLIP matrices (no EnteFile / DOM,
 * so the worker bundle stays small).
 *
 * Two terms are added to the production competitive score, each divided by
 * its standard deviation over the training rows:
 *
 * - hard margin `x · S⁻¹(c_selected − c_hard)`: `c_hard` is the centroid of
 *   training photos carrying some but not all kit tags, `S` the shrunk
 *   covariance of the training rows (a shrunk-LDA direction);
 * - tag margin `min_t logodds_t(x)`: one class-balanced logistic model per
 *   kit tag, trained in whitened coordinates `z = L⁻¹(x − μ)` (converges in
 *   ~100 Adam steps) and mapped back to raw space so scoring is one dot.
 *
 * Research and measured gains: `scripts/kit-nearness-s2-research.md`, pass 5.
 *
 * The same tag models also drive the kit presence list ("kit likeness"):
 * see {@link tagPresenceProbabilities} and {@link countKitPresence}.
 * Gallery ranking stays AND. The dropdown partitions each shown file to the
 * most-specific remaining kit it AND-matches (unchecked kits omitted).
 */

export type KitWhitening = {
    dim: number;
    rows: number;
    /** Mean of the training rows. */
    mu: Float64Array;
    /** Cholesky factor `L` of the shrunk covariance, row-major `dim × dim`. */
    lower: Float64Array;
    /** Whitened training rows `L⁻¹(x − μ)`, row-major `rows × dim`. */
    whitened: Float32Array;
};

/** Raw-space logistic log-odds: `weights · x + offset`. */
export type TagLogOddsModel = {
    weights: Float64Array;
    offset: number;
};

/** Rank the shown files for one kit by production score plus learned margins. */
export type KitMarginsWorkerRequest = {
    kind: "rank";
    requestId: number;
    dim: number;
    /** Training population: ids, row-major vectors and production scores. */
    trainingIds: Int32Array;
    trainingVectors: Float32Array;
    trainingProductionScores: Float32Array;
    /** One entry per kit tag; `labels[row]` is 1 when the row carries it. */
    tags: { name: string; labels: Uint8Array }[];
    /** Embedded stills to rank, with their production scores. */
    candidateIds: Int32Array;
    candidateVectors: Float32Array;
    candidateProductionScores: Float32Array;
};

/** Estimate, for the shown embedded stills, which kit tags each carries. */
export type KitPresenceWorkerRequest = {
    kind: "presence";
    requestId: number;
    dim: number;
    trainingIds: Int32Array;
    trainingVectors: Float32Array;
    /** Every kit tag with enough examples; `labels[row]` is 1 when the row carries it. */
    tags: { name: string; labels: Uint8Array }[];
    candidateIds: Int32Array;
    candidateVectors: Float32Array;
};

export type KitWorkerRequest = KitMarginsWorkerRequest | KitPresenceWorkerRequest;

export type KitMarginsWorkerResponse = {
    requestId: number;
    orderIds?: Int32Array;
    error?: string;
};

export type KitPresenceWorkerResponse = {
    requestId: number;
    /** Row-major `candidates × tags`: probability that the candidate carries the tag. */
    tagProbabilities?: Float32Array;
    error?: string;
};

/** Per-tag estimate for the embedded files in view, as returned by the worker. */
export type KitPresenceEstimate = {
    tagNames: readonly string[];
    candidateIds: readonly number[];
    tagProbabilities: Float32Array;
};

/** Weight on the σ-normalised hard margin (plateau 0.5–2). */
export const KIT_MARGIN_HARD_WEIGHT = 1.5;

/** Weight on the σ-normalised weakest-tag log-odds (plateau 2–6). */
export const KIT_MARGIN_TAG_WEIGHT = 4;

/** Covariance ridge as a multiple of the mean eigenvalue (`tr(S) / dim`). */
export const KIT_MARGIN_SHRINKAGE = 1;

/** L2 penalty on whitened logistic weights. */
export const KIT_MARGIN_L2 = 0.01;

/** Adam steps per tag model; whitened loss plateaus by ~75. */
export const KIT_MARGIN_ITERATIONS = 100;

export const KIT_MARGIN_LEARNING_RATE = 0.1;

/**
 * Predicted tag is present at or above this (exact-set @0.4 from the ONLY
 * retune: specific-kit top-5 recall 42% → 83% vs the old AND product).
 */
export const KIT_PRESENCE_EXACT_THRESHOLD = 0.4;

/**
 * Mean, shrunk covariance Cholesky factor and whitened rows of a training
 * matrix.
 *
 * @param vectors row-major `rows × dim` L2-normalised embeddings
 */
export const buildKitWhitening = (
    vectors: Float32Array,
    rows: number,
    dim: number,
    shrinkage: number = KIT_MARGIN_SHRINKAGE,
): KitWhitening => {
    const mu = new Float64Array(dim);
    for (let row = 0; row < rows; row += 1) {
        const offset = row * dim;
        for (let d = 0; d < dim; d += 1) {
            mu[d]! += vectors[offset + d]!;
        }
    }
    for (let d = 0; d < dim; d += 1) {
        mu[d]! /= Math.max(rows, 1);
    }

    const covariance = new Float64Array(dim * dim);
    const centred = new Float64Array(dim);
    for (let row = 0; row < rows; row += 1) {
        centreRow(vectors, row * dim, mu, centred);
        for (let i = 0; i < dim; i += 1) {
            const xi = centred[i]!;
            const rowOffset = i * dim;
            for (let j = i; j < dim; j += 1) {
                covariance[rowOffset + j]! += xi * centred[j]!;
            }
        }
    }
    let trace = 0;
    for (let i = 0; i < dim; i += 1) {
        for (let j = i; j < dim; j += 1) {
            const value = covariance[i * dim + j]! / Math.max(rows, 1);
            covariance[i * dim + j] = value;
            covariance[j * dim + i] = value;
        }
        trace += covariance[i * dim + i]!;
    }
    const ridge = (shrinkage * trace) / dim;
    for (let i = 0; i < dim; i += 1) {
        covariance[i * dim + i]! += ridge;
    }

    const lower = cholesky(covariance, dim);
    const whitened = new Float32Array(rows * dim);
    const solved = new Float64Array(dim);
    for (let row = 0; row < rows; row += 1) {
        centreRow(vectors, row * dim, mu, centred);
        forwardSolve(lower, centred, solved, dim);
        whitened.set(solved, row * dim);
    }
    return { dim, rows, mu, lower, whitened };
};

/**
 * Class-balanced L2 logistic regression for one tag, trained with Adam in
 * whitened coordinates and returned in raw space.
 *
 * @param labels one byte per training row, 1 when the row carries the tag
 */
export const trainTagLogOddsModel = (
    whitening: KitWhitening,
    labels: Uint8Array,
    options?: { l2?: number; iterations?: number; learningRate?: number },
): TagLogOddsModel => {
    const l2 = options?.l2 ?? KIT_MARGIN_L2;
    const iterations = options?.iterations ?? KIT_MARGIN_ITERATIONS;
    const learningRate = options?.learningRate ?? KIT_MARGIN_LEARNING_RATE;
    const { dim, rows, whitened, lower, mu } = whitening;

    let positives = 0;
    for (let row = 0; row < rows; row += 1) {
        positives += labels[row]!;
    }
    const positiveWeight = rows / (2 * Math.max(positives, 1));
    const negativeWeight = rows / (2 * Math.max(rows - positives, 1));

    // Index dim holds the bias (not L2-penalised).
    const weights = new Float64Array(dim + 1);
    const gradient = new Float64Array(dim + 1);
    const firstMoment = new Float64Array(dim + 1);
    const secondMoment = new Float64Array(dim + 1);
    const beta1 = 0.9;
    const beta2 = 0.999;

    for (let step = 1; step <= iterations; step += 1) {
        gradient.fill(0);
        for (let row = 0; row < rows; row += 1) {
            const offset = row * dim;
            let logit = weights[dim]!;
            for (let d = 0; d < dim; d += 1) {
                logit += weights[d]! * whitened[offset + d]!;
            }
            const label = labels[row]!;
            const probability = 1 / (1 + Math.exp(-logit));
            const scale =
                ((label ? positiveWeight : negativeWeight) *
                    (probability - label)) /
                rows;
            for (let d = 0; d < dim; d += 1) {
                gradient[d]! += scale * whitened[offset + d]!;
            }
            gradient[dim]! += scale;
        }
        for (let d = 0; d < dim; d += 1) {
            gradient[d]! += l2 * weights[d]!;
        }
        const correction1 = 1 - beta1 ** step;
        const correction2 = 1 - beta2 ** step;
        for (let d = 0; d <= dim; d += 1) {
            const g = gradient[d]!;
            firstMoment[d] = beta1 * firstMoment[d]! + (1 - beta1) * g;
            secondMoment[d] = beta2 * secondMoment[d]! + (1 - beta2) * g * g;
            weights[d]! -=
                (learningRate * (firstMoment[d]! / correction1)) /
                (Math.sqrt(secondMoment[d]! / correction2) + 1e-8);
        }
    }

    // logodds(x) = w · L⁻¹(x − μ) + b = (L⁻ᵀ w) · x + (b − (L⁻ᵀ w) · μ).
    const rawWeights = backwardSolve(lower, weights.subarray(0, dim), dim);
    let offset = weights[dim]!;
    for (let d = 0; d < dim; d += 1) {
        offset -= rawWeights[d]! * mu[d]!;
    }
    return { weights: rawWeights, offset };
};

/**
 * Rank candidates by production score plus the σ-normalised hard and tag
 * margins (higher first, ties by lower id).
 *
 * Returns `undefined` when the training rows lack complete or partial kit
 * members, in which case the caller keeps the production order.
 */
export const rankByKitMargins = (
    request: Omit<KitMarginsWorkerRequest, "kind" | "requestId" | "trainingIds">,
    whitening: KitWhitening,
    tagModels: readonly TagLogOddsModel[],
    hardWeight: number = KIT_MARGIN_HARD_WEIGHT,
    tagWeight: number = KIT_MARGIN_TAG_WEIGHT,
): Int32Array | undefined => {
    const {
        dim,
        trainingVectors,
        trainingProductionScores,
        tags,
        candidateIds,
        candidateVectors,
        candidateProductionScores,
    } = request;
    const rows = trainingProductionScores.length;

    const hardDirection = hardMarginDirection(
        trainingVectors,
        rows,
        dim,
        tags,
        whitening.lower,
    );
    if (!hardDirection) {
        return undefined;
    }

    const tagMargin = (vectors: Float32Array, offset: number): number => {
        let weakest = Number.POSITIVE_INFINITY;
        for (const model of tagModels) {
            const logOdds =
                dotRow(vectors, offset, model.weights, dim) + model.offset;
            if (logOdds < weakest) {
                weakest = logOdds;
            }
        }
        return weakest;
    };

    const trainingHard = new Float64Array(rows);
    const trainingTag = new Float64Array(rows);
    for (let row = 0; row < rows; row += 1) {
        const offset = row * dim;
        trainingHard[row] = dotRow(trainingVectors, offset, hardDirection, dim);
        trainingTag[row] = tagMargin(trainingVectors, offset);
    }
    const productionScale = 1 / standardDeviation(trainingProductionScores);
    const hardScale = hardWeight / standardDeviation(trainingHard);
    const tagScale = tagWeight / standardDeviation(trainingTag);

    const count = candidateIds.length;
    const scores = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
        const offset = index * dim;
        scores[index] =
            candidateProductionScores[index]! * productionScale +
            dotRow(candidateVectors, offset, hardDirection, dim) * hardScale +
            tagMargin(candidateVectors, offset) * tagScale;
    }
    const order = Array.from({ length: count }, (_, index) => index);
    order.sort(
        (a, b) =>
            scores[b]! - scores[a]! || candidateIds[a]! - candidateIds[b]!,
    );
    return Int32Array.from(order, (index) => candidateIds[index]!);
};

/**
 * Probability that each candidate carries each tag, row-major
 * `candidates × tags`.
 *
 * [Note: Tag models are class-balanced]
 *
 * {@link trainTagLogOddsModel} reweights the classes to 50/50, which is what
 * the ranking margins want but shifts every intercept by `log(n₋/n₊)`.
 * Adding `log(n₊/n₋)` back restores the training prior, so the probabilities
 * can be counted as "how many of these carry the tag" without over-reporting
 * rare tags.
 */
export const tagPresenceProbabilities = (
    request: Pick<KitPresenceWorkerRequest, "dim" | "tags" | "candidateVectors">,
    tagModels: readonly TagLogOddsModel[],
): Float32Array => {
    const { dim, tags, candidateVectors } = request;
    const count = candidateVectors.length / dim;
    const out = new Float32Array(count * tags.length);
    tags.forEach((tag, column) => {
        let positives = 0;
        for (const label of tag.labels) {
            positives += label;
        }
        const priorShift = Math.log(
            Math.max(positives, 1) / Math.max(tag.labels.length - positives, 1),
        );
        const model = tagModels[column]!;
        for (let index = 0; index < count; index += 1) {
            const logOdds =
                dotRow(candidateVectors, index * dim, model.weights, dim) +
                model.offset +
                priorShift;
            out[index * tags.length + column] = 1 / (1 + Math.exp(-logOdds));
        }
    });
    return out;
};

/**
 * Count, per kit, the shown files assigned to it as best fit.
 *
 * Among kits that are not excluded, a file matches a kit when every kit tag
 * is present (known, or `p ≥ {@link KIT_PRESENCE_EXACT_THRESHOLD}` for
 * embedded files). Extra tags do not reject. Each file is credited to one
 * matching kit: the most tags wins, then id — so a child beats its parent,
 * and unchecking the child sends those photos to the next-best remaining
 * match. Excluded kits get 0. Kits with no tags are skipped.
 */
export const countKitPresence = (
    kits: readonly { id: string; tags: readonly string[] }[],
    viewFileIds: readonly number[],
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>,
    estimate: KitPresenceEstimate,
    excludedKitIds?: ReadonlySet<string>,
): Map<string, number> => {
    const { tagNames, candidateIds, tagProbabilities } = estimate;
    const columnByTag = new Map(tagNames.map((name, column) => [name, column]));
    const rowByFileId = new Map(candidateIds.map((id, row) => [id, row]));
    const counts = new Map<string, number>();
    const included: { id: string; tags: readonly string[] }[] = [];
    for (const kit of kits) {
        if (excludedKitIds?.has(kit.id)) {
            counts.set(kit.id, 0);
            continue;
        }
        if (!kit.tags.length) {
            continue;
        }
        included.push(kit);
        counts.set(kit.id, 0);
    }
    for (const fileId of viewFileIds) {
        const row = rowByFileId.get(fileId);
        let best: { id: string; tags: readonly string[] } | undefined;
        for (const kit of included) {
            if (!fileHasAllKitTags(
                fileId,
                kit.tags,
                fileIdsByTag,
                row,
                tagNames,
                columnByTag,
                tagProbabilities,
            )) {
                continue;
            }
            if (
                !best ||
                kit.tags.length > best.tags.length ||
                (kit.tags.length === best.tags.length && kit.id < best.id)
            ) {
                best = kit;
            }
        }
        if (best) {
            counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
        }
    }
    return counts;
};

const fileHasAllKitTags = (
    fileId: number,
    kitTags: readonly string[],
    fileIdsByTag: ReadonlyMap<string, ReadonlySet<number>>,
    row: number | undefined,
    tagNames: readonly string[],
    columnByTag: ReadonlyMap<string, number>,
    tagProbabilities: Float32Array,
): boolean => {
    for (const tag of kitTags) {
        if (fileIdsByTag.get(tag)?.has(fileId)) {
            continue;
        }
        const column = columnByTag.get(tag);
        if (row === undefined || column === undefined) {
            return false;
        }
        if (tagProbabilities[row * tagNames.length + column]! <
            KIT_PRESENCE_EXACT_THRESHOLD) {
            return false;
        }
    }
    return true;
};

/**
 * `S⁻¹(c_selected − c_hard)` from the training rows, or `undefined` when the
 * kit has no complete or no partial members among them.
 */
const hardMarginDirection = (
    vectors: Float32Array,
    rows: number,
    dim: number,
    tags: readonly { labels: Uint8Array }[],
    lower: Float64Array,
): Float64Array | undefined => {
    const selectedSum = new Float64Array(dim);
    const hardSum = new Float64Array(dim);
    let selectedCount = 0;
    let hardCount = 0;
    for (let row = 0; row < rows; row += 1) {
        let carried = 0;
        for (const tag of tags) {
            carried += tag.labels[row]!;
        }
        if (carried === 0) {
            continue;
        }
        const target = carried === tags.length ? selectedSum : hardSum;
        const offset = row * dim;
        for (let d = 0; d < dim; d += 1) {
            target[d]! += vectors[offset + d]!;
        }
        if (carried === tags.length) {
            selectedCount += 1;
        } else {
            hardCount += 1;
        }
    }
    if (selectedCount === 0 || hardCount === 0) {
        return undefined;
    }
    l2Normalise(selectedSum);
    l2Normalise(hardSum);
    const difference = new Float64Array(dim);
    for (let d = 0; d < dim; d += 1) {
        difference[d] = selectedSum[d]! - hardSum[d]!;
    }
    const solved = new Float64Array(dim);
    forwardSolve(lower, difference, solved, dim);
    return backwardSolve(lower, solved, dim);
};

const dotRow = (
    matrix: Float32Array,
    offset: number,
    vector: Float64Array,
    dim: number,
): number => {
    let sum = 0;
    for (let d = 0; d < dim; d += 1) {
        sum += matrix[offset + d]! * vector[d]!;
    }
    return sum;
};

const centreRow = (
    matrix: Float32Array,
    offset: number,
    mu: Float64Array,
    out: Float64Array,
): void => {
    for (let d = 0; d < out.length; d += 1) {
        out[d] = matrix[offset + d]! - mu[d]!;
    }
};

const l2Normalise = (vector: Float64Array): void => {
    let norm = 0;
    for (const value of vector) {
        norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < vector.length; d += 1) {
        vector[d]! /= norm;
    }
};

/** Lower Cholesky factor of a symmetric positive-definite row-major matrix. */
const cholesky = (matrix: Float64Array, dim: number): Float64Array => {
    const lower = new Float64Array(dim * dim);
    for (let i = 0; i < dim; i += 1) {
        for (let j = 0; j <= i; j += 1) {
            let sum = matrix[i * dim + j]!;
            for (let k = 0; k < j; k += 1) {
                sum -= lower[i * dim + k]! * lower[j * dim + k]!;
            }
            lower[i * dim + j] =
                i === j ?
                    Math.sqrt(Math.max(sum, 1e-12)) :
                    sum / lower[j * dim + j]!;
        }
    }
    return lower;
};

/** Solve `L y = b` into `out`. */
const forwardSolve = (
    lower: Float64Array,
    rhs: Float64Array,
    out: Float64Array,
    dim: number,
): void => {
    for (let i = 0; i < dim; i += 1) {
        let sum = rhs[i]!;
        for (let k = 0; k < i; k += 1) {
            sum -= lower[i * dim + k]! * out[k]!;
        }
        out[i] = sum / lower[i * dim + i]!;
    }
};

/** Solve `Lᵀ x = y`. */
const backwardSolve = (
    lower: Float64Array,
    rhs: Float64Array,
    dim: number,
): Float64Array => {
    const out = new Float64Array(dim);
    for (let i = dim - 1; i >= 0; i -= 1) {
        let sum = rhs[i]!;
        for (let k = i + 1; k < dim; k += 1) {
            sum -= lower[k * dim + i]! * out[k]!;
        }
        out[i] = sum / lower[i * dim + i]!;
    }
    return out;
};

/** Population standard deviation; zero spread reports 1 so scaling is a no-op. */
const standardDeviation = (values: Float32Array | Float64Array): number => {
    const count = values.length;
    if (count === 0) {
        return 1;
    }
    let mean = 0;
    for (let i = 0; i < count; i += 1) {
        mean += values[i]!;
    }
    mean /= count;
    let variance = 0;
    for (let i = 0; i < count; i += 1) {
        const delta = values[i]! - mean;
        variance += delta * delta;
    }
    variance /= count;
    return variance > 0 ? Math.sqrt(variance) : 1;
};
