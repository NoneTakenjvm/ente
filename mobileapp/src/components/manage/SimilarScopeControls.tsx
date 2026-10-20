import { useCallback, useMemo, useState, type JSX } from "react";
import { ManageTagFilterToolbar } from "@/components/manage/ManageTagFilterToolbar";
import { ThumbnailGrid } from "@/components/ThumbnailGrid";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import { plural } from "@/lib/format";
import {
    LATEST_UPLOAD_COUNTS,
    sortByUploadedNewestFirst,
    type SimilarScope,
} from "@/lib/similarity-scope";
import { filterFilesByTags } from "@/lib/tag-filter";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useTagStore } from "@/stores/tag-store";
import type { EnteFile } from "ente-media/file";

interface SimilarScopeControlsProps {
    scope: SimilarScope;
    onScopeChange: (scope: SimilarScope) => void;
    pickedIds: Set<number>;
    onPickedIdsChange: (pickedIds: Set<number>) => void;
    /** Every file Similar can compare; the picker chooses among these. */
    candidates: EnteFile[];
    /** How many photos the current scope searches for. */
    scopeSize: number;
    disabled: boolean;
}

/** Chooses which photos a Similar run searches for: all, the latest uploads, or a hand-picked set. */
export function SimilarScopeControls({
    scope,
    onScopeChange,
    pickedIds,
    onPickedIdsChange,
    candidates,
    scopeSize,
    disabled,
}: SimilarScopeControlsProps): JSX.Element {
    const [pickerOpen, setPickerOpen] = useState<boolean>(false);

    return (
        <>
            <Field>
                <FieldLabel>Search for</FieldLabel>
                <ToggleGroup
                    variant="outline"
                    value={[scope.kind]}
                    disabled={disabled}
                    className="w-full"
                    onValueChange={(next) => {
                        const kind = Array.isArray(next) ? next[0] : next;
                        if (kind === "library") {
                            onScopeChange({ kind });
                        } else if (kind === "latest") {
                            onScopeChange({
                                kind,
                                count: LATEST_UPLOAD_COUNTS[1]!,
                            });
                        } else if (kind === "picked") {
                            onScopeChange({ kind });
                        }
                    }}
                >
                    <ToggleGroupItem value="library" className="flex-1">
                        Whole library
                    </ToggleGroupItem>
                    <ToggleGroupItem value="latest" className="flex-1">
                        Latest
                    </ToggleGroupItem>
                    <ToggleGroupItem value="picked" className="flex-1">
                        Pick
                    </ToggleGroupItem>
                </ToggleGroup>
            </Field>
            {scope.kind === "latest" ? (
                <Select
                    value={String(scope.count)}
                    disabled={disabled}
                    onValueChange={(value) => {
                        onScopeChange({ kind: "latest", count: Number(value) });
                    }}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue>Last {scope.count} uploaded</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {LATEST_UPLOAD_COUNTS.map((count) => (
                            <SelectItem key={count} value={String(count)}>
                                Last {count} uploaded
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : null}
            {scope.kind === "picked" ? (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => setPickerOpen(true)}
                >
                    Choose photos ({pickedIds.size})
                </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">
                Searching {plural(scopeSize, "photo")}, each compared with the
                whole library.
            </p>
            <PhotoPickerSheet
                open={pickerOpen}
                candidates={candidates}
                pickedIds={pickedIds}
                onPickedIdsChange={onPickedIdsChange}
                onClose={() => setPickerOpen(false)}
            />
        </>
    );
}

interface PhotoPickerSheetProps {
    open: boolean;
    candidates: EnteFile[];
    pickedIds: Set<number>;
    onPickedIdsChange: (pickedIds: Set<number>) => void;
    onClose: () => void;
}

/** Tag-filtered grid for hand-picking photos; picks survive filter changes. */
function PhotoPickerSheet({
    open,
    candidates,
    pickedIds,
    onPickedIdsChange,
    onClose,
}: PhotoPickerSheetProps): JSX.Element {
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );
    const { filter, actions, setFilter } = useTagFilterDraft();
    const scopeCounts = useScopeCounts(candidates);

    const shownFiles = useMemo(
        () =>
            sortByUploadedNewestFirst(
                filterFilesByTags(candidates, filter, fileIdsByTag, {
                    favoriteFileIds,
                    includeInEffectsPresenceByName,
                }),
            ),
        [
            candidates,
            favoriteFileIds,
            fileIdsByTag,
            filter,
            includeInEffectsPresenceByName,
        ],
    );
    const shownIds = useMemo(
        () => new Set(shownFiles.map((file) => file.id)),
        [shownFiles],
    );

    const toggleFile = useCallback(
        (file: EnteFile): void => {
            const next = new Set(pickedIds);
            if (!next.delete(file.id)) {
                next.add(file.id);
            }
            onPickedIdsChange(next);
        },
        [onPickedIdsChange, pickedIds],
    );

    const selectMany = useCallback(
        (fileIds: number[], mode: "add" | "toggle" | "set"): void => {
            const next = new Set(pickedIds);
            if (mode === "set") {
                for (const fileId of shownIds) {
                    next.delete(fileId);
                }
            }
            for (const fileId of fileIds) {
                if (!shownIds.has(fileId)) {
                    continue;
                }
                if (mode === "toggle" && next.has(fileId)) {
                    next.delete(fileId);
                } else {
                    next.add(fileId);
                }
            }
            onPickedIdsChange(next);
        },
        [onPickedIdsChange, pickedIds, shownIds],
    );

    const gridSelection = useMemo(
        () => ({
            selectedIds: pickedIds,
            onToggle: toggleFile,
            onSelectMany: selectMany,
            onSetSelection: (fileIds: number[]): void => {
                selectMany(fileIds, "set");
            },
        }),
        [pickedIds, selectMany, toggleFile],
    );

    return (
        <Sheet
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    onClose();
                }
            }}
        >
            <SheetContent
                side="bottom"
                className="rounded-t-xl data-[side=bottom]:h-[90dvh]"
            >
                <SheetHeader>
                    <SheetTitle>Choose photos to search for</SheetTitle>
                </SheetHeader>
                <div className="flex min-h-0 flex-1 flex-col gap-3 px-4">
                    <ManageTagFilterToolbar
                        filter={filter}
                        actions={actions}
                        setFilter={setFilter}
                        counts={scopeCounts}
                    />
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                            {plural(shownFiles.length, "photo")} shown ·{" "}
                            {pickedIds.size} picked
                        </p>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={shownFiles.length === 0}
                                onClick={() => selectMany([...shownIds], "add")}
                            >
                                Select shown
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={pickedIds.size === 0}
                                onClick={() => onPickedIdsChange(new Set())}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                    <ThumbnailGrid files={shownFiles} selection={gridSelection} />
                </div>
                <SheetFooter className="flex-row justify-end">
                    <Button type="button" onClick={onClose}>
                        Done
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
