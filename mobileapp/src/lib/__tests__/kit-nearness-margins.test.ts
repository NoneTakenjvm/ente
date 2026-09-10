import { describe, expect, it } from "vitest";
import {
    buildKitWhitening,
    countKitPresence,
    rankByKitMargins,
    tagPresenceProbabilities,
    trainTagLogOddsModel,
    type KitMarginsWorkerRequest,
} from "@/lib/kit-nearness-margins";

const DIM = 4;

const unit = (values: number[]): number[] => {
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
    return values.map((v) => v / norm);
};

/** Deterministic jitter in [-0.1, 0.1) so rows are not exact duplicates. */
const jitter = (index: number, axis: number): number =>
    (((index * 7919 + axis * 104729) % 97) / 97 - 0.5) * 0.2;

const noisyUnit = (base: number[], index: number): number[] =>
    unit(base.map((v, axis) => v + jitter(index, axis)));

const pack = (rows: number[][]): Float32Array => {
    const packed = new Float32Array(rows.length * DIM);
    rows.forEach((row, index) => packed.set(row, index * DIM));
    return packed;
};

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
        sum += a[i]! * b[i]!;
    }
    return sum;
};

/**
 * Toy kit over two tags A and B: members carry both, hard negatives carry
 * one, easy negatives carry neither. Members share a third "kit look" axis
 * so their centroid is not the midpoint of the two partial groups.
 */
const buildToyTraining = (perGroup: number) => {
    const rows: number[][] = [];
    const labelsA: number[] = [];
    const labelsB: number[] = [];
    const push = (base: number[], a: number, b: number): void => {
        for (let i = 0; i < perGroup; i += 1) {
            rows.push(noisyUnit(base, rows.length));
            labelsA.push(a);
            labelsB.push(b);
        }
    };
    push([1, 1, 1, 0], 1, 1); // members
    push([1, 0, 0, 0], 1, 0); // tag A only
    push([0, 1, 0, 0], 0, 1); // tag B only
    push([0, 0, 0, 1], 0, 0); // unrelated
    return {
        rows,
        vectors: pack(rows),
        tags: [
            { name: "a", labels: Uint8Array.from(labelsA) },
            { name: "b", labels: Uint8Array.from(labelsB) },
        ],
    };
};

describe("buildKitWhitening", () => {
    it("factorises the shrunk covariance and whitens rows consistently", () => {
        const { rows, vectors } = buildToyTraining(6);
        const whitening = buildKitWhitening(vectors, rows.length, DIM, 1);

        // Independent shrunk covariance.
        const mu = new Array<number>(DIM).fill(0);
        for (const row of rows) {
            row.forEach((v, d) => (mu[d]! += v / rows.length));
        }
        const covariance = new Array<number>(DIM * DIM).fill(0);
        for (const row of rows) {
            for (let i = 0; i < DIM; i += 1) {
                for (let j = 0; j < DIM; j += 1) {
                    covariance[i * DIM + j]! +=
                        ((row[i]! - mu[i]!) * (row[j]! - mu[j]!)) /
                        rows.length;
                }
            }
        }
        let trace = 0;
        for (let i = 0; i < DIM; i += 1) {
            trace += covariance[i * DIM + i]!;
        }
        for (let i = 0; i < DIM; i += 1) {
            covariance[i * DIM + i]! += trace / DIM;
        }

        // L Lᵀ must reproduce it.
        const { lower } = whitening;
        for (let i = 0; i < DIM; i += 1) {
            for (let j = 0; j < DIM; j += 1) {
                let value = 0;
                for (let k = 0; k < DIM; k += 1) {
                    value += lower[i * DIM + k]! * lower[j * DIM + k]!;
                }
                expect(value).toBeCloseTo(covariance[i * DIM + j]!, 5);
            }
        }

        // L z must reproduce x − μ for the first row.
        for (let i = 0; i < DIM; i += 1) {
            let value = 0;
            for (let k = 0; k < DIM; k += 1) {
                value += lower[i * DIM + k]! * whitening.whitened[k]!;
            }
            expect(value).toBeCloseTo(rows[0]![i]! - whitening.mu[i]!, 4);
        }
    });
});

