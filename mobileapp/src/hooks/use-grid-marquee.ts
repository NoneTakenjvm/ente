import {
    useCallback,
    useRef,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
    type RefCallback,
    type RefObject,
} from "react";
import {
    useMarqueeSelection,
    type MarqueeScrollController,
} from "@/hooks/use-marquee-selection";
import type { MarqueeRect } from "@/lib/marquee-selection";

interface GridMarqueeSelection<Id extends number | string> {
    onSelectMany?: (ids: Id[], mode: "add" | "toggle" | "set") => void;
    /** When set, marquee is baseline ∪ live intersection (retract deselects). */
    onSetSelection?: (ids: Id[]) => void;
    disabled?: boolean;
}

interface GridMarqueeOptions<Id extends number | string> {
    /** Ids of the cells under a content-space rectangle. */
    resolveIds: (rect: MarqueeRect) => Id[];
    selection: GridMarqueeSelection<Id> | undefined;
    /** Selection at drag start; read once per pointer-down. */
    getBaselineIds: () => Iterable<Id>;
    scrollControllerRef: RefObject<MarqueeScrollController | null>;
    footerInsetPx: number;
}

interface GridMarquee {
    containerProps: {
        ref: RefCallback<HTMLDivElement>;
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
        onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
    };
    overlayProps: {
        ref: RefObject<HTMLDivElement | null>;
        className: string;
        style: CSSProperties;
    };
}

const OVERLAY_STYLE: CSSProperties = { display: "none" };

/**
 * Drag-to-select for a virtualized grid. Spread `containerProps` on the grid
 * wrapper and render `<div {...overlayProps} />` inside it.
 */
export function useGridMarquee<Id extends number | string>({
    resolveIds,
    selection,
    getBaselineIds,
    scrollControllerRef,
    footerInsetPx,
}: GridMarqueeOptions<Id>): GridMarquee {
    const baselineRef = useRef<Set<Id>>(new Set());
    const appliedIdsRef = useRef<Set<Id>>(new Set());
    const lastIdsRef = useRef<Id[]>([]);

    const handleMarqueeRect = useCallback(
        (rect: MarqueeRect): void => {
            if (!selection?.onSelectMany) {
                return;
            }
            const ids = resolveIds(rect);
            if (sameIds(ids, lastIdsRef.current)) {
                return;
            }
            lastIdsRef.current = ids;
            if (selection.onSetSelection) {
                const next = new Set(baselineRef.current);
                for (const id of ids) {
                    next.add(id);
                }
                selection.onSetSelection([...next]);
                return;
            }
            // Add-only tools (stamp / tag) never retract: can't un-apply tags.
            const fresh: Id[] = [];
            for (const id of ids) {
                if (!appliedIdsRef.current.has(id)) {
                    appliedIdsRef.current.add(id);
                    fresh.push(id);
                }
            }
            if (fresh.length > 0) {
                selection.onSelectMany(fresh, "add");
            }
        },
        [resolveIds, selection],
    );

    const {
        containerRef,
        overlayRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    } = useMarqueeSelection({
        enabled: Boolean(selection?.onSelectMany) && !selection?.disabled,
        scrollControllerRef,
        onMarqueeRect: handleMarqueeRect,
        bottomInsetPx: footerInsetPx,
    });

    const handlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            baselineRef.current = new Set(getBaselineIds());
            appliedIdsRef.current = new Set();
            lastIdsRef.current = [];
            onPointerDown(event);
        },
        [getBaselineIds, onPointerDown],
    );

    return {
        containerProps: {
            ref: containerRef,
            onPointerDown: handlePointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
        },
        overlayProps: {
            ref: overlayRef,
            className:
                "pointer-events-none absolute z-30 border border-primary bg-primary/20",
            style: OVERLAY_STYLE,
        },
    };
}

const sameIds = <Id extends number | string>(a: Id[], b: Id[]): boolean =>
    a.length === b.length && a.every((id, index) => id === b[index]);
