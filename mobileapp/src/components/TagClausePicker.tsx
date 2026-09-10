import { useMemo, useState, type JSX, type WheelEvent } from "react";
import { Tags } from "lucide-react";
import { TagTypeTabBar } from "@/components/TagTypeTabBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    ALL_TAG_TYPES_TAB,
    tagsForTypeView,
} from "@/lib/tag-types";
import {
    KITS_TAB,
    rankPresetsByMatchCount,
    type TagPreset,
} from "@/lib/tag-presets";
import {
    findKitModeInGroup,
    type KitFilterInput,
} from "@/lib/tag-filter-mutations";
import {
    findClauseInGroup,
    findClauseModeForTag,
    findTagFilterGroupById,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
    isReservedTag,
    tagFileCount,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterSelection,
} from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";

const isTagFilterJoin = (value: unknown): value is TagFilterJoin =>
    value === "and" || value === "or" || value === "only";

interface TagClausePickerProps {
    filter: TagFilterSelection;
    onSetTagFilterMode?: (tag: string, mode: TagFilterMode | null) => void;
    onSetClauseInGroup?: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    /** Prefer when applying a kit at root. */
    onSetKitMode?: (kit: KitFilterInput, mode: TagFilterMode | null) => void;
    /** Prefer when applying a kit in a group. */
    onSetKitInGroup?: (
        groupId: string,
        kit: KitFilterInput,
        mode: TagFilterMode | null,
    ) => void;
    /** When set, show an AND/OR/ONLY control for the root flat filter. */
    onSetRootOp?: (op: TagFilterJoin) => void;
    targetGroupId?: string;
    disabled?: boolean;
    disabledReason?: string;
    triggerLabel?: string;
    triggerVariant?: "outline" | "ghost" | "secondary";
    triggerSize?: "sm" | "xs";
}

/**
 * Dropdown to add include/exclude tag clauses or kit units at the root or
 * within one group.
 */
