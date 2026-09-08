import { describe, expect, it } from "vitest";
import {
    draftAddTag,
    draftAddTags,
    draftRemoveTag,
    emptyTagDraft,
    normalizeTagNameList,
    overlayTagDraftPresence,
    pruneTagDraft,
    pushRecentTags,
    tagDraftHasChanges,
    tagPresenceAcrossFiles,
} from "@/lib/tag-bulk";
import {
    countFilesMatchingKit,
    countFilesMatchingKitExact,
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

    it("countFilesMatchingKitExact uses ONLY tag-set semantics", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people"]),
            stubFile(3, ["people", "vietnam", "travel"]),
        ];
        expect(countFilesMatchingKit(files, ["people", "vietnam"])).toBe(2);
        expect(countFilesMatchingKitExact(files, ["people", "vietnam"])).toBe(
            1,
        );
        const sortedExact = sortPresetsByMatchCount(
            [
                { id: "1", name: "Full", tags: ["people", "vietnam"] },
                { id: "2", name: "People", tags: ["people"] },
                { id: "3", name: "Rare", tags: ["travel", "selfie"] },
            ],
            files,
            { exact: true },
        );
        expect(sortedExact.map((preset) => preset.id)).toEqual([
            "1",
            "2",
            "3",
        ]);
    });

    it("suggestTagKits ranks exact tag sets only, not pairs", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people", "vietnam", "travel"]),
            stubFile(3, ["people", "vietnam"]),
            stubFile(4, ["solo"]),
        ];
        // File 2's extra tag makes a different exact set — it must not inflate
        // the people+vietnam pair count.
        const frequent = suggestTagKits(files, {
            minCount: 2,
            existingPresets: [],
        });
        expect(frequent.map((s) => s.name)).toEqual(["people + vietnam"]);
        expect(frequent[0]!.count).toBe(2);

        const withSingles = suggestTagKits(files, {
            minCount: 1,
            existingPresets: [
                { id: "x", name: "Skip", tags: ["people", "vietnam"] },
            ],
        });
        expect(withSingles.map((s) => s.name)).toEqual([
            "people + travel + vietnam",
        ]);
        expect(withSingles[0]!.count).toBe(1);
    });

    it("suggestTagKits skips sets with tags not in kit nearness", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people", "vietnam"]),
            stubFile(3, ["people", "travel"]),
            stubFile(4, ["people", "travel"]),
        ];
        const allowlist = new Map([
            ["people", true],
            ["vietnam", true],
        ]);
        const suggestions = suggestTagKits(files, {
            minCount: 2,
            includeInKitNearnessByName: allowlist,
        });
        expect(suggestions.map((s) => s.name)).toEqual(["people + vietnam"]);
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

    it("draft add/remove cancels opposing pending edits", () => {
        let draft = emptyTagDraft();
        draft = draftAddTag(draft, "people");
        expect(draft).toEqual({ adds: ["people"], removes: [] });
        draft = draftRemoveTag(draft, "people");
        expect(draft).toEqual({ adds: [], removes: ["people"] });
        draft = draftAddTags(draft, ["vietnam", "people"]);
        expect(draft.adds).toEqual(["vietnam", "people"]);
        expect(draft.removes).toEqual([]);
        expect(tagDraftHasChanges(draft)).toBe(true);
        expect(tagDraftHasChanges(emptyTagDraft())).toBe(false);
    });

    it("overlayTagDraftPresence reflects staged adds and removes", () => {
        const files = [
            stubFile(1, ["people", "vietnam"]),
            stubFile(2, ["people"]),
        ];
        const baseline = tagPresenceAcrossFiles(files);
        const draft = draftRemoveTag(
            draftAddTag(emptyTagDraft(), "travel"),
            "people",
        );
        const overlay = overlayTagDraftPresence(baseline, draft, 2);
        expect(overlay.presence.get("people")).toEqual({ count: 0, total: 2 });
        expect(overlay.presence.get("travel")).toEqual({ count: 2, total: 2 });
        expect(overlay.appliedTags).toContain("travel");
        expect(overlay.appliedTags).not.toContain("people");
        expect(overlay.unionTags).toContain("travel");
    });

    it("pruneTagDraft drops no-op toggles against baseline", () => {
        const files = [
            stubFile(1, ["people"]),
            stubFile(2, ["people"]),
        ];
        const { presence } = tagPresenceAcrossFiles(files);
        const toggledOffThenOn = pruneTagDraft(
            draftAddTag(draftRemoveTag(emptyTagDraft(), "people"), "people"),
            presence,
        );
        expect(tagDraftHasChanges(toggledOffThenOn)).toBe(false);

        const toggledOnThenOff = pruneTagDraft(
            draftRemoveTag(draftAddTag(emptyTagDraft(), "travel"), "travel"),
            presence,
        );
        expect(tagDraftHasChanges(toggledOnThenOff)).toBe(false);

        const realAdd = pruneTagDraft(
            draftAddTag(emptyTagDraft(), "travel"),
            presence,
        );
        expect(realAdd.adds).toEqual(["travel"]);
    });
});
