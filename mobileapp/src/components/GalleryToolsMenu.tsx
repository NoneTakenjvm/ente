import { useCallback, useState, type JSX } from "react";
import {
    Check,
    ListFilter,
    RotateCw,
    Stamp,
    Wrench,
} from "lucide-react";
import {
    TagQueryBuilderContent,
    type TagQueryBuilderContentProps,
} from "@/components/TagQueryBuilderContent";
import { TagQueryBuilderPanel } from "@/components/TagQueryBuilderPanel";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDiscardPendingRotations } from "@/lib/rotate-draft";
import { cn } from "@/lib/utils";
import { stampTagsFromNearnessFilter } from "@/lib/tag-presets";
import { isTagFilterActive } from "@/lib/tags";
import { useSelectionStore } from "@/stores/selection-store";
import type { TagFilterTarget } from "@/stores/tag-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useUIStore } from "@/stores/ui-store";

type GalleryToolsMenuProps = {
    filterTarget?: TagFilterTarget;
    /** When set, include Query builder (gallery filter bar). */
    query?: TagQueryBuilderContentProps & { hasQueryContent: boolean };
};

/**
 * Gallery/album tools: wrench dropdown below `md`, individual icon buttons at `md+`.
 * Mobile: re-tap wrench exits the active tool; opens the menu only when none is active.
 */
