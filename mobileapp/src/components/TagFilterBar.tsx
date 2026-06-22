import { useMemo, useState, type JSX } from "react";
import { ListFilter, Tags } from "lucide-react";
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
    countTaggedInCandidates,
    countUntaggedInCandidates,
    describeTagFilter,
    describeTagFilterClause,
    isTagFilterActive,
    isReservedTag,
    tagFileCount,
    type TagFilterJoin,
    type TagFilterMode,
} from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";

interface TagFilterBarProps {
    matchCount: number;
}

const filterModeForTag = (
    tag: string,
    clauses: { tag: string; mode: TagFilterMode }[],
): TagFilterMode | null =>
    clauses.find((clause) => clause.tag === tag)?.mode ?? null;

export function TagFilterBar({
    matchCount,
}: TagFilterBarProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const tags = useTagStore((s) => s.tags);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const tagFilter = useTagStore((s) => s.tagFilter);
    const toggleUntaggedFilter = useTagStore((s) => s.toggleUntaggedFilter);
    const toggleTaggedFilter = useTagStore((s) => s.toggleTaggedFilter);
    const setTagFilterMode = useTagStore((s) => s.setTagFilterMode);
    const setTagFilterJoin = useTagStore((s) => s.setTagFilterJoin);
    const clearFilters = useTagStore((s) => s.clearFilters);

    const [selectedType, setSelectedType] = useState<string>(ALL_TAG_TYPES_TAB);

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(allFiles.map((file) => file.id)),
        [allFiles],
    );

    const untaggedCount = useMemo(
        (): number =>
            countUntaggedInCandidates(libraryFileIds, fileIdsByTag),
        [libraryFileIds, fileIdsByTag],
    );

    const taggedCount = useMemo(
        (): number =>
            countTaggedInCandidates(libraryFileIds, fileIdsByTag),
        [libraryFileIds, fileIdsByTag],
    );

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

    const tagsButtonLabel = useMemo((): string => {
        if (tagFilter.clauses.length === 0) {
            return "Tags";
        }
        return `${tagFilter.clauses.length} tag${tagFilter.clauses.length === 1 ? "" : "s"}`;
    }, [tagFilter.clauses]);

    const hasQueryClauses = tagFilter.clauses.length > 0;

    return (
        <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex flex-nowrap items-center justify-center gap-2 overflow-x-auto">
                <Button
                    type="button"
                    variant={tagFilter.untagged ? "secondary" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    onClick={toggleUntaggedFilter}
                >
                    Untagged
                    <span className="text-xs tabular-nums opacity-70">
                        {untaggedCount}
                    </span>
                </Button>
                <Button
                    type="button"
                    variant={tagFilter.tagged ? "secondary" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    onClick={toggleTaggedFilter}
                >
                    Tagged
                    <span className="text-xs tabular-nums opacity-70">
                        {taggedCount}
                    </span>
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                type="button"
                                variant={
                                    tagFilter.clauses.length > 0 ?
                                        "secondary" :
                                        "outline"
                                }
                                size="sm"
                                className="gap-1.5"
                                aria-label="Filter by tags"
                            >
                                <Tags className="size-3.5 shrink-0" />
                                <span className="max-w-[8rem] truncate">
                                    {tagsButtonLabel}
                                </span>
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
                                        const mode = filterModeForTag(
                                            tag,
                                            tagFilter.clauses,
                                        );
                                        const count = tagFileCount(
                                            tag,
                                            fileIdsByTag,
                                        );
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
                                                            tagFilter.tagged
                                                        }
                                                        title={
                                                            tagFilter.tagged ?
                                                                "Already limited to tagged photos" :
                                                                undefined
                                                        }
                                                        onClick={() => {
                                                            setTagFilterMode(
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
                                                            setTagFilterMode(
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
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                type="button"
                                variant={hasQueryClauses ? "secondary" : "outline"}
                                size="icon-sm"
                                aria-label={
                                    hasQueryClauses ?
                                        `Edit tag query (${tagFilter.clauses.length} steps)` :
                                        "Edit tag query"
                                }
                            >
                                <ListFilter />
                            </Button>
                        }
                    />
                    <DropdownMenuContent
                        align="start"
                        className="flex max-h-72 w-[min(100vw-2rem,22rem)] flex-col overflow-hidden p-2"
                    >
                        <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col gap-2">
                            <DropdownMenuLabel className="shrink-0 px-0">
                                Query steps
                            </DropdownMenuLabel>
                            {!hasQueryClauses &&
                            !tagFilter.tagged &&
                            !tagFilter.untagged ? (
                                <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                                    Add tags from the Tags menu, then set AND
                                    or OR between each step.
                                </p>
                            ) : (
                                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                                    {tagFilter.untagged ? (
                                        <li className="rounded-md border border-border/60 px-2 py-1.5 text-sm text-muted-foreground">
                                            Scope: untagged photos
                                        </li>
                                    ) : null}
                                    {tagFilter.tagged ? (
                                        <li className="rounded-md border border-border/60 px-2 py-1.5 text-sm text-muted-foreground">
                                            Scope: tagged photos
                                        </li>
                                    ) : null}
                                    {tagFilter.clauses.map((clause, index) => (
                                        <li
                                            key={clause.tag}
                                            className="flex flex-col gap-2 rounded-md border border-border/60 p-2"
                                        >
                                            <div className="flex items-center gap-2">
                                                {index === 0 ? (
                                                    <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">
                                                        Where
                                                    </span>
                                                ) : (
                                                    <ToggleGroup
                                                        value={[clause.join]}
                                                        spacing={0}
                                                        className="shrink-0"
                                                        onValueChange={(
                                                            next,
                                                        ) => {
                                                            const value =
                                                                Array.isArray(
                                                                    next,
                                                                ) ?
                                                                    next[0] :
                                                                    next;
                                                            if (
                                                                value ===
                                                                    "and" ||
                                                                value === "or"
                                                            ) {
                                                                setTagFilterJoin(
                                                                    clause.tag,
                                                                    value as TagFilterJoin,
                                                                );
                                                            }
                                                        }}
                                                    >
                                                        <ToggleGroupItem
                                                            value="and"
                                                            size="sm"
                                                            className="h-7 px-2 text-xs"
                                                        >
                                                            AND
                                                        </ToggleGroupItem>
                                                        <ToggleGroupItem
                                                            value="or"
                                                            size="sm"
                                                            className="h-7 px-2 text-xs"
                                                        >
                                                            OR
                                                        </ToggleGroupItem>
                                                    </ToggleGroup>
                                                )}
                                                <span className="min-w-0 flex-1 truncate text-sm">
                                                    {describeTagFilterClause(
                                                        clause,
                                                    )}
                                                </span>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {isTagFilterActive(tagFilter) ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                        {matchCount} photo{matchCount === 1 ? "" : "s"}
                        {" · "}
                        {describeTagFilter(tagFilter)}
                    </span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={clearFilters}
                    >
                        Clear
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
