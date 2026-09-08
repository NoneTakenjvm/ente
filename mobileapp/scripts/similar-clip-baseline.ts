/**
 * Quick Similar CLIP knob baseline on a private corpus JSON.
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/similar-clip-baseline.ts \
 *     --corpus C:/Users/Elliot/Downloads/kit-nearness-corpus.json
 */
import { readFileSync } from "node:fs";
import { evaluateSimilarClipKnobs } from "@/lib/similarity-clip-eval";
import { DEFAULT_SIMILAR_CLIP_KNOBS } from "@/lib/similarity-clip";
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

const baseline = evaluateSimilarClipKnobs(raw, DEFAULT_SIMILAR_CLIP_KNOBS);
console.log("default knobs", DEFAULT_SIMILAR_CLIP_KNOBS);
console.log(baseline);

const gates = [0.25, 0.3, 0.35, 0.4, 0.45];
const rescues = [0.08, 0.1, 0.12, 0.15];
let best = { ...DEFAULT_SIMILAR_CLIP_KNOBS, ...baseline };

for (const gate of gates) {
    for (const rescue of rescues) {
        const knobs = {
            ...DEFAULT_SIMILAR_CLIP_KNOBS,
            gate,
            rescue,
        };
        const result = evaluateSimilarClipKnobs(raw, knobs);
        if (result.fitness > best.fitness) {
            best = { ...knobs, ...result };
        }
    }
}

console.log("best grid", best);
