import { useMemo, useState, type JSX } from "react";
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
import {
    ALL_TAG_TYPES_TAB,
    tagsForTypeView,
} from "@/lib/tag-types";
import {
    findClauseInGroup,
    findClauseModeForTag,
    findTagFilterGroupById,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
    isReservedTag,
    tagFileCount,
    type TagFilterMode,
    type TagFilterSelection,
} from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useTagStore } from "@/stores/tag-store";

interface TagClausePickerProps {
    filter: TagFilterSelection;
    onSetTagFilterMode?: (tag: string, mode: TagFilterMode | null) => void;
    onSetClauseInGroup?: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    targetGroupId?: string;
    disabled?: boolean;
    disabledReason?: string;
    triggerLabel?: string;
    triggerVariant?: "outline" | "ghost" | "secondary";
    triggerSize?: "sm" | "xs";
}

/**
 * Dropdown to add include/exclude tag clauses at the root or within one group.
 */
export function TagClausePicker({
    filter,
    onSetTagFilterMode,
    onSetClauseInGroup,
    targetGroupId,
    disabled = false,
    disabledReason,
    triggerLabel = "Add tags",
    triggerVariant = "outline",
    triggerSize = "sm",
}: TagClausePickerProps): JSX.Element {
    const tags = useTagStore((s) => s.tags);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);

    const [selectedType, setSelectedType] = useState<string>(ALL_TAG_TYPES_TAB);

    const visibleTags = useMemo(
        (): string[] =>
            tagsForTypeView(
                tags.filter((tag) => !isReservedTag(tag)),
                tagTypeByName,
                selectedType,
                fileIdsByTag,
            ),
        [tags, tagTypeByName, selectedType, fileIdsByTag],
    );

    const scopedGroup = useMemo(
        (): ReturnType<typeof findTagFilterGroupById> =>
            targetGroupId ?
                findTagFilterGroupById(filter.root, targetGroupId) :
                null,
        [filter.root, targetGroupId],
    );

    const isRootPicker = targetGroupId === undefined;
    const groupedFilterBlocksRoot =
        isRootPicker && !isFlatTagFilterRoot(filter.root);
    const isDisabled =
        disabled || groupedFilterBlocksRoot || (targetGroupId !== undefined && !scopedGroup);
    const hint =
        disabledReason ??
        (groupedFilterBlocksRoot ? GROUPED_TAG_FILTER_DROPDOWN_HINT : undefined);

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

    return (
        <DropdownMenu>
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
                <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-2">
                    <DropdownMenuLabel className="shrink-0 px-0">
                        Has / not has
                    </DropdownMenuLabel>
                    <TagTypeTabBar
                        className="shrink-0"
                        types={tagTypes}
                        selected={selectedType}
                        onSelect={setSelectedType}
                    />
                    {visibleTags.length === 0 ? (
                        <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                            No tags in this group.
                        </p>
                    ) : (
                        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain">
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
                                                disabled={
                                                    filter.tagScope === "tagged"
                                                }
                                                title={
                                                    filter.tagScope === "tagged" ?
                                                        "Already limited to tagged photos" :
                                                        undefined
                                                }
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
