import { useCallback, useState, type JSX, type ReactNode } from "react";
import {
    Check,
    Crop,
    ListFilter,
    RotateCw,
    Stamp,
    Wrench,
} from "lucide-react";
import { TagQueryEditor } from "@/components/TagQueryEditor";
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
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterBinding } from "@/hooks/use-tag-filter-binding";
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
    counts: ScopeCounts;
};

interface Tool {
    label: string;
    icon: ReactNode;
    active: boolean;
    onToggle: () => void;
    activeLabel: string;
    inactiveLabel: string;
    activeTitle: string;
    inactiveTitle: string;
}

/**
 * Gallery/album tools: wrench dropdown below `md`, individual icon buttons at `md+`.
 * Mobile: re-tap wrench exits the active tool; opens the menu only when none is active.
 */
export function GalleryToolsMenu({
    counts,
    filterTarget = "gallery",
}: GalleryToolsMenuProps): JSX.Element {
    const { filter, actions } = useTagFilterBinding(filterTarget);
    const hasQueryContent = isTagFilterActive(filter);
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
    const triggerActive = anyToolActive || hasQueryContent;

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

    const tools: Tool[] = [
        {
            label: "Select",
            icon: <Check />,
            active: selectionEnabled,
            onToggle: () => {
                setMode(selectionEnabled ? "none" : "select");
            },
            activeLabel: "Exit selection mode",
            inactiveLabel: "Select media",
            activeTitle: "Exit selection mode",
            inactiveTitle: "Select media",
        },
        {
            label: "Stamp",
            icon: <Stamp />,
            active: stampActive,
            onToggle: activateStamp,
            activeLabel: "Exit stamp tool",
            inactiveLabel: "Stamp tags onto photos",
            activeTitle: "Exit stamp",
            inactiveTitle: "Stamp — pick tags, tap photos",
        },
        {
            label: "Rotate",
            icon: <RotateCw />,
            active: rotateActive,
            onToggle: toggleRotate,
            activeLabel: "Exit rotate tool",
            inactiveLabel: "Quick rotate photos",
            activeTitle: "Exit rotate",
            inactiveTitle: "Rotate — tap photos +90°, then Apply",
        },
        {
            label: "Crop",
            icon: <Crop />,
            active: cropActive,
            onToggle: toggleCrop,
            activeLabel: "Exit crop tool",
            inactiveLabel: "Quick crop photos",
            activeTitle: "Exit crop",
            inactiveTitle: "Crop — tap photos, drag boxes, then Apply",
        },
    ];

    const queryEditor = (
        <TagQueryEditor filter={filter} actions={actions} counts={counts} />
    );

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
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger
                                    className={cn(
                                        hasQueryContent && "font-medium",
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
                                    {queryEditor}
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuSeparator />
                            {tools.map((tool) => (
                                <DropdownMenuItem
                                    key={tool.label}
                                    onClick={tool.onToggle}
                                >
                                    {tool.icon}
                                    {tool.label}
                                    {tool.active ? (
                                        <span className="ml-auto text-xs text-muted-foreground">
                                            On
                                        </span>
                                    ) : null}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <div className="hidden items-center gap-1 md:flex">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                type="button"
                                variant={
                                    hasQueryContent ? "secondary" : "outline"
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
                            {queryEditor}
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
                {tools.map((tool) => (
                    <Button
                        key={tool.label}
                        type="button"
                        variant={tool.active ? "secondary" : "outline"}
                        size="icon-sm"
                        aria-label={
                            tool.active ? tool.activeLabel : tool.inactiveLabel
                        }
                        aria-pressed={tool.active}
                        title={
                            tool.active ? tool.activeTitle : tool.inactiveTitle
                        }
                        onClick={tool.onToggle}
                    >
                        {tool.icon}
                    </Button>
                ))}
            </div>
        </>
    );
}
