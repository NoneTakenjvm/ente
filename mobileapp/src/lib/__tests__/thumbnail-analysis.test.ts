import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import type { PhashEntry } from "@/lib/crop-match";

const { loadKv } = vi.hoisted(() => ({ loadKv: vi.fn() }));

vi.mock("@/db/kv", () => ({ loadKv, saveKv: vi.fn() }));
vi.mock("@/lib/visibility-outbox", () => ({
    isFileArchivedLocally: (file: EnteFile) => file.id === 5,
}));

import { QUALITY_INDEX_VERSION } from "@/lib/image-quality";
import { hydrateQualityIndex } from "@/lib/quality-index";
import { filesNeedingAnalysis } from "@/lib/similarity-job";

const userId = 7;
const file = (id: number, overrides: Partial<EnteFile> = {}): EnteFile =>
    ({
        id,
        ownerID: userId,
        metadata: { fileType: FileType.image },
        ...overrides,
    }) as EnteFile;

const phashEntry: PhashEntry = { hashes: [], color: "", grid: "" };

describe("filesNeedingAnalysis", () => {
    const files = [
        file(1),
        file(2),
        file(3),
        file(4, { ownerID: 99 }),
        file(5),
        file(6, { metadata: { fileType: FileType.video } } as EnteFile),
    ];

    it("lists eligible files missing either index, and no others", () => {
        const phash = new Map([[1, phashEntry], [2, phashEntry]]);
        const quality = new Map([[1, 0.5], [3, 0.5]]);
        expect(
            filesNeedingAnalysis(files, userId, phash, quality).map(
                (f) => f.id,
            ),
        ).toEqual([2, 3]);
    });

    it("needs nothing once both indexes cover every eligible file", () => {
        const phash = new Map([[1, phashEntry], [2, phashEntry], [3, phashEntry]]);
        const quality = new Map([[1, 0.1], [2, 0.2], [3, 0.3]]);
        expect(filesNeedingAnalysis(files, userId, phash, quality)).toEqual([]);
    });

    it("a stale quality index leaves phash alone", () => {
        const phash = new Map([[1, phashEntry], [2, phashEntry], [3, phashEntry]]);
        expect(
            filesNeedingAnalysis(files, userId, phash, new Map()).map(
                (f) => f.id,
            ),
        ).toEqual([1, 2, 3]);
    });
});

describe("hydrateQualityIndex", () => {
    beforeEach(() => {
        loadKv.mockReset();
    });

    it("keeps scores at the current version", async () => {
        loadKv.mockResolvedValue({
            version: QUALITY_INDEX_VERSION,
            entries: { 1: 0.4, 2: Number.NaN },
        });
        expect([...(await hydrateQualityIndex())]).toEqual([[1, 0.4]]);
    });

    it("discards scores from another version", async () => {
        loadKv.mockResolvedValue({ version: 1, entries: { 1: 0.4 } });
        expect((await hydrateQualityIndex()).size).toBe(0);
    });
});
