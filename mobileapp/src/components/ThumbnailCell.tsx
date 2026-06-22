import {
    memo,
    useEffect,
    useRef,
    useSyncExternalStore,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
    getThumbnailEntry,
    requestThumbnail,
    subscribeThumbnail,
} from "@/lib/thumbnail-cache";
import { Check, CircleCheck, Play } from "lucide-react";
import { FileType } from "ente-media/file-type";
import type { EnteFile } from "ente-media/file";

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 10;

interface ThumbnailCellProps {
    file: EnteFile;
    size: number;
    onOpen?: (file: EnteFile) => void;
    isSelected?: boolean;
    onToggleSelect?: (file: EnteFile) => void;
    isAlreadyCompressed?: boolean;
    disabled?: boolean;
    /** When true, tap toggles selection instead of opening. */
    tapSelects?: boolean;
}

export const ThumbnailCell = memo(function ThumbnailCell({
    file,
    size,
    onOpen,
    isSelected = false,
    onToggleSelect,
    isAlreadyCompressed = false,
    disabled = false,
    tapSelects = false,
}: ThumbnailCellProps): JSX.Element {
    const entry = useSyncExternalStore(
        (listener) => subscribeThumbnail(file.id, listener),
        () => getThumbnailEntry(file.id),
        () => getThumbnailEntry(file.id),
    );

    const pressTimerRef = useRef<number | undefined>(undefined);
    const pressStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
    const longPressTriggeredRef = useRef<boolean>(false);

    useEffect(() => {
        if (entry.status === "idle") {
            requestThumbnail(file);
        }
    }, [entry.status, file]);

    useEffect(() => {
        return (): void => {
            if (pressTimerRef.current !== undefined) {
                window.clearTimeout(pressTimerRef.current);
            }
        };
    }, []);

    const clearPress = (): void => {
        if (pressTimerRef.current !== undefined) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = undefined;
        }
        pressStartRef.current = undefined;
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        if (disabled) {
            return;
        }
        longPressTriggeredRef.current = false;
        pressStartRef.current = { x: event.clientX, y: event.clientY };
        if (!tapSelects && onOpen) {
            pressTimerRef.current = window.setTimeout(() => {
                pressTimerRef.current = undefined;
                longPressTriggeredRef.current = true;
                onOpen(file);
            }, LONG_PRESS_MS);
        }
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        const start = pressStartRef.current;
        if (!start || pressTimerRef.current === undefined) {
            return;
        }
        if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) >
            LONG_PRESS_MOVE_PX
        ) {
            clearPress();
        }
    };

    const handleClick = (): void => {
        if (disabled) {
            return;
        }
        if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            clearPress();
            return;
        }
        clearPress();
        if (tapSelects && onToggleSelect) {
            onToggleSelect(file);
            return;
        }
        onOpen?.(file);
    };

    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-md bg-muted",
                disabled && "pointer-events-none opacity-50",
            )}
            style={{ width: size, height: size }}
        >
            <button
                type="button"
                className={cn(
                    "size-full",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onClick={handleClick}
                disabled={disabled}
                aria-label={
                    tapSelects ?
                        isSelected ?
                            `Deselect media ${file.id}` :
                            `Select media ${file.id}` :
                        `Open media ${file.id}`
                }
                aria-pressed={tapSelects ? isSelected : undefined}
            >
                {file.metadata.fileType === FileType.video && !tapSelects ? (
                    <span className="absolute bottom-1 right-1 z-10 rounded-full bg-black/60 p-1 text-white">
                        <Play className="size-3 fill-current" aria-hidden />
                    </span>
                ) : null}
                {entry.status === "ready" && entry.url ? (
                    <img
                        className="pointer-events-none size-full object-cover"
                        src={entry.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                    />
                ) : entry.status === "error" ? (
                    <span
                        className="flex size-full items-center justify-center text-sm text-destructive"
                        aria-hidden
                    >
                        !
                    </span>
                ) : (
                    <Skeleton className="size-full rounded-none" aria-hidden />
                )}
            </button>
            {isAlreadyCompressed ? (
                <span
                    className="absolute top-1.5 left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-green-600 text-white"
                    aria-hidden
                >
                    <CircleCheck className="size-3.5" strokeWidth={2.5} />
                </span>
            ) : null}
            {tapSelects && isSelected ? (
                <>
                    <span
                        className="pointer-events-none absolute inset-0 z-[1] bg-primary/30"
                        aria-hidden
                    />
                    <span
                        className="pointer-events-none absolute right-1.5 bottom-1.5 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"
                        aria-hidden
                    >
                        <Check className="size-4" strokeWidth={3} />
                    </span>
                </>
            ) : null}
        </div>
    );
});
