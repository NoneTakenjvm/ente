import { describe, expect, it } from "vitest";
import {
    normalizeTagNameList,
    pushRecentTags,
    tagPresenceAcrossFiles,
} from "@/lib/tag-bulk";
import {
    countFilesMatchingKit,
    formatKitSuggestionName,
    newTagPresetId,
    normalizePresetTags,
    presetsFromPersisted,
    sortPresetsByMatchCount,
    suggestTagKits,
} from "@/lib/tag-presets";
import { fileWithOrganizerTags } from "@/lib/tag-writes";
import type { EnteFile } from "ente-media/file";

const stubFile = (id: number, tags: string[]): EnteFile =>
    fileWithOrganizerTags({ id } as EnteFile, tags);

describe("tag-presets", () => {
    it("presetsFromPersisted drops invalid entries", () => {
        expect(
            presetsFromPersisted([
                { id: "a", name: "Trip", tags: ["vietnam", "travel"] },
                { id: "", name: "Bad", tags: ["x"] },
                { id: "b", name: "  ", tags: ["x"] },
                { id: "c", name: "Empty", tags: [] },
            ]),
        ).toEqual([
            { id: "a", name: "Trip", tags: ["vietnam", "travel"] },
        ]);
    });

    it("normalizePresetTags dedupes", () => {
        expect(normalizePresetTags([" a ", "a", "b"])).toEqual(["a", "b"]);
    });

    it("newTagPresetId returns unique ids", () => {
        expect(newTagPresetId()).not.toBe(newTagPresetId());
    });

    it("sortPresetsByMatchCount ranks by full kit matches", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people"]),
            stubFile(3, ["people", "vietnam", "travel"]),
        ];
        const sorted = sortPresetsByMatchCount(
            [
                { id: "1", name: "Full", tags: ["people", "vietnam"] },
                { id: "2", name: "People", tags: ["people"] },
                { id: "3", name: "Rare", tags: ["travel", "selfie"] },
            ],
            files,
        );
        expect(sorted.map((preset) => preset.id)).toEqual(["2", "1", "3"]);
        expect(countFilesMatchingKit(files, ["people", "vietnam"])).toBe(2);
    });

    it("suggestTagKits ranks common pairs and skips existing presets", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people", "vietnam", "travel"]),
            stubFile(3, ["people", "vietnam"]),
            stubFile(4, ["solo"]),
        ];
        const suggestions = suggestTagKits(files, {
            minCount: 1,
            existingPresets: [
                { id: "x", name: "Skip", tags: ["people", "vietnam"] },
            ],
        });
        expect(suggestions.map((s) => s.name)).toEqual([
            "people + travel",
            "travel + vietnam",
            "people + travel + vietnam",
        ]);
        expect(suggestions[0]!.count).toBe(1);
        const frequent = suggestTagKits(files, {
            minCount: 2,
            existingPresets: [],
        });
        expect(frequent.map((s) => s.name)).toEqual(["people + vietnam"]);
        expect(frequent[0]!.count).toBe(3);
    });

    it("formatKitSuggestionName sorts tags", () => {
        expect(formatKitSuggestionName(["vietnam", "beach"])).toBe(
            "beach + vietnam",
        );
    });
});

describe("tag-bulk", () => {
    it("tagPresenceAcrossFiles reports partial counts", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people"]),
            stubFile(3, []),
        ];
        const { unionTags, presence } = tagPresenceAcrossFiles(files);
        expect(unionTags).toEqual(["people", "vietnam"]);
        expect(presence.get("people")).toEqual({ count: 2, total: 3 });
        expect(presence.get("vietnam")).toEqual({ count: 1, total: 3 });
    });

    it("pushRecentTags keeps MRU order and cap", () => {
        // Last tag in the batch becomes most recent (applied end-first).
        expect(pushRecentTags(["a", "b"], ["c", "a"], 3)).toEqual([
            "c",
            "a",
            "b",
        ]);
        expect(normalizeTagNameList(["x", "x", "y"], 1)).toEqual(["x"]);
    });
});
