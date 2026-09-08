/**
 * Quick Similar CLIP-nearest baseline on a private corpus JSON.
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/similar-clip-baseline.ts \
 *     --corpus C:/Users/Elliot/Downloads/kit-nearness-corpus.json
 */
import { readFileSync } from "node:fs";
import { evaluateSimilarClipNearest } from "@/lib/similarity-clip-eval";
import type { AnonymisedKitNearnessCorpus } from "@/lib/kit-nearness-corpus-export";

const args = process.argv.slice(2);
const corpusIdx = args.indexOf("--corpus");
const corpusPath =
    corpusIdx >= 0 ? args[corpusIdx + 1] : undefined;
if (!corpusPath) {
    console.error("Missing --corpus path");
    process.exit(1);
}

const raw = JSON.parse(
    readFileSync(corpusPath, "utf8"),
) as AnonymisedKitNearnessCorpus;

if (!raw.embeddingModelId || !raw.photos.some((p) => p.embedding?.length)) {
    console.error("Corpus needs CLIP embeddings (v3 export).");
    process.exit(1);
}

for (const threshold of [8, 10, 12, 15, 18]) {
    const result = evaluateSimilarClipNearest(raw, threshold);
    console.log(`threshold ${threshold}`, result);
}