describe("trainTagLogOddsModel", () => {
    it("separates a tag's carriers in raw space and is deterministic", () => {
        const { rows, vectors, tags } = buildToyTraining(8);
        const whitening = buildKitWhitening(vectors, rows.length, DIM);
        const modelA = trainTagLogOddsModel(whitening, tags[0]!.labels);
        const again = trainTagLogOddsModel(whitening, tags[0]!.labels);

        expect(Array.from(again.weights)).toEqual(Array.from(modelA.weights));
        expect(again.offset).toBe(modelA.offset);

        rows.forEach((row, index) => {
            const logOdds = dot(row, modelA.weights) + modelA.offset;
            if (tags[0]!.labels[index]) {
                expect(logOdds).toBeGreaterThan(0);
            } else {
                expect(logOdds).toBeLessThan(0);
            }
        });
    });

    it("has converged by the production step count", () => {
        const { rows, vectors, tags } = buildToyTraining(8);
        const whitening = buildKitWhitening(vectors, rows.length, DIM);
        const short = trainTagLogOddsModel(whitening, tags[1]!.labels);
        const long = trainTagLogOddsModel(whitening, tags[1]!.labels, {
            iterations: 400,
        });
        const loss = (model: typeof short): number =>
            rows.reduce((sum, row, index) => {
                const logit = dot(row, model.weights) + model.offset;
                const label = tags[1]!.labels[index]!;
                return sum + Math.log(1 + Math.exp(label ? -logit : logit));
            }, 0) / rows.length;
        expect(loss(short) - loss(long)).toBeLessThan(0.02);
    });
});

describe("rankByKitMargins", () => {
    const training = buildToyTraining(8);
    const whitening = buildKitWhitening(
        training.vectors,
        training.rows.length,
        DIM,
    );
    const models = training.tags.map((tag) =>
        trainTagLogOddsModel(whitening, tag.labels));
    const memberCentroid = unit([1, 1, 1, 0]);
    const productionScoreOf = (row: number[]): number =>
        dot(row, memberCentroid);

    const requestFor = (
        candidates: { id: number; row: number[]; productionScore?: number }[],
    ): Omit<KitMarginsWorkerRequest, "kind" | "requestId" | "trainingIds"> => ({
        dim: DIM,
        trainingVectors: training.vectors,
        trainingProductionScores: Float32Array.from(
            training.rows,
            productionScoreOf,
        ),
        tags: training.tags,
        candidateIds: Int32Array.from(candidates, (c) => c.id),
        candidateVectors: pack(candidates.map((c) => c.row)),
        candidateProductionScores: Float32Array.from(
            candidates,
            (c) => c.productionScore ?? productionScoreOf(c.row),
        ),
    });

    it("ranks a member above negatives the production score cannot split", () => {
        const member = noisyUnit([1, 1, 1, 0], 501);
        const onlyA = noisyUnit([1, 0, 0, 0], 502);
        const unrelated = noisyUnit([0, 0, 0, 1], 503);
        const order = rankByKitMargins(
            requestFor([
                { id: 1, row: onlyA, productionScore: 0.7 },
                { id: 2, row: member, productionScore: 0.7 },
                { id: 3, row: unrelated, productionScore: 0.7 },
            ]),
            whitening,
            models,
        );
        expect(order?.[0]).toBe(2);
        expect(order && Array.from(order).sort()).toEqual([1, 2, 3]);
    });

    it("pushes a hard negative below a member it out-scores on production", () => {
        const member = noisyUnit([1, 1, 1, 0], 511);
        const onlyB = noisyUnit([0, 1, 0, 0], 512);
        const order = rankByKitMargins(
            requestFor([
                { id: 1, row: onlyB, productionScore: 0.72 },
                { id: 2, row: member, productionScore: 0.7 },
            ]),
            whitening,
            models,
        );
        expect(order && Array.from(order)).toEqual([2, 1]);
    });

    it("breaks exact ties by lower id", () => {
        const row = noisyUnit([1, 1, 1, 0], 600);
        const order = rankByKitMargins(
            requestFor([
                { id: 9, row },
                { id: 4, row },
            ]),
            whitening,
            models,
        );
        expect(order && Array.from(order)).toEqual([4, 9]);
    });

    it("returns undefined without complete or partial members", () => {
        const noMembers = {
            ...requestFor([{ id: 1, row: noisyUnit([1, 1, 1, 0], 700) }]),
            tags: training.tags.map((tag) => ({
                name: tag.name,
                labels: new Uint8Array(tag.labels.length),
            })),
        };
        expect(rankByKitMargins(noMembers, whitening, models)).toBeUndefined();
    });
});