export function GalleryToolsMenu({
    query,
    filterTarget = "gallery",
}: GalleryToolsMenuProps): JSX.Element {
    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const setEnabled = useSelectionStore((s) => s.setEnabled);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);
    const setRotateActive = useSelectionStore((s) => s.setRotateActive);

    const [menuOpen, setMenuOpen] = useState(false);

    const anyToolActive = selectionEnabled || stampActive || rotateActive;
    const triggerActive = anyToolActive || Boolean(query?.hasQueryContent);

    /** Exit rotate after confirming discard when drafts exist. */
    const exitRotate = useCallback((): boolean => {
        const pending = useSelectionStore.getState().pendingRotations;
        if (!confirmDiscardPendingRotations(pending)) {
            return false;
        }
        setRotateActive(false);
        return true;
    }, [setRotateActive]);

    /** Exit whichever tool is active (wrench re-tap). */
    const exitActiveTool = useCallback((): void => {
        if (rotateActive) {
            exitRotate();
            return;
        }
        if (stampActive) {
            setStampActive(false);
            return;
        }
        if (selectionEnabled) {
            setEnabled(false);
        }
    }, [
        exitRotate,
        rotateActive,
        selectionEnabled,
        setEnabled,
        setStampActive,
        stampActive,
    ]);

    const activateStamp = (): void => {
        if (stampActive) {
            setStampActive(false);
            return;
        }
        const nearnessFilter = useUIStore.getState().nearnessFilter;
        if (
            nearnessFilter !== undefined &&
            isTagFilterActive(nearnessFilter)
        ) {
            const from = stampTagsFromNearnessFilter(
                nearnessFilter,
                useTagSpeedStore.getState().presets,
            );
            if (from) {
                setStampPickMode(from.pickMode);
                setStampTags(from.tags);
                setStampSheetOpen(false);
            }
        }
        setStampActive(true);
    };

    const toggleRotate = (): void => {
        if (rotateActive) {
            exitRotate();
            return;
        }
        setRotateActive(true);
    };

    return (
        <>
            <div className="md:hidden">
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={(open) => {
                        if (open && anyToolActive) {
                            exitActiveTool();
                            return;
                        }
                        setMenuOpen(open);
                    }}
                >
                    <DropdownMenuTrigger
                        render={
                            <Button
                                type="button"
                                variant={triggerActive ? "secondary" : "outline"}
                                size="icon-sm"
                                aria-label={
                                    anyToolActive ?
                                        "Exit active tool" :
                                        "Gallery tools"
                                }
                                aria-pressed={anyToolActive}
                                title={
                                    anyToolActive ?
                                        "Exit tool" :
                                        "Tools — select, stamp, rotate, query"
                                }
                            >
                                <Wrench />
                            </Button>
                        }
                    />
                    <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuGroup>
                            <DropdownMenuLabel>Tools</DropdownMenuLabel>
                            {query ? (
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger
                                        className={cn(
                                            query.hasQueryContent &&
                                                "font-medium",
                                        )}
                                    >
                                        <ListFilter />
                                        Query builder
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent
                                        className="flex max-h-[min(80dvh,28rem)] w-[min(100vw-2rem,24rem)] flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-2"
                                        side="bottom"
                                        align="end"
                                    >
                                        <DropdownMenuLabel className="shrink-0 px-0">
                                            Query builder
                                        </DropdownMenuLabel>
                                        <TagQueryBuilderContent
                                            filterTarget={filterTarget}
                                            taggedCount={query.taggedCount}
                                            untaggedCount={query.untaggedCount}
                                            favoritesCount={
                                                query.favoritesCount
                                            }
                                            notFavoritesCount={
                                                query.notFavoritesCount
                                            }
                                            photoCount={query.photoCount}
                                            videoCount={query.videoCount}
                                            croppedCount={query.croppedCount}
                                            notCroppedCount={
                                                query.notCroppedCount
                                            }
                                        />
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            ) : null}
                            {query ? <DropdownMenuSeparator /> : null}
                            <DropdownMenuItem
                                onClick={() => {
                                    setEnabled(!selectionEnabled);
                                }}
                            >
                                <Check />
                                Select
                                {selectionEnabled ? (
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        On
                                    </span>
                                ) : null}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => {
                                    activateStamp();
                                }}
                            >
                                <Stamp />
                                Stamp
                                {stampActive ? (
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        On
                                    </span>
                                ) : null}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => {
                                    toggleRotate();
                                }}
                            >
                                <RotateCw />
                                Rotate
                                {rotateActive ? (
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        On
                                    </span>
                                ) : null}
                            </DropdownMenuItem>
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <div className="hidden items-center gap-1 md:flex">
                {query ? (
                    <TagQueryBuilderPanel
                        filterTarget={filterTarget}
                        hasQueryContent={query.hasQueryContent}
                        taggedCount={query.taggedCount}
                        untaggedCount={query.untaggedCount}
                        favoritesCount={query.favoritesCount}
                        notFavoritesCount={query.notFavoritesCount}
                        photoCount={query.photoCount}
                        videoCount={query.videoCount}
                        croppedCount={query.croppedCount}
                        notCroppedCount={query.notCroppedCount}
                    />
                ) : null}
                <Button
                    type="button"
                    variant={selectionEnabled ? "secondary" : "outline"}
                    size="icon-sm"
                    aria-label={
                        selectionEnabled ?
                            "Exit selection mode" :
                            "Select media"
                    }
                    aria-pressed={selectionEnabled}
                    onClick={() => {
                        setEnabled(!selectionEnabled);
                    }}
                >
                    <Check />
                </Button>
                <Button
                    type="button"
                    variant={stampActive ? "secondary" : "outline"}
                    size="icon-sm"
                    aria-label={
                        stampActive ?
                            "Exit stamp tool" :
                            "Stamp tags onto photos"
                    }
                    aria-pressed={stampActive}
                    title={
                        stampActive ?
                            "Exit stamp" :
                            "Stamp — pick tags, tap photos"
                    }
                    onClick={activateStamp}
                >
                    <Stamp />
                </Button>
                <Button
                    type="button"
                    variant={rotateActive ? "secondary" : "outline"}
                    size="icon-sm"
                    aria-label={
                        rotateActive ?
                            "Exit rotate tool" :
                            "Quick rotate photos"
                    }
                    aria-pressed={rotateActive}
                    title={
                        rotateActive ?
                            "Exit rotate" :
                            "Rotate — tap photos +90°, then Apply"
                    }
                    onClick={toggleRotate}
                >
                    <RotateCw />
                </Button>
            </div>
        </>
    );
}
