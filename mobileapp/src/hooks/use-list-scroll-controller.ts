import { useEffect, useRef, type RefObject } from "react";
import type { FixedSizeList, ListOnScrollProps } from "react-window";
import { noteGalleryScrollActivity } from "@/lib/gallery-scroll-activity";
import type { MarqueeScrollController } from "@/hooks/use-marquee-selection";

/**
 * Publishes a {@link MarqueeScrollController} for a react-window list so
 * marquee edge-scroll can drive it. Pass `outerRef` and `onScroll` to the list.
 */
export function useListScrollController<RowData>(
    listRef: RefObject<FixedSizeList<RowData> | null>,
    scrollControllerRef: RefObject<MarqueeScrollController | null>,
): {
    outerRef: RefObject<HTMLDivElement | null>;
    onScroll: (props: ListOnScrollProps) => void;
} {
    const scrollOffsetRef = useRef(0);
    const outerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollControllerRef.current = {
            getScrollTop: (): number => scrollOffsetRef.current,
            setScrollTop: (next: number): void => {
                const outer = outerRef.current;
                const maxScroll =
                    outer ? Math.max(0, outer.scrollHeight - outer.clientHeight) : 0;
                const clamped = Math.min(Math.max(0, next), maxScroll);
                if (clamped === scrollOffsetRef.current) {
                    return;
                }
                noteGalleryScrollActivity();
                scrollOffsetRef.current = clamped;
                listRef.current?.scrollTo(clamped);
            },
        };
        return (): void => {
            scrollControllerRef.current = null;
        };
    }, [listRef, scrollControllerRef]);

    return {
        outerRef,
        onScroll: (props: ListOnScrollProps): void => {
            noteGalleryScrollActivity();
            scrollOffsetRef.current = props.scrollOffset;
        },
    };
}
