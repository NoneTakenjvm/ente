/**
 * Pass 4: leakage-free global photo splits and genuinely different CLIP
 * scoring families.
 *
 * Every evaluated photo is held out from every selected/rival/tag prototype.
 * dHash near-duplicate groups stay on one side of the split. Hyperparameters
 * are selected on seed 42, then fixed and confirmed on four other splits.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass4.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import {
    runStage1ClusteringSync,
    type Stage1Item,
} from "../src/lib/similarity-stage1-core";

const CORPUS_PATH =
    "C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json";
const NOTES_PATH =
    "C:/Users/Elliot/Documents/Development/cursor-workspace/ente/mobileapp/scripts/kit-nearness-s2-research.md";

const DIM = 512;
const MIN_KIT_MEMBERS = 20;
const MIN_TRAIN_POSITIVES = 8;
const MIN_TEST_POSITIVES = 5;
const MIN_TEST_HARD_NEGATIVES = 16;
const MIN_TEST_EASY_NEGATIVES = 24;
const JACCARD_DEDUP = 0.85;
const MAX_KITS_PER_ARITY = 24;
const TRAIN_FRACTION = 0.6;
const PRODUCTION_SEED_CAP = 150;
const DUPLICATE_HAMMING_THRESHOLD = Number.parseInt(
    process.env.PASS4_DUP_THRESHOLD ?? "6",
    10,
);
const PRODUCTION_LAMBDA = 16;
const PRODUCTION_TAU = 0.02;
const DEVELOPMENT_SEED = 42;
const CONFIRMATION_SEEDS = [99, 123, 2024, 7] as const;

type SourcePhoto = AnonymisedKitNearnessCorpus["photos"][number];

type Photo = {
    id: number;
    tags: ReadonlySet<string>;
    vector: Float32Array;
    hashes: string[];
};

type EvalKit = {
    id: string;
    source: "saved" | "and-combo";
    tags: string[];
    memberIds: number[];
};

type SplitKit = {
    kit: EvalKit;
    trainPositiveIds: number[];
    testPositiveIds: number[];
    testHardNegativeIds: number[];
    testEasyNegativeIds: number[];
};

type RivalSimilarity = {
    similarity: number;
    weight: number;
};

type CandidateFeatures = {
    id: number;
    label: "positive" | "hard" | "easy";
    selected: number;
    selectedAll: number;
    rivals: RivalSimilarity[];
    rivalsAll: RivalSimilarity[];
    hardNegative: number;
    globalTagMargins: number[];
    siblingTagMargins: number[];
};

type KitFeatures = {
    fold: SplitKit;
    candidates: CandidateFeatures[];
};

type KitMetrics = {
    hardAuc: number;
    easyAuc: number;
    hardAveragePrecision: number;
    fullAveragePrecision: number;
    hardTop12: number;
    fullTop12: number;
    fullNdcg24: number;
};

type AggregateMetrics = KitMetrics & {
    kitCount: number;
    objective: number;
};

type MethodResult = {
    name: string;
    family: ScorerFamily;
    all: AggregateMetrics;
    saved: AggregateMetrics;
    byKit: Map<string, KitMetrics>;
};

type ScorerFamily =
    | "production"
    | "sampling"
    | "margin"
    | "softmax"
    | "negative"
    | "compositional"
    | "combined";

type Scorer = {
    name: string;
    family: ScorerFamily;
    score: (features: CandidateFeatures) => number;
};

type SplitContext = {
    seed: number;
    trainIds: Set<number>;
    testIds: Set<number>;
    folds: SplitKit[];
    features: KitFeatures[];
};

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const shuffleInPlace = <T>(items: T[], random: () => number): void => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const value = items[i]!;
        items[i] = items[j]!;
        items[j] = value;
    }
};

const mean = (values: readonly number[]): number =>
    values.length > 0 ?
        values.reduce((total, value) => total + value, 0) / values.length :
        0;

const l2Normalize = (values: ArrayLike<number>): Float32Array | undefined => {
    let norm = 0;
    for (let i = 0; i < values.length; i++) {
        norm += values[i]! * values[i]!;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) {
        return undefined;
    }
    return Float32Array.from(values, (value) => value / norm);
};

const dot = (
    left: ArrayLike<number> | undefined,
    right: ArrayLike<number> | undefined,
): number => {
    if (!left || !right || left.length !== right.length) {
        return Number.NEGATIVE_INFINITY;
    }
    let result = 0;
    for (let i = 0; i < left.length; i++) {
        result += left[i]! * right[i]!;
    }
    return result;
};

const comboKey = (tags: readonly string[]): string =>
    [...tags].sort().join("|");

const hasAll = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.length > 0 && kitTags.every((tag) => photoTags.has(tag));

const sharesAny = (
    photoTags: ReadonlySet<string>,
    kitTags: readonly string[],
): boolean => kitTags.some((tag) => photoTags.has(tag));

const jaccard = (
    left: ReadonlySet<number>,
    right: ReadonlySet<number>,
): number => {
    let intersection = 0;
    for (const id of left) {
        if (right.has(id)) {
            intersection += 1;
        }
    }
    const union = left.size + right.size - intersection;
    return union > 0 ? intersection / union : 0;
};

const centroid = (
    ids: readonly number[],
    photoById: ReadonlyMap<number, Photo>,
    cap: number = Number.POSITIVE_INFINITY,
): Float32Array | undefined => {
    const selected =
        Number.isFinite(cap) ?
            [...ids].sort((a, b) => a - b).slice(0, cap) :
            ids;
    const sum = new Float64Array(DIM);
    let count = 0;
    for (const id of selected) {
        const vector = photoById.get(id)?.vector;
        if (!vector || vector.length !== DIM) {
            continue;
        }
        for (let i = 0; i < DIM; i++) {
            sum[i]! += vector[i]!;
        }
        count += 1;
    }
    if (count === 0) {
        return undefined;
    }
    return l2Normalize(sum);
};

const countTagCombos = (
    photos: readonly Photo[],
    arity: number,
): Map<string, number[]> => {
    const counts = new Map<string, number[]>();
    for (const photo of photos) {
        const tags = [...photo.tags].sort();
        if (tags.length < arity) {
            continue;
        }
        const visit = (start: number, chosen: string[]): void => {
            if (chosen.length === arity) {
                const key = comboKey(chosen);
                const ids = counts.get(key);
                if (ids) {
                    ids.push(photo.id);
                } else {
                    counts.set(key, [photo.id]);
                }
                return;
            }
            const remaining = arity - chosen.length;
            for (let i = start; i <= tags.length - remaining; i++) {
                chosen.push(tags[i]!);
                visit(i + 1, chosen);
                chosen.pop();
            }
        };
        visit(0, []);
    }
    for (const [key, ids] of counts) {
        if (ids.length < MIN_KIT_MEMBERS) {
            counts.delete(key);
        }
    }
    return counts;
};

const buildEvalKits = (
    corpus: AnonymisedKitNearnessCorpus,
    photos: readonly Photo[],
): EvalKit[] => {
    const kits: EvalKit[] = [];
    for (const saved of corpus.kits) {
        const memberIds = photos
            .filter((photo) => hasAll(photo.tags, saved.tags))
            .map((photo) => photo.id);
        if (saved.tags.length > 0 && memberIds.length >= MIN_KIT_MEMBERS) {
            kits.push({
                id: saved.id,
                source: "saved",
                tags: [...saved.tags].sort(),
                memberIds,
            });
        }
    }
    for (const arity of [1, 2, 3]) {
        const combos = [...countTagCombos(photos, arity).entries()].sort(
            (left, right) => right[1].length - left[1].length,
        );
        for (
            let index = 0;
            index < Math.min(combos.length, MAX_KITS_PER_ARITY);
            index++
        ) {
            const [key, memberIds] = combos[index]!;
            kits.push({
                id: `and${arity}_${String(index + 1).padStart(2, "0")}`,
                source: "and-combo",
                tags: key.split("|"),
                memberIds,
            });
        }
    }

    const uniqueByTags = new Map<string, EvalKit>();
    for (const kit of kits) {
        const key = comboKey(kit.tags);
        const previous = uniqueByTags.get(key);
        if (
            !previous ||
            (previous.source !== "saved" && kit.source === "saved") ||
            kit.memberIds.length > previous.memberIds.length
        ) {
            uniqueByTags.set(key, kit);
        }
    }
    const sorted = [...uniqueByTags.values()].sort(
        (left, right) =>
            right.tags.length - left.tags.length ||
            right.memberIds.length - left.memberIds.length,
    );
    const kept: EvalKit[] = [];
    const memberSets: Set<number>[] = [];
    for (const kit of sorted) {
        const members = new Set(kit.memberIds);
        if (
            memberSets.some(
                (existing) => jaccard(members, existing) >= JACCARD_DEDUP,
            )
        ) {
            continue;
        }
        kept.push(kit);
        memberSets.push(members);
    }
    return kept;
};

const buildDuplicateGroups = (photos: readonly Photo[]): number[][] => {
    const hashedItems: Stage1Item[] = photos
        .filter((photo) => photo.hashes.length > 0)
        .map((photo) => ({ fileId: photo.id, hashes: photo.hashes }));
    const clusters = runStage1ClusteringSync(
        hashedItems,
        DUPLICATE_HAMMING_THRESHOLD,
    );
    const groupedIds = new Set<number>();
    const groups: number[][] = [];
    for (const cluster of clusters) {
        const ids = [...cluster.fileIds].sort((a, b) => a - b);
        groups.push(ids);
        for (const id of ids) {
            groupedIds.add(id);
        }
    }
    for (const photo of photos) {
        if (!groupedIds.has(photo.id)) {
            groups.push([photo.id]);
        }
    }
    return groups;
};

const makeGlobalSplit = (
    photos: readonly Photo[],
    duplicateGroups: readonly number[][],
    seed: number,
): { trainIds: Set<number>; testIds: Set<number> } => {
    const groups = duplicateGroups.map((group) => [...group]);
    shuffleInPlace(groups, mulberry32(seed));
    const targetTrainCount = Math.floor(photos.length * TRAIN_FRACTION);
    const trainIds = new Set<number>();
    const testIds = new Set<number>();
    for (const group of groups) {
        const destination =
            trainIds.size < targetTrainCount ? trainIds : testIds;
        for (const id of group) {
            destination.add(id);
        }
    }
    return { trainIds, testIds };
};

const makeThreeWaySplit = (
    photos: readonly Photo[],
    duplicateGroups: readonly number[][],
    seed: number,
): {
    trainIds: Set<number>;
    validationIds: Set<number>;
    testIds: Set<number>;
} => {
    const groups = duplicateGroups.map((group) => [...group]);
    shuffleInPlace(groups, mulberry32(seed));
    const trainTarget = Math.floor(photos.length * 0.6);
    const validationTarget = Math.floor(photos.length * 0.2);
    const trainIds = new Set<number>();
    const validationIds = new Set<number>();
    const testIds = new Set<number>();
    for (const group of groups) {
        const destination =
            trainIds.size < trainTarget ?
                trainIds :
                validationIds.size < validationTarget ?
                    validationIds :
                    testIds;
        for (const id of group) {
            destination.add(id);
        }
    }
    return { trainIds, validationIds, testIds };
};

const buildSplitKits = (
    kits: readonly EvalKit[],
    photos: readonly Photo[],
    trainIds: ReadonlySet<number>,
    testIds: ReadonlySet<number>,
): SplitKit[] => {
    const folds: SplitKit[] = [];
    for (const kit of kits) {
        if (kit.tags.length < 2) {
            continue;
        }
        const trainPositiveIds = kit.memberIds.filter((id) => trainIds.has(id));
        const testPositiveIds = kit.memberIds.filter((id) => testIds.has(id));
        const testHardNegativeIds: number[] = [];
        const testEasyNegativeIds: number[] = [];
        for (const photo of photos) {
            if (
                !testIds.has(photo.id) ||
                hasAll(photo.tags, kit.tags)
            ) {
                continue;
            }
            if (sharesAny(photo.tags, kit.tags)) {
                testHardNegativeIds.push(photo.id);
            } else {
                testEasyNegativeIds.push(photo.id);
            }
        }
        if (
            trainPositiveIds.length < MIN_TRAIN_POSITIVES ||
            testPositiveIds.length < MIN_TEST_POSITIVES ||
            testHardNegativeIds.length < MIN_TEST_HARD_NEGATIVES ||
            testEasyNegativeIds.length < MIN_TEST_EASY_NEGATIVES
        ) {
            continue;
        }
        folds.push({
            kit,
            trainPositiveIds,
            testPositiveIds,
            testHardNegativeIds,
            testEasyNegativeIds,
        });
    }
    return folds;
};

const distinctivenessWeight = (
    selected: ArrayLike<number>,
    rival: ArrayLike<number>,
): number => {
    const distance = 1 - dot(selected, rival);
    return distance > 0 ? distance / (distance + PRODUCTION_TAU) : 0;
};

type SavedPrototype = {
    id: string;
    tagsKey: string;
    capped: Float32Array;
    all: Float32Array;
};

type TagPrototype = {
    positive: Float32Array;
    negative: Float32Array;
};

const buildTagPrototypes = (
    photos: readonly Photo[],
    trainIds: ReadonlySet<number>,
    photoById: ReadonlyMap<number, Photo>,
): Map<string, TagPrototype> => {
    const tags = new Set<string>();
    for (const photo of photos) {
        for (const tag of photo.tags) {
            tags.add(tag);
        }
    }
    const result = new Map<string, TagPrototype>();
    for (const tag of tags) {
        const positiveIds: number[] = [];
        const negativeIds: number[] = [];
        for (const photo of photos) {
            if (!trainIds.has(photo.id)) {
                continue;
            }
            if (photo.tags.has(tag)) {
                positiveIds.push(photo.id);
            } else {
                negativeIds.push(photo.id);
            }
        }
        const positive = centroid(positiveIds, photoById);
        const negative = centroid(negativeIds, photoById);
        if (positive && negative) {
            result.set(tag, { positive, negative });
        }
    }
    return result;
};

const buildFeatures = (
    photos: readonly Photo[],
    photoById: ReadonlyMap<number, Photo>,
    folds: readonly SplitKit[],
    kits: readonly EvalKit[],
    trainIds: ReadonlySet<number>,
): KitFeatures[] => {
    const savedPrototypes: SavedPrototype[] = [];
    for (const kit of kits) {
        if (kit.source !== "saved") {
            continue;
        }
        const trainMembers = kit.memberIds.filter((id) => trainIds.has(id));
        const capped = centroid(
            trainMembers,
            photoById,
            PRODUCTION_SEED_CAP,
        );
        const all = centroid(trainMembers, photoById);
        if (capped && all) {
            savedPrototypes.push({
                id: kit.id,
                tagsKey: comboKey(kit.tags),
                capped,
                all,
            });
        }
    }
    const globalTagPrototypes = buildTagPrototypes(
        photos,
        trainIds,
        photoById,
    );
    const features: KitFeatures[] = [];
    for (const fold of folds) {
        const selected = centroid(
            fold.trainPositiveIds,
            photoById,
            PRODUCTION_SEED_CAP,
        );
        const selectedAll = centroid(fold.trainPositiveIds, photoById);
        if (!selected || !selectedAll) {
            continue;
        }
        const hardTrainIds = photos
            .filter(
                (photo) =>
                    trainIds.has(photo.id) &&
                    !hasAll(photo.tags, fold.kit.tags) &&
                    sharesAny(photo.tags, fold.kit.tags),
            )
            .map((photo) => photo.id);
        const hardNegative = centroid(hardTrainIds, photoById);
        if (!hardNegative) {
            continue;
        }

        const siblingNegativeByTag = new Map<string, Float32Array>();
        for (const tag of fold.kit.tags) {
            const ids = photos
                .filter(
                    (photo) =>
                        trainIds.has(photo.id) &&
                        !photo.tags.has(tag) &&
                        fold.kit.tags.some((other) =>
                            other !== tag && photo.tags.has(other),
                        ),
                )
                .map((photo) => photo.id);
            const prototype = centroid(ids, photoById);
            if (prototype) {
                siblingNegativeByTag.set(tag, prototype);
            }
        }

        const rivalModels = savedPrototypes.filter(
            (rival) =>
                rival.id !== fold.kit.id &&
                rival.tagsKey !== comboKey(fold.kit.tags),
        );
        const cappedWeights = rivalModels.map((rival) =>
            distinctivenessWeight(selected, rival.capped));
        const allWeights = rivalModels.map((rival) =>
            distinctivenessWeight(selectedAll, rival.all));
        const positiveIds = new Set(fold.testPositiveIds);
        const hardIds = new Set(fold.testHardNegativeIds);
        const candidateIds = [
            ...fold.testPositiveIds,
            ...fold.testHardNegativeIds,
            ...fold.testEasyNegativeIds,
        ];
        const candidates: CandidateFeatures[] = [];
        for (const id of candidateIds) {
            const vector = photoById.get(id)?.vector;
            if (!vector) {
                continue;
            }
            const globalTagMargins: number[] = [];
            const siblingTagMargins: number[] = [];
            for (const tag of fold.kit.tags) {
                const global = globalTagPrototypes.get(tag);
                if (!global) {
                    continue;
                }
                const positiveSimilarity = dot(vector, global.positive);
                globalTagMargins.push(
                    positiveSimilarity - dot(vector, global.negative),
                );
                const siblingNegative = siblingNegativeByTag.get(tag);
                if (siblingNegative) {
                    siblingTagMargins.push(
                        positiveSimilarity - dot(vector, siblingNegative),
                    );
                }
            }
            candidates.push({
                id,
                label:
                    positiveIds.has(id) ?
                        "positive" :
                        hardIds.has(id) ? "hard" : "easy",
                selected: dot(vector, selected),
                selectedAll: dot(vector, selectedAll),
                rivals: rivalModels.map((rival, index) => ({
                    similarity: dot(vector, rival.capped),
                    weight: cappedWeights[index]!,
                })),
                rivalsAll: rivalModels.map((rival, index) => ({
                    similarity: dot(vector, rival.all),
                    weight: allWeights[index]!,
                })),
                hardNegative: dot(vector, hardNegative),
                globalTagMargins,
                siblingTagMargins,
            });
        }
        features.push({ fold, candidates });
    }
    return features;
};

const productionScore = (
    selected: number,
    rivals: readonly RivalSimilarity[],
): number => {
    let strongestSteal = 0;
    for (const rival of rivals) {
        const steal =
            Math.max(0, rival.similarity - selected) * rival.weight;
        strongestSteal = Math.max(strongestSteal, steal);
    }
    return selected - PRODUCTION_LAMBDA * strongestSteal;
};

const adjustedRivalSimilarities = (
    selected: number,
    rivals: readonly RivalSimilarity[],
): number[] =>
    rivals.map(
        (rival) =>
            selected + rival.weight * (rival.similarity - selected),
    );

const topRivalMean = (
    selected: number,
    rivals: readonly RivalSimilarity[],
    count: number,
): number => {
    const similarities = adjustedRivalSimilarities(selected, rivals).sort(
        (left, right) => right - left,
    );
    return similarities.length > 0 ?
        mean(similarities.slice(0, Math.min(count, similarities.length))) :
        selected;
};

const softRivalMaximum = (
    selected: number,
    rivals: readonly RivalSimilarity[],
    temperature: number,
): number => {
    const similarities = adjustedRivalSimilarities(selected, rivals);
    if (similarities.length === 0) {
        return selected;
    }
    const maximum = Math.max(...similarities);
    const expMean = mean(
        similarities.map((value) =>
            Math.exp((value - maximum) / temperature)),
    );
    return maximum + temperature * Math.log(Math.max(expMean, 1e-12));
};

const minOrZero = (values: readonly number[]): number =>
    values.length > 0 ? Math.min(...values) : 0;

const meanOrZero = (values: readonly number[]): number => mean(values);

const buildScorers = (): Scorer[] => {
    const scorers: Scorer[] = [
        {
            name: "production λ16/τ.02 cap150",
            family: "production",
            score: (features) =>
                productionScore(features.selected, features.rivals),
        },
        {
            name: "production all seeds",
            family: "sampling",
            score: (features) =>
                productionScore(features.selectedAll, features.rivalsAll),
        },
        {
            name: "plain centroid cap150",
            family: "sampling",
            score: (features) => features.selected,
        },
        {
            name: "plain centroid all seeds",
            family: "sampling",
            score: (features) => features.selectedAll,
        },
    ];

    for (const count of [1, 3, 5]) {
        for (const alpha of [0.25, 0.5, 1, 2, 4, 8, 16]) {
            scorers.push({
                name: `symmetric margin top${count} a${alpha}`,
                family: "margin",
                score: (features) => {
                    const rival = topRivalMean(
                        features.selected,
                        features.rivals,
                        count,
                    );
                    return (
                        features.selected +
                        alpha * (features.selected - rival)
                    );
                },
            });
        }
    }
    for (const temperature of [0.01, 0.02, 0.04, 0.08]) {
        for (const alpha of [0.5, 1, 2, 4, 8, 16]) {
            scorers.push({
                name: `soft rival T${temperature} a${alpha}`,
                family: "softmax",
                score: (features) => {
                    const rival = softRivalMaximum(
                        features.selected,
                        features.rivals,
                        temperature,
                    );
                    return (
                        features.selected +
                        alpha * (features.selected - rival)
                    );
                },
            });
        }
    }
    for (const alpha of [
        0.1, 0.25, 0.5, 1, 2, 4, 8, 12, 16, 24, 32,
    ]) {
        scorers.push({
            name: `negative centroid a${alpha}`,
            family: "negative",
            score: (features) =>
                features.selected +
                alpha * (features.selected - features.hardNegative),
        });
        scorers.push({
            name: `production + negative a${alpha}`,
            family: "negative",
            score: (features) =>
                productionScore(features.selected, features.rivals) +
                alpha * (features.selected - features.hardNegative),
        });
    }

    const tagSignals: Array<{
        name: string;
        read: (features: CandidateFeatures) => number;
    }> = [
        {
            name: "global tag min",
            read: (features) => minOrZero(features.globalTagMargins),
        },
        {
            name: "global tag mean",
            read: (features) => meanOrZero(features.globalTagMargins),
        },
        {
            name: "sibling tag min",
            read: (features) => minOrZero(features.siblingTagMargins),
        },
        {
            name: "sibling tag mean",
            read: (features) => meanOrZero(features.siblingTagMargins),
        },
    ];
    for (const signal of tagSignals) {
        scorers.push({
            name: signal.name,
            family: "compositional",
            score: signal.read,
        });
        for (const alpha of [
            0.25, 0.5, 1, 2, 4, 8, 12, 16, 24, 32,
        ]) {
            scorers.push({
                name: `centroid + ${signal.name} a${alpha}`,
                family: "compositional",
                score: (features) =>
                    features.selected + alpha * signal.read(features),
            });
            scorers.push({
                name: `production + ${signal.name} a${alpha}`,
                family: "compositional",
                score: (features) =>
                    productionScore(features.selected, features.rivals) +
                    alpha * signal.read(features),
            });
        }
    }
    for (const negativeAlpha of [2, 4, 6, 8, 12, 16, 24, 32]) {
        for (const tagAlpha of [1, 2, 4, 8, 12, 16, 24, 32]) {
            scorers.push({
                name: `prod + neg a${negativeAlpha} + tag-min a${tagAlpha}`,
                family: "combined",
                score: (features) =>
                    productionScore(features.selected, features.rivals) +
                    negativeAlpha *
                        (features.selected - features.hardNegative) +
                    tagAlpha * minOrZero(features.globalTagMargins),
            });
        }
    }
    for (const negativeAlpha of [1, 2, 4, 8]) {
        scorers.push({
            name: `soft-rival + negative a${negativeAlpha}`,
            family: "combined",
            score: (features) => {
                const rival = softRivalMaximum(
                    features.selected,
                    features.rivals,
                    0.01,
                );
                return (
                    features.selected +
                    16 * (features.selected - rival) +
                    negativeAlpha *
                        (features.selected - features.hardNegative)
                );
            },
        });
    }
    return scorers;
};

const pairwiseAuc = (
    positives: readonly number[],
    negatives: readonly number[],
): number => {
    if (positives.length === 0 || negatives.length === 0) {
        return 0.5;
    }
    let wins = 0;
    let ties = 0;
    for (const positive of positives) {
        for (const negative of negatives) {
            if (positive > negative) {
                wins += 1;
            } else if (positive === negative) {
                ties += 1;
            }
        }
    }
    return (wins + 0.5 * ties) / (positives.length * negatives.length);
};

const averagePrecision = (
    rows: readonly { positive: boolean; score: number }[],
): number => {
    const ranked = [...rows].sort(
        (left, right) => right.score - left.score,
    );
    const positiveCount = ranked.filter((row) => row.positive).length;
    if (positiveCount === 0) {
        return 0;
    }
    let hits = 0;
    let precisionSum = 0;
    ranked.forEach((row, index) => {
        if (row.positive) {
            hits += 1;
            precisionSum += hits / (index + 1);
        }
    });
    return precisionSum / positiveCount;
};

const topHitRate = (
    rows: readonly { positive: boolean; score: number }[],
    requested: number,
): number => {
    const positiveCount = rows.filter((row) => row.positive).length;
    const count = Math.min(requested, positiveCount, rows.length);
    if (count === 0) {
        return 0;
    }
    return (
        [...rows]
            .sort((left, right) => right.score - left.score)
            .slice(0, count)
            .filter((row) => row.positive).length / count
    );
};

const ndcg = (
    rows: readonly { positive: boolean; score: number }[],
    requested: number,
): number => {
    const ranked = [...rows]
        .sort((left, right) => right.score - left.score)
        .slice(0, requested);
    const positiveCount = Math.min(
        requested,
        rows.filter((row) => row.positive).length,
    );
    if (positiveCount === 0) {
        return 0;
    }
    const discountedGain = ranked.reduce(
        (total, row, index) =>
            total + (row.positive ? 1 / Math.log2(index + 2) : 0),
        0,
    );
    let idealGain = 0;
    for (let index = 0; index < positiveCount; index++) {
        idealGain += 1 / Math.log2(index + 2);
    }
    return discountedGain / idealGain;
};

const evaluateKit = (
    features: KitFeatures,
    scorer: Scorer,
): KitMetrics => {
    const scored = features.candidates.map((candidate) => ({
        label: candidate.label,
        positive: candidate.label === "positive",
        score: scorer.score(candidate),
    }));
    const positiveScores = scored
        .filter((row) => row.label === "positive")
        .map((row) => row.score);
    const hardScores = scored
        .filter((row) => row.label === "hard")
        .map((row) => row.score);
    const easyScores = scored
        .filter((row) => row.label === "easy")
        .map((row) => row.score);
    const hardRows = scored.filter((row) => row.label !== "easy");
    return {
        hardAuc: pairwiseAuc(positiveScores, hardScores),
        easyAuc: pairwiseAuc(positiveScores, easyScores),
        hardAveragePrecision: averagePrecision(hardRows),
        fullAveragePrecision: averagePrecision(scored),
        hardTop12: topHitRate(hardRows, 12),
        fullTop12: topHitRate(scored, 12),
        fullNdcg24: ndcg(scored, 24),
    };
};

const aggregate = (
    metrics: readonly KitMetrics[],
): AggregateMetrics => {
    const result: AggregateMetrics = {
        hardAuc: mean(metrics.map((row) => row.hardAuc)),
        easyAuc: mean(metrics.map((row) => row.easyAuc)),
        hardAveragePrecision: mean(
            metrics.map((row) => row.hardAveragePrecision),
        ),
        fullAveragePrecision: mean(
            metrics.map((row) => row.fullAveragePrecision),
        ),
        hardTop12: mean(metrics.map((row) => row.hardTop12)),
        fullTop12: mean(metrics.map((row) => row.fullTop12)),
        fullNdcg24: mean(metrics.map((row) => row.fullNdcg24)),
        kitCount: metrics.length,
        objective: 0,
    };
    result.objective =
        0.5 * result.hardAuc +
        0.3 * result.hardAveragePrecision +
        0.2 * result.hardTop12;
    return result;
};

const metricObjective = (metrics: KitMetrics): number =>
    0.5 * metrics.hardAuc +
    0.3 * metrics.hardAveragePrecision +
    0.2 * metrics.hardTop12;

const evaluateMethod = (
    features: readonly KitFeatures[],
    scorer: Scorer,
): MethodResult => {
    const byKit = new Map<string, KitMetrics>();
    for (const kitFeatures of features) {
        byKit.set(
            kitFeatures.fold.kit.id,
            evaluateKit(kitFeatures, scorer),
        );
    }
    const allRows = [...byKit.values()];
    const savedRows = features
        .filter((entry) => entry.fold.kit.source === "saved")
        .map((entry) => byKit.get(entry.fold.kit.id)!)
        .filter(Boolean);
    return {
        name: scorer.name,
        family: scorer.family,
        all: aggregate(allRows),
        saved: aggregate(savedRows),
        byKit,
    };
};

const buildSplitContext = (
    seed: number,
    photos: readonly Photo[],
    photoById: ReadonlyMap<number, Photo>,
    kits: readonly EvalKit[],
    duplicateGroups: readonly number[][],
): SplitContext => {
    const { trainIds, testIds } = makeGlobalSplit(
        photos,
        duplicateGroups,
        seed,
    );
    const folds = buildSplitKits(kits, photos, trainIds, testIds);
    return {
        seed,
        trainIds,
        testIds,
        folds,
        features: buildFeatures(
            photos,
            photoById,
            folds,
            kits,
            trainIds,
        ),
    };
};

const fmt = (metrics: AggregateMetrics): string =>
    `hard=${(metrics.hardAuc * 100).toFixed(1)} hardAP=${(metrics.hardAveragePrecision * 100).toFixed(1)} hard@12=${(metrics.hardTop12 * 100).toFixed(1)} fullAP=${(metrics.fullAveragePrecision * 100).toFixed(1)} full@12=${(metrics.fullTop12 * 100).toFixed(1)} easy=${(metrics.easyAuc * 100).toFixed(1)}`;

const bootstrapMeanInterval = (
    values: readonly number[],
    seed: number,
): { low: number; high: number } => {
    if (values.length === 0) {
        return { low: 0, high: 0 };
    }
    const random = mulberry32(seed);
    const samples: number[] = [];
    for (let iteration = 0; iteration < 4000; iteration++) {
        const picked: number[] = [];
        for (let i = 0; i < values.length; i++) {
            picked.push(values[Math.floor(random() * values.length)]!);
        }
        samples.push(mean(picked));
    }
    samples.sort((left, right) => left - right);
    return {
        low: samples[Math.floor(samples.length * 0.025)]!,
        high: samples[Math.floor(samples.length * 0.975)]!,
    };
};

const raw = JSON.parse(
    readFileSync(CORPUS_PATH, "utf8"),
) as AnonymisedKitNearnessCorpus;
const photos: Photo[] = [];
for (const source of raw.photos as SourcePhoto[]) {
    if (source.embedding?.length !== (raw.embeddingDims ?? DIM)) {
        continue;
    }
    const vector = l2Normalize(source.embedding);
    if (!vector) {
        continue;
    }
    photos.push({
        id: source.id,
        tags: new Set(source.tags),
        vector,
        hashes: [...source.hashes],
    });
}
const photoById = new Map(photos.map((photo) => [photo.id, photo]));
const kits = buildEvalKits(raw, photos);
const savedKitIds = new Set(
    kits.filter((kit) => kit.source === "saved").map((kit) => kit.id),
);
const duplicateGroups = buildDuplicateGroups(photos);
const duplicatePhotoCount = duplicateGroups
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length, 0);
const scorers = buildScorers();

console.log(
    `pass4 model=${raw.embeddingModelId ?? "?"} photos=${photos.length} kits=${kits.length} scorers=${scorers.length}`,
);
console.log(
    `duplicateGroups=${duplicateGroups.filter((group) => group.length > 1).length} duplicatePhotos=${duplicatePhotoCount} threshold=${DUPLICATE_HAMMING_THRESHOLD}`,
);

console.log("\n=== Development split (global photo split seed 42) ===");
const development = buildSplitContext(
    DEVELOPMENT_SEED,
    photos,
    photoById,
    kits,
    duplicateGroups,
);
console.log(
    `train=${development.trainIds.size} test=${development.testIds.size} folds=${development.features.length} saved=${development.features.filter((entry) => entry.fold.kit.source === "saved").length}`,
);
const developmentResults = scorers
    .map((scorer) => evaluateMethod(development.features, scorer))
    .sort(
        (left, right) =>
            right.saved.objective - left.saved.objective ||
            right.saved.hardAuc - left.saved.hardAuc,
    );
for (const result of developmentResults.slice(0, 18)) {
    console.log(
        `  ${result.name.padEnd(42)} saved ${fmt(result.saved)} obj=${(result.saved.objective * 100).toFixed(1)}`,
    );
}

const baselineName = "production λ16/τ.02 cap150";
const selectedNames = new Set<string>([baselineName]);
for (const family of [
    "sampling",
    "margin",
    "softmax",
    "negative",
    "compositional",
    "combined",
] as const) {
    const best = developmentResults.find((result) => result.family === family);
    if (best) {
        selectedNames.add(best.name);
    }
}
for (const result of developmentResults.slice(0, 3)) {
    selectedNames.add(result.name);
}
const selectedScorers = scorers.filter((scorer) =>
    selectedNames.has(scorer.name));
const recommendedName = "prod + neg a8 + tag-min a8";
const developmentRecommended = developmentResults.find(
    (result) => result.name === recommendedName,
)!;
const combinedCandidates = developmentResults.filter(
    (result) => result.family === "combined",
);
const tunePickByKit = new Map<string, string>();
for (const [kitId, recommendedMetrics] of developmentRecommended.byKit) {
    if (!savedKitIds.has(kitId)) {
        continue;
    }
    let bestName = recommendedName;
    let bestObjective = metricObjective(recommendedMetrics);
    for (const candidate of combinedCandidates) {
        const metrics = candidate.byKit.get(kitId);
        if (!metrics) {
            continue;
        }
        const objective = metricObjective(metrics);
        if (objective > bestObjective) {
            bestName = candidate.name;
            bestObjective = objective;
        }
    }
    if (
        bestName !== recommendedName &&
        bestObjective - metricObjective(recommendedMetrics) >= 0.02
    ) {
        tunePickByKit.set(kitId, bestName);
    } else {
        tunePickByKit.set(kitId, recommendedName);
    }
}
const confirmationScorerNames = new Set(
    selectedScorers.map((scorer) => scorer.name),
);
for (const name of tunePickByKit.values()) {
    confirmationScorerNames.add(name);
}
const confirmationScorers = scorers.filter((scorer) =>
    confirmationScorerNames.has(scorer.name));

console.log("\nSelected on development:");
for (const scorer of selectedScorers) {
    const result = developmentResults.find(
        (entry) => entry.name === scorer.name,
    )!;
    console.log(`  ${scorer.name.padEnd(42)} ${fmt(result.saved)}`);
}

const confirmationBySeed = new Map<number, MethodResult[]>();
console.log("\n=== Fixed confirmation splits ===");
for (const seed of CONFIRMATION_SEEDS) {
    const context = buildSplitContext(
        seed,
        photos,
        photoById,
        kits,
        duplicateGroups,
    );
    const results = confirmationScorers.map((scorer) =>
        evaluateMethod(context.features, scorer));
    confirmationBySeed.set(seed, results);
    console.log(
        `seed=${seed} train=${context.trainIds.size} test=${context.testIds.size} folds=${context.features.length} saved=${context.features.filter((entry) => entry.fold.kit.source === "saved").length}`,
    );
    for (const scorer of selectedScorers) {
        const result = results.find((entry) => entry.name === scorer.name)!;
        console.log(`  ${result.name.padEnd(42)} ${fmt(result.saved)}`);
    }
}

console.log("\n=== Confirmation mean and paired hard-AUC delta ===");
const baselineBySeed = new Map<number, MethodResult>();
for (const [seed, results] of confirmationBySeed) {
    baselineBySeed.set(
        seed,
        results.find((result) => result.name === baselineName)!,
    );
}
type ConfirmationSummary = {
    name: string;
    meanSaved: AggregateMetrics;
    hardDelta: number;
    hardDeltaLow: number;
    hardDeltaHigh: number;
    improved: number;
    hurt: number;
};
const confirmationSummaries: ConfirmationSummary[] = [];
for (const scorer of selectedScorers) {
    const results = [...confirmationBySeed.entries()].map(([seed, rows]) => ({
        seed,
        result: rows.find((row) => row.name === scorer.name)!,
    }));
    const meanSaved = aggregate(
        results.flatMap(({ result }) =>
            [...result.byKit.entries()]
                .filter(([kitId]) => savedKitIds.has(kitId))
                .map(([, metrics]) => metrics)),
    );
    const deltaByKit = new Map<string, number[]>();
    for (const { seed, result } of results) {
        const baseline = baselineBySeed.get(seed)!;
        for (const [kitId, metrics] of result.byKit) {
            if (!savedKitIds.has(kitId)) {
                continue;
            }
            const baselineMetrics = baseline.byKit.get(kitId);
            if (!baselineMetrics) {
                continue;
            }
            const values = deltaByKit.get(kitId);
            const delta = metrics.hardAuc - baselineMetrics.hardAuc;
            if (values) {
                values.push(delta);
            } else {
                deltaByKit.set(kitId, [delta]);
            }
        }
    }
    const kitDeltas = [...deltaByKit.values()].map(mean);
    const interval = bootstrapMeanInterval(
        kitDeltas,
        9000 + selectedScorers.indexOf(scorer),
    );
    confirmationSummaries.push({
        name: scorer.name,
        meanSaved,
        hardDelta: mean(kitDeltas),
        hardDeltaLow: interval.low,
        hardDeltaHigh: interval.high,
        improved: kitDeltas.filter((delta) => delta >= 0.02).length,
        hurt: kitDeltas.filter((delta) => delta <= -0.02).length,
    });
}
confirmationSummaries.sort(
    (left, right) =>
        right.meanSaved.objective - left.meanSaved.objective,
);
for (const summary of confirmationSummaries) {
    console.log(
        `  ${summary.name.padEnd(42)} ${fmt(summary.meanSaved)} Δhard=${(summary.hardDelta * 100).toFixed(2)}pp CI=[${(summary.hardDeltaLow * 100).toFixed(2)},${(summary.hardDeltaHigh * 100).toFixed(2)}] +2pp=${summary.improved} -2pp=${summary.hurt}`,
    );
}

console.log("\n=== Per-kit combined-weight tune (development → confirmation) ===");
const tunePickCounts = new Map<string, number>();
for (const name of tunePickByKit.values()) {
    tunePickCounts.set(name, (tunePickCounts.get(name) ?? 0) + 1);
}
console.log(
    `  picks: ${[...tunePickCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([name, count]) => `${name}×${count}`)
        .join("  ")}`,
);
const tunedMetrics: KitMetrics[] = [];
const recommendedMetrics: KitMetrics[] = [];
const tunedDeltaByKit = new Map<string, number[]>();
const tunedHardTop12DeltaByKit = new Map<string, number[]>();
const tunedFullTop12DeltaByKit = new Map<string, number[]>();
for (const [seed, results] of confirmationBySeed) {
    const byName = new Map(results.map((result) => [result.name, result]));
    const recommended = byName.get(recommendedName)!;
    for (const [kitId, pickedName] of tunePickByKit) {
        const pickedMetrics = byName.get(pickedName)?.byKit.get(kitId);
        const fixedMetrics = recommended.byKit.get(kitId);
        if (!pickedMetrics || !fixedMetrics) {
            continue;
        }
        tunedMetrics.push(pickedMetrics);
        recommendedMetrics.push(fixedMetrics);
        const deltas = tunedDeltaByKit.get(kitId);
        const delta = pickedMetrics.hardAuc - fixedMetrics.hardAuc;
        if (deltas) {
            deltas.push(delta);
        } else {
            tunedDeltaByKit.set(kitId, [delta]);
        }
        const hardTop12Deltas = tunedHardTop12DeltaByKit.get(kitId);
        const hardTop12Delta =
            pickedMetrics.hardTop12 - fixedMetrics.hardTop12;
        if (hardTop12Deltas) {
            hardTop12Deltas.push(hardTop12Delta);
        } else {
            tunedHardTop12DeltaByKit.set(kitId, [hardTop12Delta]);
        }
        const fullTop12Deltas = tunedFullTop12DeltaByKit.get(kitId);
        const fullTop12Delta =
            pickedMetrics.fullTop12 - fixedMetrics.fullTop12;
        if (fullTop12Deltas) {
            fullTop12Deltas.push(fullTop12Delta);
        } else {
            tunedFullTop12DeltaByKit.set(kitId, [fullTop12Delta]);
        }
    }
    void seed;
}
const tunedAggregate = aggregate(tunedMetrics);
const recommendedAggregate = aggregate(recommendedMetrics);
const tunedKitDeltas = [...tunedDeltaByKit.values()].map(mean);
const tunedInterval = bootstrapMeanInterval(tunedKitDeltas, 12042);
const tunedHardTop12KitDeltas = [
    ...tunedHardTop12DeltaByKit.values(),
].map(mean);
const tunedFullTop12KitDeltas = [
    ...tunedFullTop12DeltaByKit.values(),
].map(mean);
const tunedHardTop12Interval = bootstrapMeanInterval(
    tunedHardTop12KitDeltas,
    12043,
);
const tunedFullTop12Interval = bootstrapMeanInterval(
    tunedFullTop12KitDeltas,
    12044,
);
console.log(`  fixed 8/8 ${fmt(recommendedAggregate)}`);
console.log(
    `  tuned     ${fmt(tunedAggregate)} Δhard=${(mean(tunedKitDeltas) * 100).toFixed(2)}pp CI=[${(tunedInterval.low * 100).toFixed(2)},${(tunedInterval.high * 100).toFixed(2)}] +2pp=${tunedKitDeltas.filter((delta) => delta >= 0.02).length} -2pp=${tunedKitDeltas.filter((delta) => delta <= -0.02).length}`,
);
console.log(
    `  first-screen Δhard@12=${(mean(tunedHardTop12KitDeltas) * 100).toFixed(2)}pp CI=[${(tunedHardTop12Interval.low * 100).toFixed(2)},${(tunedHardTop12Interval.high * 100).toFixed(2)}] Δfull@12=${(mean(tunedFullTop12KitDeltas) * 100).toFixed(2)}pp CI=[${(tunedFullTop12Interval.low * 100).toFixed(2)},${(tunedFullTop12Interval.high * 100).toFixed(2)}]`,
);

console.log("\n=== Reserved three-way split (train / validation / test) ===");
const reserved = makeThreeWaySplit(photos, duplicateGroups, 314159);
const reservedValidationFolds = buildSplitKits(
    kits,
    photos,
    reserved.trainIds,
    reserved.validationIds,
);
const reservedTestFolds = buildSplitKits(
    kits,
    photos,
    reserved.trainIds,
    reserved.testIds,
);
const reservedValidationFeatures = buildFeatures(
    photos,
    photoById,
    reservedValidationFolds,
    kits,
    reserved.trainIds,
);
const reservedTestFeatures = buildFeatures(
    photos,
    photoById,
    reservedTestFolds,
    kits,
    reserved.trainIds,
);
console.log(
    `  train=${reserved.trainIds.size} validation=${reserved.validationIds.size} test=${reserved.testIds.size} validationFolds=${reservedValidationFeatures.length} testFolds=${reservedTestFeatures.length}`,
);
const reservedCandidateNames = [
    baselineName,
    "production + negative a16",
    "production + global tag min a8",
    "prod + neg a4 + tag-min a2",
    "prod + neg a6 + tag-min a4",
    recommendedName,
    "prod + neg a16 + tag-min a16",
    "prod + neg a32 + tag-min a24",
    "prod + neg a32 + tag-min a32",
] as const;
const reservedCandidates = reservedCandidateNames
    .map((name) => scorers.find((scorer) => scorer.name === name))
    .filter((scorer): scorer is Scorer => scorer !== undefined);
const reservedValidationResults = reservedCandidates
    .map((scorer) => evaluateMethod(reservedValidationFeatures, scorer))
    .sort(
        (left, right) =>
            right.saved.objective - left.saved.objective,
    );
for (const result of reservedValidationResults) {
    console.log(`  validation ${result.name.padEnd(38)} ${fmt(result.saved)}`);
}
const reservedWinnerName = reservedValidationResults[0]!.name;
const reservedTestResults = reservedCandidates.map((scorer) =>
    evaluateMethod(reservedTestFeatures, scorer));
console.log(`  validation picked: ${reservedWinnerName}`);
for (const result of reservedTestResults) {
    console.log(`  test       ${result.name.padEnd(38)} ${fmt(result.saved)}`);
}
const reservedBaseline = reservedTestResults.find(
    (result) => result.name === baselineName,
)!;
const reservedWinner = reservedTestResults.find(
    (result) => result.name === reservedWinnerName,
)!;
const reservedDeltas: number[] = [];
for (const [kitId, winnerMetrics] of reservedWinner.byKit) {
    if (!savedKitIds.has(kitId)) {
        continue;
    }
    const baselineMetrics = reservedBaseline.byKit.get(kitId);
    if (baselineMetrics) {
        reservedDeltas.push(
            winnerMetrics.hardAuc - baselineMetrics.hardAuc,
        );
    }
}
const reservedInterval = bootstrapMeanInterval(reservedDeltas, 314160);
console.log(
    `  reserved winner Δhard=${(mean(reservedDeltas) * 100).toFixed(2)}pp CI=[${(reservedInterval.low * 100).toFixed(2)},${(reservedInterval.high * 100).toFixed(2)}] +2pp=${reservedDeltas.filter((delta) => delta >= 0.02).length} -2pp=${reservedDeltas.filter((delta) => delta <= -0.02).length}`,
);

const developmentLog = developmentResults
    .slice(0, 18)
    .map(
        (result) =>
            `  ${result.name.padEnd(42)} ${fmt(result.saved)} obj=${(result.saved.objective * 100).toFixed(1)}`,
    )
    .join("\n");
const confirmationLog = confirmationSummaries
    .map(
        (summary) =>
            `  ${summary.name.padEnd(42)} ${fmt(summary.meanSaved)} Δhard=${(summary.hardDelta * 100).toFixed(2)}pp CI=[${(summary.hardDeltaLow * 100).toFixed(2)},${(summary.hardDeltaHigh * 100).toFixed(2)}] +2pp=${summary.improved} -2pp=${summary.hurt}`,
    )
    .join("\n");
const tuneLog = `picks: ${[...tunePickCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join("  ")}
fixed 8/8 ${fmt(recommendedAggregate)}
tuned     ${fmt(tunedAggregate)} Δhard=${(mean(tunedKitDeltas) * 100).toFixed(2)}pp CI=[${(tunedInterval.low * 100).toFixed(2)},${(tunedInterval.high * 100).toFixed(2)}]
first-screen Δhard@12=${(mean(tunedHardTop12KitDeltas) * 100).toFixed(2)}pp CI=[${(tunedHardTop12Interval.low * 100).toFixed(2)},${(tunedHardTop12Interval.high * 100).toFixed(2)}] Δfull@12=${(mean(tunedFullTop12KitDeltas) * 100).toFixed(2)}pp CI=[${(tunedFullTop12Interval.low * 100).toFixed(2)},${(tunedFullTop12Interval.high * 100).toFixed(2)}]`;
const reservedLog = `train=${reserved.trainIds.size} validation=${reserved.validationIds.size} test=${reserved.testIds.size}
validation picked: ${reservedWinnerName}
baseline ${fmt(reservedBaseline.saved)}
winner   ${fmt(reservedWinner.saved)}
Δhard=${(mean(reservedDeltas) * 100).toFixed(2)}pp CI=[${(reservedInterval.low * 100).toFixed(2)},${(reservedInterval.high * 100).toFixed(2)}] +2pp=${reservedDeltas.filter((delta) => delta >= 0.02).length} -2pp=${reservedDeltas.filter((delta) => delta <= -0.02).length}`;
const existingNotes = readFileSync(NOTES_PATH, "utf8");
const previousPass4 = existingNotes.indexOf("## Pass 4");
const interpretationMarker = "## Pass 4 interpretation and handoff";
const interpretationStart = existingNotes.indexOf(interpretationMarker);
const preservedInterpretation =
    interpretationStart >= 0 ?
        existingNotes.slice(interpretationStart).trim() :
        "";
const notesBase =
    previousPass4 >= 0 ?
        existingNotes.slice(0, previousPass4).trimEnd() :
        existingNotes.trimEnd();
const notesSection = `

## Pass 4 — leakage-free scorers (${new Date().toISOString().slice(0, 10)})

Global 60/40 photo split: an evaluated photo is absent from **every** selected,
rival, hard-negative, and tag prototype. dHash-near-duplicate groups (Hamming
≤${DUPLICATE_HAMMING_THRESHOLD}) stay on one side. Seed 42 selected one fixed
candidate per family; seeds ${CONFIRMATION_SEEDS.join("/")} confirmed them.
Metrics use every tagged test photo, not a 180-negative sample. \`hard@12\` and
\`full@12\` use K=min(12, held-out positives).

\`\`\`
corpus photos=${photos.length} kits=${kits.length}
duplicate groups=${duplicateGroups.filter((group) => group.length > 1).length} photos-in-groups=${duplicatePhotoCount}
development train=${development.trainIds.size} test=${development.testIds.size} folds=${development.features.length}

Development top:
${developmentLog}

Confirmation mean (saved kits):
${confirmationLog}

Per-kit weight tune:
${tuneLog}

Reserved three-way result:
${reservedLog}
\`\`\`
`;
if (process.env.PASS4_WRITE_NOTES !== "0") {
    writeFileSync(
        NOTES_PATH,
        `${notesBase}${notesSection}\n${preservedInterpretation ? `${preservedInterpretation}\n` : ""}`,
        "utf8",
    );
    console.log(`\nwrote ${NOTES_PATH}`);
}
