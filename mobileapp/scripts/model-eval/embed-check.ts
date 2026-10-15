/**
 * Checks for embed.ts on the four e2e fixtures. Research only.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/embed-check.ts parity
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/embed-check.ts sanity
 *
 * parity: MobileCLIP-S2 under the app's @huggingface/transformers (3.5.1) vs
 * the transformers-eval alias; prints the max absolute difference per vector.
 * sanity: cosine matrix of fixtures 1-4 plus two edits of fixture 1 (a crop
 * removing 15% of each side, and a JPEG quality-30 re-save), per model.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    loadEmbedder,
    makeThumbnail,
    type ModelName,
    type Transformers,
} from "./embed";

const fixture = (n: number): Buffer =>
    readFileSync(join(process.cwd(), `scripts/fixtures/e2e-smoke-${n}.jpg`));

const fixtureThumbnails = (): Promise<Buffer[]> =>
    Promise.all([1, 2, 3, 4].map((n) => makeThumbnail(fixture(n))));

const parity = async (): Promise<void> => {
    const thumbnails = await fixtureThumbnails();
    const vectorsFor = async (lib: Transformers): Promise<Float32Array[]> =>
        (await loadEmbedder("mobileclip-s2", lib)).embed(thumbnails);
    const appVectors = await vectorsFor(
        (await import("@huggingface/transformers")) as unknown as Transformers,
    );
    const evalVectors = await vectorsFor(await import("transformers-eval"));
    for (const [index, vector] of appVectors.entries()) {
        const maxDiff = vector.reduce(
            (max, value, dim) =>
                Math.max(max, Math.abs(value - evalVectors[index]![dim]!)),
            0,
        );
        console.log(`fixture ${index + 1}: max |diff| = ${maxDiff.toExponential(2)}`);
    }
};

const sanity = async (): Promise<void> => {
    const source = await loadImage(fixture(1));
    const cropX = source.width * 0.15;
    const cropY = source.height * 0.15;
    const cropWidth = source.width - 2 * cropX;
    const cropHeight = source.height - 2 * cropY;
    const cropCanvas = createCanvas(cropWidth, cropHeight);
    cropCanvas
        .getContext("2d")
        .drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const fullCanvas = createCanvas(source.width, source.height);
    fullCanvas.getContext("2d").drawImage(source, 0, 0);

    const thumbnails = [
        ...(await fixtureThumbnails()),
        await makeThumbnail(cropCanvas.toBuffer("image/jpeg", 95)),
        await makeThumbnail(fullCanvas.toBuffer("image/jpeg", 30)),
    ];
    const names = ["f1", "f2", "f3", "f4", "f1-crop15", "f1-q30"];
    const lib: Transformers = await import("transformers-eval");
    for (const model of ["mobileclip-s2", "dinov3-s"] as ModelName[]) {
        const embedder = await loadEmbedder(model, lib);
        await embedder.embed(thumbnails.slice(0, 1));
        const start = performance.now();
        const vectors = await embedder.embed(thumbnails);
        const msPerImage = (performance.now() - start) / vectors.length;
        console.log(
            `\n${model} (${vectors[0]!.length}d, ${embedder.outputKey()}, ${msPerImage.toFixed(0)} ms/image)\n${embedder.preprocessing}`,
        );
        console.log(["          ", ...names.map((name) => name.padStart(9))].join(" "));
        for (const [row, a] of vectors.entries()) {
            const cosines = vectors.map((b) =>
                a.reduce((sum, value, dim) => sum + value * b[dim]!, 0),
            );
            console.log(
                [names[row]!.padEnd(10), ...cosines.map((c) => c.toFixed(3).padStart(9))].join(" "),
            );
        }
    }
};

const mode = process.argv[2];
(mode === "parity" ? parity() : mode === "sanity" ? sanity() : Promise.reject(new Error("Usage: embed-check.ts parity|sanity"))).catch(
    (error: unknown) => {
        console.error(error);
        process.exit(1);
    },
);
