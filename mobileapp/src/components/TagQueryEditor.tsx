import { useState, type JSX } from "react";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagScopeFilterDropdown } from "@/components/TagScopeFilterDropdown";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { X } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    describeTagFilterClause,
    isTagFilterClause,
    type FavoritesScope,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
    type TagScope,
} from "@/lib/tags";
import { cn } from "@/lib/utils";

export interface TagQueryEditorActions {
    setTagScope: (scope: TagScope) => void;
    setFavoritesScope: (scope: FavoritesScope) => void;
    setGroupOp: (groupId: string, op: TagFilterJoin) => void;
    wrapInGroup: (nodeIds: string[], op: TagFilterJoin) => void;
    ungroup: (groupId: string) => void;
    removeNode: (nodeId: string) => void;
    setClauseMode: (clauseId: string, mode: TagFilterMode) => void;
    setClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
}

interface TagQueryEditorProps {
    filter: TagFilterSelection;
    actions: TagQueryEditorActions;
    taggedCount: number;
    untaggedCount: number;
    favoritesCount: number;
    notFavoritesCount: number;
    emptyHint?: string;
}

interface NodeRowProps {
    node: TagFilterNode;
    depth: number;
    filter: TagFilterSelection;
    selectedIds: Set<string>;
    onToggleSelect: (nodeId: string) => void;
    onRemove: (nodeId: string) => void;
    onSetClauseMode: (clauseId: string, mode: TagFilterMode) => void;
    onSetClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    onSetGroupOp: (groupId: string, op: TagFilterJoin) => void;
    onUngroup: (groupId: string) => void;
}

