import { describe, expect, it } from "vitest";
import { groupFilesByDay, type GridSection } from "@/lib/date-sections";
import { bareFile } from "@/test-utils/fixtures";

/** Epoch microseconds, as Ente file times are, for a local date and hour. */
const localMicros = (
    year: number,
    month: number,
    day: number,
    hour = 12,
): number => new Date(year, month, day, hour).getTime() * 1000;

/** Groups one bare file per time; file `n` has `times[n - 1]`. */
const groupTimes = (times: number[], now?: number): GridSection[] => {
    const files = times.map((_, index) => bareFile(index + 1));
    return groupFilesByDay(files, (file) => times[file.id - 1]!, now);
};

const now = new Date(2026, 10, 21, 15).getTime();

describe("groupFilesByDay", () => {
    it("starts a new section when the local day changes", () => {
        const sections = groupTimes(
            [
                localMicros(2026, 10, 10),
                localMicros(2026, 10, 10, 20),
                localMicros(2026, 10, 11),
            ],
            now,
        );
        expect(sections.map(({ start, count }) => ({ start, count }))).toEqual([
            { start: 0, count: 2 },
            { start: 2, count: 1 },
        ]);
    });

    it("labels today and yesterday, reading times as microseconds", () => {
        const sections = groupTimes(
            [
                localMicros(2026, 10, 21, 9),
                localMicros(2026, 10, 20, 23),
                localMicros(2026, 10, 19),
            ],
            now,
        );
        expect(sections).toHaveLength(3);
        expect(sections.slice(0, 2).map((section) => section.label)).toEqual([
            "Today",
            "Yesterday",
        ]);
    });

    it("repeats the header when input is out of day order", () => {
        const sections = groupTimes(
            [
                localMicros(2026, 10, 10),
                localMicros(2026, 10, 11),
                localMicros(2026, 10, 10),
            ],
            now,
        );
        expect(sections.map((section) => section.start)).toEqual([0, 1, 2]);
    });

    it("names the year only when it is not the current year", () => {
        const [lastYear] = groupTimes([localMicros(2025, 5, 3)], now);
        const [thisYear] = groupTimes([localMicros(2026, 5, 3)], now);
        expect(lastYear.label).toContain("2025");
        expect(thisYear.label).not.toContain("2026");
    });

    it("returns no sections for no files", () => {
        expect(groupTimes([], now)).toEqual([]);
    });
});
