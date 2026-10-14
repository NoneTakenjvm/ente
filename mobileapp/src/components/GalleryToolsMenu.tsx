import { useCallback, useState, type JSX, type ReactNode } from "react";
import {
    Check,
    Crop,
    ListFilter,
    RotateCw,
    Stamp,
    Wrench,
} from "lucide-react";
import {
    TagQueryBuilderContent,
    type TagQueryBuilderContentProps,
} from "@/components/TagQueryBuilderContent";
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
import { confirmDiscardPendingCrops } from "@/lib/crop-draft";
import { confirmDiscardPendingRotations } from "@/lib/rotate-draft";
import { cn } from "@/lib/utils";
import { stampTagsFromNearnessFilter } from "@/lib/tag-presets";
import { isTagFilterActive } from "@/lib/tag-filter";
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
    const selectionMode = useSelectionStore((s) => s.mode);
    const setMode = useSelectionStore((s) => s.setMode);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const [menuOpen, setMenuOpen] = useState(false);

    const selectionEnabled = selectionMode === "select";
    const stampActive = selectionMode === "stamp";
    const rotateActive = selectionMode === "rotate";
    const cropActive = selectionMode === "crop";
    const anyToolActive = selectionMode !== "none";
    const triggerActive = anyToolActive || Boolean(query?.hasQueryContent);

    /** Exit rotate after confirming discard when drafts exist. */
    const exitRotate = useCallback((): boolean => {
        const pending = useSelectionStore.getState().pendingRotations;
        if (!confirmDiscardPendingRotations(pending)) {
            return false;
        }
        setMode("none");
        return true;
    }, [setMode]);

    /** Exit crop after confirming discard when drafts exist. */
    const exitCrop = useCallback((): boolean => {
        const pending = useSelectionStore.getState().pendingCrops;
        if (!confirmDiscardPendingCrops(pending)) {
            return false;
        }
        setMode("none");
        return true;
    }, [setMode]);

    /** Exit whichever tool is active (wrench re-tap). */
    const exitActiveTool = useCallback((): void => {
        if (rotateActive) {
            exitRotate();
            return;
        }
        if (cropActive) {
            exitCrop();
            return;
        }
        setMode("none");
    }, [cropActive, exitCrop, exitRotate, rotateActive, setMode]);

    const activateStamp = (): void => {
        if (stampActive) {
            setMode("none");
            return;
        }
        const ordering = useUIStore.getState().ordering;
        if (
            ordering?.kind === "nearness" &&
            isTagFilterActive(ordering.filter)
        ) {
            const from = stampTagsFromNearnessFilter(
                ordering.filter,
                useTagSpeedStore.getState().presets,
            );
            if (from) {
                setStampPickMode(from.pickMode);
                setStampTags(from.tags);
                setStampSheetOpen(false);
            }
        }
        setMode("stamp");
    };

    const toggleRotate = (): void => {
        if (rotateActive) {
            exitRotate();
            return;
        }
        setMode("rotate");
    };

    const toggleCrop = (): void => {
        if (cropActive) {
            exitCrop();
            return;
        }
        setMode("crop");
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
                                        "Tools — select, stamp, rotate, crop, query"
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
                                            {...query}
                                            filterTarget={filterTarget}
                                        />
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            ) : null}
                            {query ? <DropdownMenuSeparator /> : null}
                            <ToolMenuItem
                                label="Select"
                                active={selectionEnabled}
                                onSelect={() => {
                                    setMode(selectionEnabled ? "none" : "select");
                                }}
                            >
                                <Check />
                            </ToolMenuItem>
                            <ToolMenuItem
                                label="Stamp"
                                active={stampActive}
                                onSelect={activateStamp}
                            >
                                <Stamp />
                            </ToolMenuItem>
                            <ToolMenuItem
                                label="Rotate"
                                active={rotateActive}
                                onSelect={toggleRotate}
                            >
                                <RotateCw />
                            </ToolMenuItem>
                            <ToolMenuItem
                                label="Crop"
                                active={cropActive}
                                onSelect={toggleCrop}
                            >
                                <Crop />
                            </ToolMenuItem>
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <div className="hidden items-center gap-1 md:flex">
                {query ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            render={
                                <Button
                                    type="button"
                                    variant={
                                        query.hasQueryContent ?
                                            "secondary" :
                                            "outline"
                                    }
                                    size="icon-sm"
                                    aria-label="Edit tag query"
                                >
                                    <ListFilter />
                                </Button>
                            }
                        />
                        <DropdownMenuContent
                            align="start"
                            className="flex max-h-[min(80dvh,28rem)] w-[min(100vw-2rem,24rem)] flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-2"
                        >
                            <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-3">
                                <DropdownMenuLabel className="shrink-0 px-0">
                                    Query builder
                                </DropdownMenuLabel>
                                <TagQueryBuilderContent
                                    {...query}
                                    filterTarget={filterTarget}
                                />
                            </DropdownMenuGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
                <ToolButton
                    active={selectionEnabled}
                    activeLabel="Exit selection mode"
                    inactiveLabel="Select media"
                    onClick={() => {
                        setMode(selectionEnabled ? "none" : "select");
                    }}
                >
                    <Check />
                </ToolButton>
                <ToolButton
                    active={stampActive}
                    activeLabel="Exit stamp tool"
                    inactiveLabel="Stamp tags onto photos"
                    activeTitle="Exit stamp"
                    inactiveTitle="Stamp — pick tags, tap photos"
                    onClick={activateStamp}
                >
                    <Stamp />
                </ToolButton>
                <ToolButton
                    active={rotateActive}
                    activeLabel="Exit rotate tool"
                    inactiveLabel="Quick rotate photos"
                    activeTitle="Exit rotate"
                    inactiveTitle="Rotate — tap photos +90°, then Apply"
                    onClick={toggleRotate}
                >
                    <RotateCw />
                </ToolButton>
                <ToolButton
                    active={cropActive}
                    activeLabel="Exit crop tool"
                    inactiveLabel="Quick crop photos"
                    activeTitle="Exit crop"
                    inactiveTitle="Crop — tap photos, drag boxes, then Apply"
                    onClick={toggleCrop}
                >
                    <Crop />
                </ToolButton>
            </div>
        </>
    );
}

interface ToolMenuItemProps {
    label: string;
    active: boolean;
    onSelect: () => void;
    children: ReactNode;
}

function ToolMenuItem({
    label,
    active,
    onSelect,
    children,
}: ToolMenuItemProps): JSX.Element {
    return (
        <DropdownMenuItem onClick={onSelect}>
            {children}
            {label}
            {active ? (
                <span className="ml-auto text-xs text-muted-foreground">
                    On
                </span>
            ) : null}
        </DropdownMenuItem>
    );
}

interface ToolButtonProps {
    active: boolean;
    activeLabel: string;
    inactiveLabel: string;
    activeTitle?: string;
    inactiveTitle?: string;
    onClick: () => void;
    children: ReactNode;
}

function ToolButton({
    active,
    activeLabel,
    inactiveLabel,
    activeTitle,
    inactiveTitle,
    onClick,
    children,
}: ToolButtonProps): JSX.Element {
    return (
        <Button
            type="button"
            variant={active ? "secondary" : "outline"}
            size="icon-sm"
            aria-label={active ? activeLabel : inactiveLabel}
            aria-pressed={active}
            title={active ? activeTitle : inactiveTitle}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}
