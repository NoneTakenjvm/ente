import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, Plus } from "lucide-react";
import { TagTypeTabBar } from "@/components/TagTypeTabBar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    ALL_TAG_TYPES_TAB,
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    tagsForTypeView,
} from "@/lib/tag-types";
import { normalizeTagName } from "@/lib/tag-writes";
import { isReservedTag, tagFileCount } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useVisualViewportSheetLayout } from "@/hooks/use-visual-viewport-sheet-layout";
import { useTagStore } from "@/stores/tag-store";

const SWIPE_DISMISS_THRESHOLD_MIN_PX = 50;
const SWIPE_DISMISS_THRESHOLD_RATIO = 0.12;
const SWIPE_DRAG_DEAD_ZONE_PX = 8;
const SWIPE_SNAP_BACK_MS = 200;

interface DismissDragStart {
    x: number;
    y: number;
    fromHeader: boolean;
    dragging: boolean;
}

interface TagPickerSheetProps {
    open: boolean;
    appliedTags: string[];
    knownTags: string[];
    error?: string;
    onOpenChange: (open: boolean) => void;
    onAddTag: (name: string) => void;
    onRemoveTag: (name: string) => void;
}

export function TagPickerSheet({
    open,
    appliedTags,
    knownTags,
    error,
    onOpenChange,
    onAddTag,
    onRemoveTag,
}: TagPickerSheetProps): JSX.Element {
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const ensureTagType = useTagStore((s) => s.ensureTagType);
    const setTagType = useTagStore((s) => s.setTagType);

    const [selectedType, setSelectedType] = useState<string>(DEFAULT_TAG_TYPE);
    const [newTag, setNewTag] = useState<string>("");
    const [newType, setNewType] = useState<string>("");
    const [dragPx, setDragPx] = useState<number>(0);
    const [isDismissDragging, setIsDismissDragging] = useState<boolean>(false);
    const [snapBackAnimating, setSnapBackAnimating] = useState<boolean>(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const sheetRef = useRef<HTMLDivElement>(null);
    const dragStartRef = useRef<DismissDragStart | undefined>(undefined);
    const pointerIdRef = useRef<number | undefined>(undefined);
    const dragPxRef = useRef<number>(0);
    const onOpenChangeRef = useRef(onOpenChange);

    useEffect(() => {
        onOpenChangeRef.current = onOpenChange;
    }, [onOpenChange]);

    const { bottomInset, heightPx, syncLayout } = useVisualViewportSheetLayout(
        open,
        0.75,
    );

    const libraryTags = useMemo(
        (): string[] =>
            tagsForTypeView(
                knownTags.filter((tag) => !isReservedTag(tag)),
                tagTypeByName,
                selectedType,
                fileIdsByTag,
            ),
        [knownTags, tagTypeByName, selectedType, fileIdsByTag],
    );

    const defaultCreateType = useMemo((): string => {
        if (selectedType !== ALL_TAG_TYPES_TAB) {
            return selectedType;
        }
        return DEFAULT_TAG_TYPE;
    }, [selectedType]);

    const isSpecificTypeTab =
        selectedType !== ALL_TAG_TYPES_TAB &&
        selectedType !== DEFAULT_TAG_TYPE;

    useEffect(() => {
        setNewType(isSpecificTypeTab ? selectedType : "");
    }, [isSpecificTypeTab, selectedType]);

    const clearCreateForm = (): void => {
        setNewTag("");
        setNewType(isSpecificTypeTab ? selectedType : "");
    };

    const resetDragState = (): void => {
        setDragPx(0);
        dragPxRef.current = 0;
        setIsDismissDragging(false);
        setSnapBackAnimating(false);
        dragStartRef.current = undefined;
        pointerIdRef.current = undefined;
    };

    const handleOpenChange = (nextOpen: boolean): void => {
        if (!nextOpen) {
            setNewTag("");
            setNewType("");
            setSelectedType(DEFAULT_TAG_TYPE);
            resetDragState();
        }
        onOpenChangeRef.current(nextOpen);
    };

    useEffect(() => {
        if (!open) {
            return;
        }

        const finishDismissDrag = (): void => {
            const sheetHeight = sheetRef.current?.clientHeight ?? 0;
            const threshold = Math.max(
                SWIPE_DISMISS_THRESHOLD_MIN_PX,
                sheetHeight * SWIPE_DISMISS_THRESHOLD_RATIO,
            );
            if (dragPxRef.current > threshold) {
                resetDragState();
                setNewTag("");
                setNewType("");
                setSelectedType(DEFAULT_TAG_TYPE);
                onOpenChangeRef.current(false);
                return;
            }
            setSnapBackAnimating(true);
            setDragPx(0);
            dragPxRef.current = 0;
            window.setTimeout(() => {
                setSnapBackAnimating(false);
            }, SWIPE_SNAP_BACK_MS);
        };

        const onPointerMove = (event: PointerEvent): void => {
            if (
                pointerIdRef.current !== event.pointerId ||
                !dragStartRef.current
            ) {
                return;
            }
            const deltaX = event.clientX - dragStartRef.current.x;
            const deltaY = event.clientY - dragStartRef.current.y;
            if (!dragStartRef.current.dragging) {
                if (
                    deltaY <= SWIPE_DRAG_DEAD_ZONE_PX ||
                    deltaY <= Math.abs(deltaX)
                ) {
                    return;
                }
                if (
                    !dragStartRef.current.fromHeader &&
                    (scrollRef.current?.scrollTop ?? 0) > 0
                ) {
                    return;
                }
                dragStartRef.current.dragging = true;
                setIsDismissDragging(true);
                sheetRef.current?.setPointerCapture(event.pointerId);
            }
            if (event.cancelable) {
                event.preventDefault();
            }
            const nextDrag = Math.max(0, deltaY);
            dragPxRef.current = nextDrag;
            setDragPx(nextDrag);
        };

        const onPointerEnd = (event: PointerEvent): void => {
            if (pointerIdRef.current !== event.pointerId) {
                return;
            }
            const start = dragStartRef.current;
            pointerIdRef.current = undefined;
            dragStartRef.current = undefined;
            setIsDismissDragging(false);
            if (start?.dragging) {
                finishDismissDrag();
            }
            try {
                sheetRef.current?.releasePointerCapture(event.pointerId);
            } catch {
                // Pointer may already be released.
            }
        };

        document.addEventListener("pointermove", onPointerMove, {
            passive: false,
        });
        document.addEventListener("pointerup", onPointerEnd);
        document.addEventListener("pointercancel", onPointerEnd);

        return (): void => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerEnd);
            document.removeEventListener("pointercancel", onPointerEnd);
        };
    }, [open]);

    const handleDismissPointerDown = (
        event: ReactPointerEvent<HTMLElement>,
        fromHeader: boolean,
    ): void => {
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        if (isDismissDragging || snapBackAnimating) {
            return;
        }
        pointerIdRef.current = event.pointerId;
        dragStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            fromHeader,
            dragging: false,
        };
    };

    const submitNewTag = (): void => {
        const name = normalizeTagName(newTag);
        if (!name || isReservedTag(name) || appliedTags.includes(name)) {
            return;
        }
        const type =
            normalizeTagTypeName(newType) ??
            defaultCreateType;
        ensureTagType(type);
        setTagType(name, type);
        onAddTag(name);
        clearCreateForm();
    };

    const handleCreateTag = (event: FormEvent): void => {
        event.preventDefault();
        submitNewTag();
    };

    const handleInputBlur = (): void => {
        requestAnimationFrame(() => {
            syncLayout();
        });
    };

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent
                side="bottom"
                showCloseButton={false}
                className={cn(
                    "flex flex-col gap-0 overflow-hidden rounded-t-xl p-0",
                    (isDismissDragging || dragPx > 0) && "transition-none",
                )}
                style={{
                    bottom: bottomInset,
                    top: "auto",
                    height: heightPx,
                    maxHeight: heightPx,
                }}
            >
                <div
                    ref={sheetRef}
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                    style={{
                        transform:
                            dragPx > 0 ? `translateY(${dragPx}px)` : undefined,
                        transition:
                            snapBackAnimating ?
                                `transform ${SWIPE_SNAP_BACK_MS}ms ease-out` :
                                isDismissDragging ?
                                    "none" :
                                    undefined,
                        touchAction: isDismissDragging ? "none" : undefined,
                    }}
                >
                    <SheetHeader className="shrink-0 gap-2 border-b border-border px-4 pt-3 pb-3">
                        <div
                            className="touch-none"
                            onPointerDown={(event) => {
                                handleDismissPointerDown(event, true);
                            }}
                        >
                            <div
                                className="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30"
                                aria-hidden="true"
                            />
                            <SheetTitle>Tags</SheetTitle>
                        </div>
                        <TagTypeTabBar
                            types={tagTypes}
                            selected={selectedType}
                            onSelect={setSelectedType}
                        />
                    </SheetHeader>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div
                            ref={scrollRef}
                            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
                        >
                            {libraryTags.length === 0 ? (
                                <p className="px-2 py-4 text-sm text-muted-foreground">
                                    No tags in this group yet. Create one below.
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-0.5">
                                    {libraryTags.map((tag) => {
                                        const applied = appliedTags.includes(tag);
                                        const count = tagFileCount(
                                            tag,
                                            fileIdsByTag,
                                        );
                                        return (
                                            <li key={tag}>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    className={cn(
                                                        "h-10 w-full justify-between gap-2 px-3",
                                                        applied && "bg-secondary/80",
                                                    )}
                                                    onClick={() => {
                                                        if (applied) {
                                                            onRemoveTag(tag);
                                                        } else {
                                                            onAddTag(tag);
                                                        }
                                                    }}
                                                >
                                                    <span className="flex min-w-0 items-center gap-2">
                                                        <Check
                                                            className={cn(
                                                                "size-4 shrink-0",
                                                                applied ?
                                                                    "opacity-100" :
                                                                    "opacity-0",
                                                            )}
                                                            aria-hidden={!applied}
                                                        />
                                                        <span className="truncate">
                                                            {tag}
                                                        </span>
                                                    </span>
                                                    <Badge
                                                        variant="secondary"
                                                        className="tabular-nums"
                                                    >
                                                        {count}
                                                    </Badge>
                                                </Button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>

                    <SheetFooter className="shrink-0 gap-3 border-t border-border p-4">
                        <form
                            className="flex w-full flex-col gap-2"
                            onSubmit={handleCreateTag}
                        >
                            <div className="flex w-full items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    disabled={!newTag.trim()}
                                    aria-label="Create tag"
                                    onClick={submitNewTag}
                                >
                                    <Plus />
                                </Button>
                                <Input
                                    placeholder="Create new tag"
                                    value={newTag}
                                    className="min-w-0 flex-1"
                                    onChange={(event) => {
                                        setNewTag(event.target.value);
                                    }}
                                    onBlur={handleInputBlur}
                                />
                                <Input
                                    placeholder="Type (optional)"
                                    value={newType}
                                    className="min-w-0 w-28 shrink-0"
                                    onChange={(event) => {
                                        setNewType(event.target.value);
                                    }}
                                    onBlur={handleInputBlur}
                                />
                            </div>
                        </form>
                        <p className="text-xs text-muted-foreground">
                            Tap a tag to add or remove it. The type field fills
                            from the selected tab when you pick a custom type.
                        </p>
                        {error ? (
                            <Alert variant="destructive" className="py-2">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        ) : null}
                    </SheetFooter>
                </div>
            </SheetContent>
        </Sheet>
    );
}
