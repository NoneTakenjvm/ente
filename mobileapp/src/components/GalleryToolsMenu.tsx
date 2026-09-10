import type { JSX } from "react";
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
import { cn } from "@/lib/utils";
import { stampTagsFromNearnessFilter } from "@/lib/tag-presets";
import { isTagFilterActive } from "@/lib/tags";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useUIStore } from "@/stores/ui-store";

type GalleryToolsMenuProps = {
    /** When set, include Query builder submenu (gallery filter bar). */
    query?: TagQueryBuilderContentProps & { hasQueryContent: boolean };
};

/**
 * Collapses Select / Stamp / Rotate (and optional Query builder) into one menu.
 */
export function GalleryToolsMenu({ query }: GalleryToolsMenuProps): JSX.Element {
    const selectionEnabled = useSelectionStore((s) => s.enabled);
    const stampActive = useSelectionStore((s) => s.stampActive);
    const rotateActive = useSelectionStore((s) => s.rotateActive);
    const setEnabled = useSelectionStore((s) => s.setEnabled);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);
    const setRotateActive = useSelectionStore((s) => s.setRotateActive);

    const anyToolActive = selectionEnabled || stampActive || rotateActive;
    const triggerActive = anyToolActive || Boolean(query?.hasQueryContent);

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

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={triggerActive ? "secondary" : "outline"}
                        size="icon-sm"
                        aria-label="Gallery tools"
                        aria-pressed={anyToolActive}
                        title="Tools — select, stamp, rotate, query"
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
                                    query.hasQueryContent && "font-medium",
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
                                    taggedCount={query.taggedCount}
                                    untaggedCount={query.untaggedCount}
                                    favoritesCount={query.favoritesCount}
                                    notFavoritesCount={query.notFavoritesCount}
                                    photoCount={query.photoCount}
                                    videoCount={query.videoCount}
                                    croppedCount={query.croppedCount}
                                    notCroppedCount={query.notCroppedCount}
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
                            setRotateActive(!rotateActive);
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
    );
}
