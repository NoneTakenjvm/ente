import type { JSX } from "react";
import { ScopeFilterMenu } from "@/components/ScopeFilterMenu";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import { plural } from "@/lib/format";
import {
    countTagFilterClauses,
    describeTagFilter,
    emptyTagFilter,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
    isTagFilterActive,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import type { TagFilterActions } from "@/lib/tag-filter-mutations";
import { ListFilter } from "lucide-react";

interface ManageTagFilterToolbarProps {
    filter: TagFilterSelection;
    actions: TagFilterActions;
    setFilter: (filter: TagFilterSelection) => void;
    counts: ScopeCounts;
    disabled?: boolean;
}

/** Scope menu, tag picker and query builder, plus a summary of the active filter. */
export function ManageTagFilterToolbar({
    filter,
    actions,
    setFilter,
    counts,
    disabled = false,
}: ManageTagFilterToolbarProps): JSX.Element {
    const clauseCount = countTagFilterClauses(filter.root);
    const isFlat = isFlatTagFilterRoot(filter.root);
    const hasQueryContent =
        clauseCount > 0 ||
        filter.tagScope !== "all" ||
        filter.favoritesScope !== "all" ||
        filter.mediaScope !== "all" ||
        filter.croppedScope !== "all" ||
        filter.rotatedScope !== "all";

    return (
        <>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                <ScopeFilterMenu
                    filter={filter}
                    setScope={actions.setScope}
                    counts={counts}
                />
                <TagClausePicker
                    filter={filter}
                    onSetTagFilterMode={actions.setTagFilterMode}
                    onSetKitMode={actions.setKitMode}
                    onSetRootOp={(op) => {
                        actions.setGroupOp(filter.root.id, op);
                    }}
                    triggerLabel={
                        clauseCount === 0 ?
                            "Tags" :
                            `${plural(clauseCount, "tag")}`
                    }
                    triggerVariant={clauseCount > 0 ? "secondary" : "outline"}
                    disabled={!isFlat || disabled}
                />
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                type="button"
                                variant={hasQueryContent ? "secondary" : "outline"}
                                size="icon-sm"
                                disabled={disabled}
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
                            <TagQueryEditor
                                filter={filter}
                                actions={actions}
                                counts={counts}
                            />
                        </DropdownMenuGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
                {!isFlat ? (
                    <p className="w-full text-xs text-muted-foreground">
                        {GROUPED_TAG_FILTER_DROPDOWN_HINT}
                    </p>
                ) : null}
            </div>

            {isTagFilterActive(filter) ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                        {describeTagFilter(filter)}
                    </span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={disabled}
                        onClick={() => setFilter(emptyTagFilter())}
                    >
                        Clear
                    </Button>
                </div>
            ) : null}
        </>
    );
}