describe("tagPresenceProbabilities", () => {
    it("restores the training prior on top of the balanced log-odds", () => {
        // Zero weights: the balanced model says 50/50; the shift alone should
        // bring a tag carried by 1 in 4 rows back to 25%.
        const flat = { weights: new Float64Array(DIM), offset: 0 };
        const probabilities = tagPresenceProbabilities(
            {
                dim: DIM,
                tags: [{ name: "a", labels: Uint8Array.from([1, 0, 0, 0]) }],
                candidateVectors: pack([unit([1, 0, 0, 0])]),
            },
            [flat],
        );
        expect(probabilities[0]!).toBeCloseTo(0.25, 5);
    });
});

describe("countKitPresence", () => {
    const kits = [
        { id: "ab", tags: ["a", "b"] },
        { id: "abc", tags: ["a", "b", "c"] },
        { id: "z", tags: ["z"] },
    ];
    const fileIdsByTag = new Map<string, ReadonlySet<number>>([
        ["a", new Set([1, 2, 3])],
        ["b", new Set([1])],
    ]);
    // Rows: file 2 (b likely, c unlikely), file 3 (b borderline, c likely).
    const estimate = {
        tagNames: ["a", "b", "c"],
        candidateIds: [2, 3],
        tagProbabilities: Float32Array.from([1, 0.9, 0.3, 1, 0.4, 0.9]),
    };

    it("assigns each file to the most-specific AND match", () => {
        const counts = countKitPresence(kits, [1, 2, 3, 4], fileIdsByTag, estimate);
        // File 1: known {a,b} → ab. File 2: known {a}, b=0.9, c=0.3 → ab.
        // File 3: a known, b=0.4, c=0.9 → abc beats ab. File 4: nothing.
        expect(counts.get("ab")).toBe(2);
        expect(counts.get("abc")).toBe(1);
        expect(counts.get("z")).toBe(0);
    });

    it("lets a nested child take the photo from its parent", () => {
        const counts = countKitPresence(
            kits,
            [2],
            fileIdsByTag,
            {
                ...estimate,
                candidateIds: [2],
                tagProbabilities: Float32Array.from([1, 0.9, 0.8]),
            },
        );
        expect(counts.get("ab")).toBe(0);
        expect(counts.get("abc")).toBe(1);
    });

    it("gives a known child photo to the child, not the parent", () => {
        const withC = new Map(fileIdsByTag);
        withC.set("c", new Set([1]));
        const counts = countKitPresence(kits, [1], withC, {
            tagNames: ["a", "b", "c"],
            candidateIds: [],
            tagProbabilities: new Float32Array(0),
        });
        expect(counts.get("ab")).toBe(0);
        expect(counts.get("abc")).toBe(1);
    });

    it("sends excluded-kit photos to the next-best remaining match", () => {
        const withC = new Map(fileIdsByTag);
        withC.set("c", new Set([1]));
        const parent = countKitPresence(
            kits,
            [1],
            withC,
            {
                tagNames: ["a", "b", "c"],
                candidateIds: [],
                tagProbabilities: new Float32Array(0),
            },
            new Set(["abc"]),
        );
        expect(parent.get("abc")).toBe(0);
        expect(parent.get("ab")).toBe(1);

        // Equal-specificity siblings: one winner (lower id).
        const overlapping = [
            { id: "a", tags: ["a"] },
            { id: "b", tags: ["b"] },
            { id: "abc", tags: ["a", "b", "c"] },
        ];
        const siblings = countKitPresence(
            overlapping,
            [1],
            withC,
            {
                tagNames: ["a", "b", "c"],
                candidateIds: [],
                tagProbabilities: new Float32Array(0),
            },
            new Set(["abc"]),
        );
        expect(siblings.get("abc")).toBe(0);
        expect(siblings.get("a")).toBe(1);
        expect(siblings.get("b")).toBe(0);
    });

    it("does not let an unrelated remaining kit block fallthrough", () => {
        const withC = new Map(fileIdsByTag);
        withC.set("c", new Set([1]));
        const kitsWithD = [
            ...kits,
            { id: "d", tags: ["d"] },
        ];
        const counts = countKitPresence(
            kitsWithD,
            [1],
            withC,
            {
                tagNames: ["a", "b", "c", "d"],
                candidateIds: [1],
                tagProbabilities: Float32Array.from([1, 1, 0.2, 0.9]),
            },
            new Set(["abc"]),
        );
        expect(counts.get("abc")).toBe(0);
        expect(counts.get("ab")).toBe(1);
        expect(counts.get("d")).toBe(0);
    });
});
