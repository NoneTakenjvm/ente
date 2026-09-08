/**
 * One-shot: add derivedKits to an existing anonymised corpus JSON on disk.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/patch-corpus-derived-kits.ts [path]
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    deriveExactTagSetKits,
    KIT_NEARNESS_CORPUS_PRIVACY_NOTICE,
    KIT_NEARNESS_CORPUS_VERSION,
    serializeAnonymisedKitNearnessCorpus,
    type AnonymisedCorpusKit,
    type AnonymisedCorpusPhoto,
} from "../src/lib/kit-nearness-corpus-export";

const path =
    process.argv[2] ??
    "C:/Users/Elliot/Downloads/kit-nearness-corpus.json";

const raw = JSON.parse(readFileSync(path, "utf8")) as {
    photos: AnonymisedCorpusPhoto[];
    kits: AnonymisedCorpusKit[];
};

const corpus = {
    version: KIT_NEARNESS_CORPUS_VERSION,
    privacyNotice: KIT_NEARNESS_CORPUS_PRIVACY_NOTICE,
    photos: raw.photos,
    kits: raw.kits ?? [],
    derivedKits: deriveExactTagSetKits(raw.photos),
};

writeFileSync(path, serializeAnonymisedKitNearnessCorpus(corpus));
console.log(
    JSON.stringify(
        {
            path,
            version: corpus.version,
            photos: corpus.photos.length,
            kits: corpus.kits.length,
            derivedKits: corpus.derivedKits.length,
            top5: corpus.derivedKits.slice(0, 5).map((k) => ({
                id: k.id,
                count: k.count,
                nTags: k.tags.length,
            })),
        },
        null,
        2,
    ),
);
