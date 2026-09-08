import { readFileSync } from "node:fs";
import type { AnonymisedKitNearnessCorpus } from "../src/lib/kit-nearness-corpus-export";
import type { PhashEntry } from "../src/lib/crop-match";
import {
    pickKitMedoids,
    kitNearnessDistance,
} from "../src/lib/kit-nearness-sort";

const raw = JSON.parse(
    readFileSync("C:/Users/Elliot/Downloads/kit-nearness-corpus.json", "utf8"),
) as AnonymisedKitNearnessCorpus;

const entries = new Map<number, PhashEntry>();
for (const photo of raw.photos) {
    if (!photo.hashes?.length) {
        continue;
    }
    entries.set(photo.id, {
        hashes: photo.hashes,
        color: photo.color,
    });
}

const thresholds = [8, 10, 12, 14, 16, 18, 20, 22];
for (const thr of thresholds) {
    let kitsWithPos = 0;
    let totalPos = 0;
    for (const kit of raw.derivedKits.slice(0, 40)) {
        const members = raw.photos
            .filter(
                (p) =>
                    p.tags.length === kit.tags.length &&
                    kit.tags.every((t) => p.tags.includes(t)) &&
                    entries.has(p.id),
            )
            .map((p) => p.id);
        if (members.length < 20) {
            continue;
        }
        const seeds = members.slice(0, Math.floor(members.length * 0.6));
        const hold = members.slice(Math.floor(members.length * 0.6));
        const medoids = pickKitMedoids(seeds, entries);
        let pos = 0;
        for (const id of hold) {
            const d = kitNearnessDistance(id, medoids, entries, 0, 0, 0);
            if (d <= thr) {
                pos += 1;
            }
        }
        if (pos >= 3) {
            kitsWithPos += 1;
            totalPos += pos;
        }
    }
    console.log(
        `thr=${thr}: kitsWith≥3 visualPos=${kitsWithPos} totalPos=${totalPos}`,
    );
}
