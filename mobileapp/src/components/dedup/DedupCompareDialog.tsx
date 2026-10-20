import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type JSX,
    type UIEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useSlideMedia } from "@/hooks/use-slide-media";
import { useThumbnailEntry } from "@/hooks/use-thumbnail-entry";
import type { DedupItemFacts } from "@/lib/dedup-facts";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";
import { Check, Heart, X, ZoomIn, ZoomOut } from "lucide-react";

/** How much larger than the screen the photo is drawn when zoomed in. */
const ZOOM_FACTOR = 3;

interface DedupCompareDialogProps {
    files: EnteFile[];
    /** One entry per file, in the same order. */
    facts: DedupItemFacts[];
    keeperFileId: number;
    onSelectKeeper: (fileId: number) => void;
    onClose: () => void;
}

/**
 * Full-screen compare for close calls. The photos share one frame: tap it (or
 * a tab, or the arrow keys) to flip between them in place, which makes small
 * differences jump out. Zooming keeps the same spot when you flip.
 */
export function DedupCompareDialog({
    files,
    facts,
    keeperFileId,
    onSelectKeeper,
    onClose,
}: DedupCompareDialogProps): JSX.Element {
    const [index, setIndex] = useState<number>(0);
    const [zoomed, setZoomed] = useState<boolean>(false);
    const { mediaByFileId } = useSlideMedia(files, index);
    const frameRef = useRef<HTMLDivElement>(null);
    /** Scroll position as a fraction of the scrollable range, shared by both photos. */
    const scrollFraction = useRef({ x: 0.5, y: 0.5 });

    const file = files[index]!;
    const media = mediaByFileId.get(file.id);
    const thumbnail = useThumbnailEntry(file);
    const url = media?.status === "ready" ? media.url : thumbnail.url;

    const flip = (step: number): void => {
        setIndex((current) => (current + step + files.length) % files.length);
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "ArrowLeft") {
                setIndex((current) => (current - 1 + files.length) % files.length);
            } else if (event.key === "ArrowRight") {
                setIndex((current) => (current + 1) % files.length);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [files.length]);

    // Restore the shared scroll position after a flip or zoom change.
    useLayoutEffect(() => {
        const frame = frameRef.current;
        if (!frame || !zoomed) {
            return;
        }
        frame.scrollLeft =
            scrollFraction.current.x * (frame.scrollWidth - frame.clientWidth);
        frame.scrollTop =
            scrollFraction.current.y * (frame.scrollHeight - frame.clientHeight);
    }, [index, zoomed, url]);

    const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
        const frame = event.currentTarget;
        const rangeX = frame.scrollWidth - frame.clientWidth;
        const rangeY = frame.scrollHeight - frame.clientHeight;
        scrollFraction.current = {
            x: rangeX > 0 ? frame.scrollLeft / rangeX : 0.5,
            y: rangeY > 0 ? frame.scrollTop / rangeY : 0.5,
        };
    };

    const toggleZoom = (): void => {
        scrollFraction.current = { x: 0.5, y: 0.5 };
        setZoomed((current) => !current);
    };

    const isKeeper = file.id === keeperFileId;

    return (
        <Dialog
            open
            onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    onClose();
                }
            }}
        >
            <DialogContent
                showCloseButton={false}
                className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-black p-0 text-white ring-0 sm:max-w-none"
            >
                <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                    <DialogTitle className="text-sm font-medium text-white">
                        Compare · tap the photo to flip
                    </DialogTitle>
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-white hover:bg-white/10 hover:text-white"
                            onClick={toggleZoom}
                        >
                            {zoomed ? <ZoomOut /> : <ZoomIn />}
                            {zoomed ? "Fit" : `${ZOOM_FACTOR}×`}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-white hover:bg-white/10 hover:text-white"
                            onClick={onClose}
                            aria-label="Close"
                        >
                            <X />
                        </Button>
                    </div>
                </div>

                <div
                    ref={frameRef}
                    className={cn(
                        "relative min-h-0 flex-1",
                        zoomed ? "overflow-auto" : "overflow-hidden",
                    )}
                    onScroll={handleScroll}
                >
                    <button
                        type="button"
                        className="block"
                        style={{
                            width: zoomed ? `${ZOOM_FACTOR * 100}%` : "100%",
                            height: zoomed ? `${ZOOM_FACTOR * 100}%` : "100%",
                        }}
                        onClick={() => flip(1)}
                        aria-label="Show the other photo"
                    >
                        {url ? (
                            <img
                                src={url}
                                alt=""
                                className="size-full object-contain"
                                draggable={false}
                            />
                        ) : null}
                    </button>
                    {media?.status === "loading" || !url ? (
                        <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs">
                            <Spinner className="size-3" />
                            {media?.progress === undefined ?
                                "Loading full size" :
                                `Loading full size ${media.progress}%`}
                        </span>
                    ) : null}
                    {media?.status === "error" ? (
                        <span className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-black/60 px-2.5 py-1 text-xs">
                            Couldn&apos;t load full size
                        </span>
                    ) : null}
                </div>

                <div className="flex shrink-0 flex-col gap-3 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                    <div className="flex gap-2">
                        {files.map((tabFile, tabIndex) => (
                            <CompareTab
                                key={tabFile.id}
                                label={String.fromCharCode(65 + tabIndex)}
                                facts={facts[tabIndex]}
                                isActive={tabIndex === index}
                                isKeeper={tabFile.id === keeperFileId}
                                onSelect={() => setIndex(tabIndex)}
                            />
                        ))}
                    </div>
                    <Button
                        type="button"
                        size="lg"
                        variant={isKeeper ? "secondary" : "default"}
                        onClick={() => onSelectKeeper(file.id)}
                        disabled={isKeeper}
                    >
                        {isKeeper ? <Check /> : null}
                        {isKeeper ?
                            "Keeping this one" :
                            `Keep ${String.fromCharCode(65 + index)}`}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function CompareTab({
    label,
    facts,
    isActive,
    isKeeper,
    onSelect,
}: {
    label: string;
    facts: DedupItemFacts | undefined;
    isActive: boolean;
    isKeeper: boolean;
    onSelect: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            className={cn(
                "flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left text-xs",
                isActive ?
                    "border-white bg-white/15" :
                    "border-white/20 text-white/70",
            )}
            onClick={onSelect}
            aria-pressed={isActive}
        >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
                {label}
                {isKeeper ? (
                    <span className="rounded bg-primary px-1.5 text-[0.65rem] font-medium text-primary-foreground">
                        Keep
                    </span>
                ) : null}
                {facts?.isFavorite ? (
                    <Heart className="size-3 fill-current text-rose-400" />
                ) : null}
            </span>
            {facts?.dimensions ? (
                <span className={cn(facts.hasMostPixels && "font-semibold text-white")}>
                    {facts.dimensions}
                    {facts.hasMostPixels ? " ▲" : ""}
                </span>
            ) : null}
            {facts?.size ? (
                <span className={cn(facts.isLargestFile && "font-semibold text-white")}>
                    {facts.size}
                    {facts.isLargestFile ? " ▲" : ""}
                </span>
            ) : null}
            {facts?.quality !== undefined ? (
                <span className={cn(facts.hasBestQuality && "font-semibold text-white")}>
                    Quality {facts.quality}
                    {facts.hasBestQuality ? " ▲" : ""}
                </span>
            ) : null}
        </button>
    );
}