export function TagClausePicker({
    filter,
    onSetTagFilterMode,
    onSetClauseInGroup,
    onSetKitMode,
    onSetKitInGroup,
    onSetRootOp,
    targetGroupId,
    disabled = false,
    disabledReason,
    triggerLabel = "Add tags",
    triggerVariant = "outline",
    triggerSize = "sm",
}: TagClausePickerProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const tags = useTagStore((s) => s.tags);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const presets = useTagSpeedStore((s) => s.presets);
    const allFiles = useLibraryStore((s) => s.allFiles);

    const showKitsTab = presets.length > 0;
    const [selectedType, setSelectedType] = useState<string>(ALL_TAG_TYPES_TAB);

    const isKitsTab = selectedType === KITS_TAB;

    const scopedGroup = useMemo(
        (): ReturnType<typeof findTagFilterGroupById> =>
            targetGroupId ?
                findTagFilterGroupById(filter.root, targetGroupId) :
                null,
        [filter.root, targetGroupId],
    );

    const activeGroup: TagFilterGroup = scopedGroup ?? filter.root;

    const isRootPicker = targetGroupId === undefined;
    const isFlatRoot = isFlatTagFilterRoot(filter.root);
    const groupedFilterBlocksRoot = isRootPicker && !isFlatRoot;
    const isDisabled =
        disabled ||
        groupedFilterBlocksRoot ||
        (targetGroupId !== undefined && !scopedGroup);
    const hint =
        disabledReason ??
        (groupedFilterBlocksRoot ? GROUPED_TAG_FILTER_DROPDOWN_HINT : undefined);
    const showRootJoinToggle =
        isRootPicker && isFlatRoot && onSetRootOp !== undefined;
    const isOnlyMode = activeGroup.op === "only";

    const visibleTags = useMemo((): string[] => {
        if (!open || isKitsTab) {
            return [];
        }
        return tagsForTypeView(
            tags.filter((tag) => !isReservedTag(tag)),
            tagTypeByName,
            selectedType,
            fileIdsByTag,
        );
    }, [
        open,
        tags,
        tagTypeByName,
        selectedType,
        fileIdsByTag,
        isKitsTab,
    ]);

    const rankedPresets = useMemo((): { preset: TagPreset; count: number }[] => {
        if (!open || !presets.length) {
            return [];
        }
        return rankPresetsByMatchCount(presets, allFiles, {
            exact: isOnlyMode,
        });
    }, [open, allFiles, isOnlyMode, presets]);

    const resolveMode = (tag: string): TagFilterMode | null => {
        if (scopedGroup) {
            return findClauseInGroup(scopedGroup, tag)?.mode ?? null;
        }
        return findClauseModeForTag(filter.root, tag);
    };

    const handleModeChange = (tag: string, mode: TagFilterMode | null): void => {
        if (scopedGroup && onSetClauseInGroup) {
            onSetClauseInGroup(scopedGroup.id, tag, mode);
            return;
        }
        if (onSetTagFilterMode) {
            onSetTagFilterMode(tag, mode);
        }
    };

    const handleKitModeChange = (
        preset: TagPreset,
        mode: TagFilterMode | null,
    ): void => {
        const kit: KitFilterInput = {
            presetId: preset.id,
            name: preset.name,
            tags: [...preset.tags],
        };
        if (scopedGroup && onSetKitInGroup) {
            onSetKitInGroup(scopedGroup.id, kit, mode);
            return;
        }
        if (!scopedGroup && onSetKitMode) {
            onSetKitMode(kit, mode);
        }
    };

    const stopWheelPropagation = (
        event: WheelEvent<HTMLUListElement>,
    ): void => {
        event.stopPropagation();
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger
                disabled={isDisabled}
                render={
                    <Button
                        type="button"
                        variant={triggerVariant}
                        size={triggerSize}
                        className="gap-1.5"
                        disabled={isDisabled}
                        title={hint}
                        aria-label={triggerLabel}
                    >
                        <Tags className="size-3.5 shrink-0" />
                        {triggerLabel}
                    </Button>
                }
            />
            <DropdownMenuContent
                align="start"
                className="flex max-h-72 w-[min(100vw-2rem,20rem)] flex-col overflow-hidden p-2"
            >
                <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                    <DropdownMenuLabel className="shrink-0 px-0">
                        Has / not has / only
                    </DropdownMenuLabel>
                    {showRootJoinToggle ? (
                        <div className="flex shrink-0 items-center justify-between gap-2 px-0">
                            <span className="text-xs text-muted-foreground">
                                Match
                            </span>
                            <ToggleGroup
                                value={[filter.root.op]}
                                spacing={0}
                                size="sm"
                                onValueChange={(next) => {
                                    const value = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (isTagFilterJoin(value)) {
                                        onSetRootOp(value);
                                    }
                                }}
                            >
                                <ToggleGroupItem
                                    value="and"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                >
                                    AND
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="or"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                >
                                    OR
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="only"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    title="Photos whose tags are exactly the selected Has tags"
                                >
                                    ONLY
                                </ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                    ) : null}
                    <TagTypeTabBar
                        className="shrink-0"
                        types={tagTypes}
                        selected={selectedType}
                        onSelect={setSelectedType}
                        leadingTabs={showKitsTab ? [KITS_TAB] : undefined}
                    />
                    {!open ? null : isKitsTab ? (
                        rankedPresets.length === 0 ? (
                            <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                                No kits yet. Create them in Manage → Tags.
                            </p>
                        ) : (
                            <ul
                                className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
                                onWheel={stopWheelPropagation}
                            >
                                {rankedPresets.map(({ preset, count }) => {
                                    const mode = findKitModeInGroup(
                                        activeGroup,
                                        preset.id,
                                    );
                                    return (
                                        <li
                                            key={preset.id}
                                            className="flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5"
                                        >
                                            <span className="min-w-0 flex-1 truncate text-sm">
                                                <span className="font-medium">
                                                    {preset.name}
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {preset.tags.join(", ")}
                                                </span>
                                            </span>
                                            <Badge
                                                variant="secondary"
                                                className="tabular-nums"
                                            >
                                                {count}
                                            </Badge>
                                            <div className="flex shrink-0 items-center gap-1">
                                                <Button
                                                    type="button"
                                                    size="xs"
                                                    variant={
                                                        mode === "include" ?
                                                            "default" :
                                                            "outline"
                                                    }
                                                    className="h-7 px-2"
                                                    title="Has every tag in this kit"
                                                    onClick={() => {
                                                        handleKitModeChange(
                                                            preset,
                                                            mode === "include" ?
                                                                null :
                                                                "include",
                                                        );
                                                    }}
                                                >
                                                    Has
                                                </Button>
                                                <Button
                                                    type="button"
                                                    size="xs"
                                                    variant={
                                                        mode === "exclude" ?
                                                            "destructive" :
                                                            "outline"
                                                    }
                                                    className={cn(
                                                        "h-7 px-2",
                                                        mode === "exclude" &&
                                                            "text-destructive-foreground",
                                                    )}
                                                    disabled={isOnlyMode}
                                                    title={
                                                        isOnlyMode ?
                                                            "Not is unavailable in ONLY mode — exact tag set only" :
                                                            "Not this kit (missing at least one tag)"
                                                    }
                                                    onClick={() => {
                                                        handleKitModeChange(
                                                            preset,
                                                            mode === "exclude" ?
                                                                null :
                                                                "exclude",
                                                        );
                                                    }}
                                                >
                                                    Not
                                                </Button>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )
                    ) : visibleTags.length === 0 ? (
                        <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                            No tags in this group.
                        </p>
                    ) : (
                        <ul
                            className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
                            onWheel={stopWheelPropagation}
                        >
                            {visibleTags.map((tag) => {
                                const mode = resolveMode(tag);
                                const count = tagFileCount(tag, fileIdsByTag);
                                return (
                                    <li
                                        key={tag}
                                        className="flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-sm">
                                            {tag}
                                        </span>
                                        <Badge
                                            variant="secondary"
                                            className="tabular-nums"
                                        >
                                            {count}
                                        </Badge>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <Button
                                                type="button"
                                                size="xs"
                                                variant={
                                                    mode === "include" ?
                                                        "default" :
                                                        "outline"
                                                }
                                                className="h-7 px-2"
                                                onClick={() => {
                                                    handleModeChange(
                                                        tag,
                                                        mode === "include" ?
                                                            null :
                                                            "include",
                                                    );
                                                }}
                                            >
                                                Has
                                            </Button>
                                            <Button
                                                type="button"
                                                size="xs"
                                                variant={
                                                    mode === "exclude" ?
                                                        "destructive" :
                                                        "outline"
                                                }
                                                className={cn(
                                                    "h-7 px-2",
                                                    mode === "exclude" &&
                                                        "text-destructive-foreground",
                                                )}
                                                disabled={isOnlyMode}
                                                title={
                                                    isOnlyMode ?
                                                        "Not is unavailable in ONLY mode — exact tag set only" :
                                                        undefined
                                                }
                                                onClick={() => {
                                                    handleModeChange(
                                                        tag,
                                                        mode === "exclude" ?
                                                            null :
                                                            "exclude",
                                                    );
                                                }}
                                            >
                                                Not
                                            </Button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
