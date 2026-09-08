import { readFileSync } from "node:fs";
import { meanPairwisePrimaryDistance } from "../src/lib/kit-nearness-corpus-eval";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import type { PhashEntry } from "../src/lib/crop-match";

const raw = JSON.parse(
    readFileSync("C:/Users/Elliot/Downloads/kit-nearness-corpus.json", "utf8"),
) as AnonymisedKitNearnessCorpus;

const entries = new Map<number, PhashEntry>();
for (const photo of raw.photos) {
    if (!photo.hashes?.length) {
        continue;
    }
    const entry: PhashEntry = { hashes: photo.hashes };
    if (photo.color) {
        entry.color = photo.color;
    }
    entries.set(photo.id, entry);
}

type Row = { id: string; count: number; mean: number; nTags: number };
const rows: Row[] = [];
for (const kit of raw.derivedKits) {
    if (kit.count < 15 || kit.tags.length < 2) {
        continue;
    }
    const members = raw.photos
        .filter(
            (p) =>
                p.tags.length === kit.tags.length &&
                kit.tags.every((t) => p.tags.includes(t)) &&
                entries.has(p.id),
        )
        .map((p) => p.id);
    if (members.length < 15) {
        continue;
    }
    const mean = meanPairwisePrimaryDistance(members, entries, 40);
    rows.push({
        id: kit.id,
        count: members.length,
        mean,
        nTags: kit.tags.length,
    });
}
rows.sort((a, b) => a.mean - b.mean);
console.log("kits", rows.length);
console.log(
    "best 15:",
    rows.slice(0, 15).map((r) => ({
        id: r.id,
        count: r.count,
        mean: r.mean.toFixed(1),
        nTags: r.nTags,
    })),
);
const pct = (p: number): number | undefined =>
    rows[Math.floor(rows.length * p)]?.mean;
console.log({ p10: pct(0.1), p25: pct(0.25), p50: pct(0.5) });
console.log(
    "worst 5",
    rows.slice(-5).map((r) => ({
        id: r.id,
        mean: r.mean.toFixed(1),
        count: r.count,
    })),
);
