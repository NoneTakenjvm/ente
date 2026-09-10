import type { JSX } from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { Button } from "@/components/ui/button";
import type { TagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    describeTagFilter,
    isFlatTagFilterRoot,
} from "@/lib/tags";

interface NearnessFilterEditorProps {
    draft: TagFilterDraft;
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    photoCount: number;
    videoCount: number;
    croppedCount: number;
    notCroppedCount: number;
    onDone: () => void;
    onBack: () => void;
}

/**
 * Inline editor for the gallery nearness seed filter (tags / kits / query).
 */
export function NearnessFilterEditor({
    draft,
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    photoCount,
    videoCount,
    croppedCount,
    notCroppedCount,
    onDone,
    onBack,
}: NearnessFilterEditorProps): JSX.Element {
    return (
        <div className="flex max-h-[min(70dvh,28rem)] flex-col gap-2 overflow-hidden px-1 pb-2">
            <div className="flex flex-wrap items-center gap-2">
                <TagClausePicker
                    filter={draft.filter}
                    onSetTagFilterMode={draft.actions.setTagFilterMode}
                    onSetKitMode={draft.actions.setKitMode}
                    onSetRootOp={(op) => {
                        draft.actions.setGroupOp(draft.filter.root.id, op);
                    }}
                    disabled={!isFlatTagFilterRoot(draft.filter.root)}
                />
            </div>
            {!isFlatTagFilterRoot(draft.filter.root) ? (
                <p className="px-1 text-xs text-muted-foreground">
                    {GROUPED_TAG_FILTER_DROPDOWN_HINT}
                </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-border/60 p-2">
                <TagQueryEditor
                    filter={draft.filter}
                    actions={draft.actions}
                    taggedCount={taggedCount}
                    untaggedCount={untaggedCount}
                    favoritesCount={favoritesCount}
                    notFavoritesCount={notFavoritesCount}
                    photoCount={photoCount}
                    videoCount={videoCount}
                    croppedCount={croppedCount}
                    notCroppedCount={notCroppedCount}
                />
            </div>
            <p className="max-h-12 overflow-auto px-1 text-xs text-muted-foreground break-words">
                {describeTagFilter(draft.filter) || "No nearness filter yet"}
            </p>
            <div className="flex flex-wrap gap-1.5 px-1">
                <Button type="button" variant="default" size="sm" onClick={onDone}>
                    Done
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onBack}>
                    Back
                </Button>
            </div>
        </div>
    );
}
