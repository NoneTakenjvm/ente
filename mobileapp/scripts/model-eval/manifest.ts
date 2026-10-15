/**
 * Shared on-disk shape of the public eval datasets used by the model-eval
 * research scripts (image model comparison). Research only; not app code.
 *
 * Each dataset lives in its own folder under {@link modelEvalDataRoot} with a
 * `manifest.json` of type {@link EvalManifest}. Image paths are relative to
 * that folder.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type EvalImage = {
    /** Unique within the dataset. */
    id: string;
    /** Path relative to the dataset folder. */
    file: string;
    /** Multi-label concepts (COCO categories, MIRFLICKR concepts). */
    labels?: string[];
    /** Images of the same scene or the same original (Holidays, Copydays). */
    group?: string;
    /** How the image was made from its group's original: "original", "crop-20", "jpeg-10", … */
    edit?: string;
};

/** Graded near-duplicate judgment: the share of annotators (0–1) who called the pair a near-duplicate. */
export type EvalPair = { a: string; b: string; agreement: number };

export type EvalManifest = {
    dataset: string;
    /** URLs the files were downloaded from. */
    source: string[];
    licenseNote: string;
    images: EvalImage[];
    pairs?: EvalPair[];
};

/**
 * Folder holding the datasets and model vectors, outside the repo. Defaults
 * to `cursor-workspace/model-eval-data` when run from `mobileapp/`; override
 * with `MODEL_EVAL_DATA`.
 */
export const modelEvalDataRoot = (): string =>
    process.env.MODEL_EVAL_DATA ??
    resolve(process.cwd(), "../../model-eval-data");

/** Read a dataset's manifest. */
export const readManifest = (dataset: string): EvalManifest =>
    JSON.parse(
        readFileSync(
            join(modelEvalDataRoot(), dataset, "manifest.json"),
            "utf8",
        ),
    ) as EvalManifest;