function FilterNodeRow({
    node,
    depth,
    filter,
    selectedIds,
    onToggleSelect,
    onRemove,
    onSetClauseMode,
    onSetClauseInGroup,
    onSetGroupOp,
    onUngroup,
}: NodeRowProps): JSX.Element {
    if (isTagFilterClause(node)) {
        return (
            <li
                className="flex items-center gap-2 rounded-md border border-border/60 p-2"
                style={{ marginLeft: depth * 12 }}
            >
                <Checkbox
                    checked={selectedIds.has(node.id)}
                    onCheckedChange={() => {
                        onToggleSelect(node.id);
                    }}
                    aria-label={`Select ${describeTagFilterClause(node)}`}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                    {node.tag}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        type="button"
                        size="xs"
                        variant={
                            node.mode === "include" ? "default" : "outline"
                        }
                        className="h-7 px-2"
                        disabled={filter.tagScope === "tagged"}
                        onClick={() => {
                            onSetClauseMode(node.id, "include");
                        }}
                    >
                        Has
                    </Button>
                    <Button
                        type="button"
                        size="xs"
                        variant={
                            node.mode === "exclude" ? "destructive" : "outline"
                        }
                        className={cn(
                            "h-7 px-2",
                            node.mode === "exclude" &&
                                "text-destructive-foreground",
                        )}
                        onClick={() => {
                            onSetClauseMode(node.id, "exclude");
                        }}
                    >
                        Not
                    </Button>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${node.tag}`}
                    onClick={() => {
                        onRemove(node.id);
                    }}
                >
                    <X className="size-3.5" />
                </Button>
            </li>
        );
    }

    return (
        <li
            className="flex flex-col gap-2 rounded-md border border-dashed border-border/80 p-2"
            style={{ marginLeft: depth * 12 }}
        >
            <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                    checked={selectedIds.has(node.id)}
                    onCheckedChange={() => {
                        onToggleSelect(node.id);
                    }}
                    aria-label="Select group"
                />
                <span className="text-xs font-medium text-muted-foreground">
                    Group
                </span>
                <ToggleGroup
                    value={[node.op]}
                    spacing={0}
                    className="shrink-0"
                    onValueChange={(next) => {
                        const value = Array.isArray(next) ? next[0] : next;
                        if (value === "and" || value === "or") {
                            onSetGroupOp(node.id, value);
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
                <TagClausePicker
                    filter={filter}
                    targetGroupId={node.id}
                    onSetClauseInGroup={onSetClauseInGroup}
                    triggerLabel="Add tag"
                    triggerVariant="ghost"
                    triggerSize="xs"
                />
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    onClick={() => {
                        onUngroup(node.id);
                    }}
                >
                    Ungroup
                </Button>
            </div>
            <ul className="flex flex-col gap-2">
                {node.children.map((child) => (
                    <FilterNodeRow
                        key={child.id}
                        node={child}
                        depth={depth + 1}
                        filter={filter}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        onRemove={onRemove}
                        onSetClauseMode={onSetClauseMode}
                        onSetClauseInGroup={onSetClauseInGroup}
                        onSetGroupOp={onSetGroupOp}
                        onUngroup={onUngroup}
                    />
                ))}
            </ul>
        </li>
    );
}

function RootGroupSection({
    group,
    filter,
    selectedIds,
    emptyHint,
    onToggleSelect,
    onRemove,
    onSetClauseMode,
    onSetClauseInGroup,
    onSetGroupOp,
    onUngroup,
}: {
    group: TagFilterGroup;
    filter: TagFilterSelection;
    selectedIds: Set<string>;
    emptyHint: string;
    onToggleSelect: (nodeId: string) => void;
    onRemove: (nodeId: string) => void;
    onSetClauseMode: (clauseId: string, mode: TagFilterMode) => void;
    onSetClauseInGroup: (
        groupId: string,
        tag: string,
        mode: TagFilterMode | null,
    ) => void;
    onSetGroupOp: (groupId: string, op: TagFilterJoin) => void;
    onUngroup: (groupId: string) => void;
}): JSX.Element {
    if (group.children.length === 0) {
        return (
            <div className="flex flex-col gap-2">
                <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                    {emptyHint}
                </p>
                <TagClausePicker
                    filter={filter}
                    targetGroupId={group.id}
                    onSetClauseInGroup={onSetClauseInGroup}
                    triggerLabel="Add tag"
                    triggerSize="sm"
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 px-1">
                <span className="text-xs font-medium text-muted-foreground">
                    Match
                </span>
                <ToggleGroup
                    value={[group.op]}
                    spacing={0}
                    className="shrink-0"
                    onValueChange={(next) => {
                        const value = Array.isArray(next) ? next[0] : next;
                        if (value === "and" || value === "or") {
                            onSetGroupOp(group.id, value);
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
                <TagClausePicker
                    filter={filter}
                    targetGroupId={group.id}
                    onSetClauseInGroup={onSetClauseInGroup}
                    triggerLabel="Add tag"
                    triggerVariant="ghost"
                    triggerSize="xs"
                />
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {group.children.map((child) => (
                    <FilterNodeRow
                        key={child.id}
                        node={child}
                        depth={0}
                        filter={filter}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        onRemove={onRemove}
                        onSetClauseMode={onSetClauseMode}
                        onSetClauseInGroup={onSetClauseInGroup}
                        onSetGroupOp={onSetGroupOp}
                        onUngroup={onUngroup}
                    />
                ))}
            </ul>
        </div>
    );
}

/**
 * Controlled tag query tree editor (scope, favourites, AND/OR grouping).
 */
export function TagQueryEditor({
    filter,
    actions,
    taggedCount,
    untaggedCount,
    favoritesCount,
    notFavoritesCount,
    emptyHint = "No tag steps yet. Add tags below, then group steps with AND or OR.",
}: TagQueryEditorProps): JSX.Element {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [wrapGroupOp, setWrapGroupOp] = useState<TagFilterJoin>("and");

    const selectedList = [...selectedIds];

    const handleToggleSelect = (nodeId: string): void => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(nodeId)) {
                next.delete(nodeId);
            } else {
                next.add(nodeId);
            }
            return next;
        });
    };

    const handleGroupSelected = (): void => {
        if (selectedList.length < 2) {
            return;
        }
        actions.wrapInGroup(selectedList, wrapGroupOp);
        setSelectedIds(new Set());
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex shrink-0 flex-wrap gap-2">
                <TagScopeFilterDropdown
                    taggedCount={taggedCount}
                    untaggedCount={untaggedCount}
                    favoritesCount={favoritesCount}
                    notFavoritesCount={notFavoritesCount}
                    tagScope={filter.tagScope}
                    onTagScopeChange={actions.setTagScope}
                    favoritesScope={filter.favoritesScope}
                    onFavoritesScopeChange={actions.setFavoritesScope}
                />
            </div>

            <RootGroupSection
                group={filter.root}
                filter={filter}
                selectedIds={selectedIds}
                emptyHint={emptyHint}
                onToggleSelect={handleToggleSelect}
                onRemove={actions.removeNode}
                onSetClauseMode={actions.setClauseMode}
                onSetClauseInGroup={actions.setClauseInGroup}
                onSetGroupOp={actions.setGroupOp}
                onUngroup={actions.ungroup}
            />

            {selectedList.length >= 2 ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                    <ToggleGroup
                        value={[wrapGroupOp]}
                        spacing={0}
                        onValueChange={(next) => {
                            const value = Array.isArray(next) ? next[0] : next;
                            if (value === "and" || value === "or") {
                                setWrapGroupOp(value);
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
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={handleGroupSelected}
                    >
                        Group selected ({selectedList.length})
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
