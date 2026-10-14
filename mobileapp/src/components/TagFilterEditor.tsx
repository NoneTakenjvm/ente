import type { JSX } from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import {
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    describeTagFilter,
    isFlatTagFilterRoot,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import type { TagFilterActions } from "@/lib/tag-filter-mutations";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

interface TagFilterEditorProps {
    filter: TagFilterSelection;
    actions: TagFilterActions;
    counts: ScopeCounts;
    /** Shown instead of the description while the filter is empty. */
    emptyDescription: string;
    /** When set, shown beside the tag picker as "N photos match". */
    matchCount?: number;
    className?: string;
}

/**
 * Tag picker, query tree editor and a plain-language description of the
 * filter, for editing a draft filter (album query, nearness seeds).
 */
export function TagFilterEditor({
    filter,
    actions,
    counts,
    emptyDescription,
    matchCount,
    className,
}: TagFilterEditorProps): JSX.Element {
    const isFlatRoot = isFlatTagFilterRoot(filter.root);

    return (
        <div className={cn("flex flex-col gap-2", className)}>
            <div className="flex flex-wrap items-center gap-2">
                <TagClausePicker
                    filter={filter}
                    onSetTagFilterMode={actions.setTagFilterMode}
                    onSetKitMode={actions.setKitMode}
                    onSetRootOp={(op) => {
                        actions.setGroupOp(filter.root.id, op);
                    }}
                    disabled={!isFlatRoot}
                />
                {matchCount !== undefined ? (
                    <span className="text-xs text-muted-foreground">
                        {plural(matchCount, "photo")} match
                    </span>
                ) : null}
            </div>
            {!isFlatRoot ? (
                <p className="px-1 text-xs text-muted-foreground">
                    {GROUPED_TAG_FILTER_DROPDOWN_HINT}
                </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-border/60 p-2">
                <TagQueryEditor
                    filter={filter}
                    actions={actions}
                    counts={counts}
                />
            </div>
            <p className="max-h-12 overflow-auto px-1 text-xs text-muted-foreground break-words">
                {describeTagFilter(filter) || emptyDescription}
            </p>
        </div>
    );
}
