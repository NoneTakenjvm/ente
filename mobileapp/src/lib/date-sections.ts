import type { EnteFile } from "ente-media/file";

/** A run of consecutive files shown under one header. */
export interface GridSection {
    label: string;
    /** Index of the section's first file. */
    start: number;
    count: number;
}

/** A local calendar day as epoch milliseconds; `end` is exclusive. */
interface LocalDay {
    start: number;
    end: number;
}

/**
 * Group consecutive files that share a local calendar day. A new section
 * starts whenever the day changes from the previous file, so input that is
 * not strictly date-ordered gives repeated headers rather than merged days.
 *
 * [Note: `timeOf` returns epoch microseconds, as Ente file times do.]
 *
 * @param now epoch milliseconds that "Today" and "Yesterday" are measured from
 */
export const groupFilesByDay = (
    files: readonly EnteFile[],
    timeOf: (file: EnteFile) => number,
    now: number = Date.now(),
): GridSection[] => {
    const sections: GridSection[] = [];
    let day: LocalDay | undefined;
    for (let index = 0; index < files.length; index += 1) {
        const millis = timeOf(files[index]!) / 1000;
        // Only build a Date when a file leaves the current day's bounds.
        if (!day || millis < day.start || millis >= day.end) {
            day = localDay(millis);
            sections.push({ label: dayLabel(day, now), start: index, count: 0 });
        }
        sections[sections.length - 1]!.count += 1;
    }
    return sections;
};

/** The local calendar day containing {@link millis}. */
const localDay = (millis: number): LocalDay => {
    const date = new Date(millis);
    const year = date.getFullYear();
    const month = date.getMonth();
    const dayOfMonth = date.getDate();
    return {
        start: new Date(year, month, dayOfMonth).getTime(),
        end: new Date(year, month, dayOfMonth + 1).getTime(),
    };
};

/** "Today", "Yesterday", or a short date naming the year only outside the current one. */
const dayLabel = (day: LocalDay, now: number): string => {
    const today = localDay(now);
    if (day.start === today.start) {
        return "Today";
    }
    if (day.start === localDay(today.start - 1).start) {
        return "Yesterday";
    }
    const date = new Date(day.start);
    return date.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year:
            date.getFullYear() === new Date(now).getFullYear() ?
                undefined :
                "numeric",
    });
};
