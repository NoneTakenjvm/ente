import { describe, expect, it } from "vitest";
import {
    ORGANIZER_CLIP_MLDATA_KEY,
    buildOrganizerClipPayload,
    mergeOrganizerClipIntoRaw,
    parseOrganizerClip,
} from "@/lib/organizer-clip";
import { KIT_EMBEDDING_DIMS, KIT_EMBEDDING_MODEL_ID } from "@/lib/kit-embedding";
import { gunzipToString, gzipString } from "@/lib/gzip";

describe("organizer-clip merge", () => {
    it("preserves face/clip and unknown keys when merging", () => {
        const embedding = Array.from(
            { length: KIT_EMBEDDING_DIMS },
            (_, i) => (i === 0 ? 1 : 0),
        );
        const raw = {
            face: { version: 1 },
            clip: { version: 1, embedding: [0.1] },
            futureThing: { keep: true },
        };
        const merged = mergeOrganizerClipIntoRaw(raw, embedding);
        expect(merged.face).toEqual({ version: 1 });
        expect(merged.clip).toEqual({ version: 1, embedding: [0.1] });
        expect(merged.futureThing).toEqual({ keep: true });
        const ours = merged[ORGANIZER_CLIP_MLDATA_KEY] as {
            modelId: string;
            embedding: number[];
        };
        expect(ours.modelId).toBe(KIT_EMBEDDING_MODEL_ID);
        expect(ours.embedding).toHaveLength(KIT_EMBEDDING_DIMS);
    });

    it("parseOrganizerClip rejects wrong model or dims", () => {
        expect(
            parseOrganizerClip({
                organizer_clip: buildOrganizerClipPayload(
                    Array.from({ length: 3 }, () => 0),
                ),
            }),
        ).toBeUndefined();
        expect(
            parseOrganizerClip({
                organizer_clip: {
                    ...buildOrganizerClipPayload(
                        Array.from({ length: KIT_EMBEDDING_DIMS }, () => 0),
                    ),
                    modelId: "other",
                },
            }),
        ).toBeUndefined();
        const good = Array.from(
            { length: KIT_EMBEDDING_DIMS },
            (_, i) => (i === 0 ? 1 : 0),
        );
        const parsed = parseOrganizerClip({
            organizer_clip: buildOrganizerClipPayload(good),
        });
        expect(parsed?.embedding).toEqual(good);
    });
});

describe("gzip round-trip", () => {
    it("round-trips JSON text", async () => {
        const text = JSON.stringify({ a: 1, b: "hello" });
        const gz = await gzipString(text);
        expect(gz.byteLength).toBeGreaterThan(0);
        expect(await gunzipToString(gz)).toBe(text);
    });
});
