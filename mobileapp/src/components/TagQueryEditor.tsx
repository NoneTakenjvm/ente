import { memo, useMemo, useState, type JSX, type ReactNode } from "react";
import { ScopeFilterMenu } from "@/components/ScopeFilterMenu";
import { TagClausePicker } from "@/components/TagClausePicker";
import { MatchJoinToggle, ModeButtons } from "@/components/TagFilterControls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { X } from "lucide-react";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import type { TagFilterActions } from "@/lib/tag-filter-mutations";
import {
    describeTagFilterClause,
    describeTagFilterKit,
    isTagFilterClause,
    isTagFilterKit,
    type TagFilterGroup,
    type TagFilterJoin,
    type TagFilterMode,
    type TagFilterNode,
    type TagFilterSelection,
} from "@/lib/tag-filter";

interface TagQueryEditorProps {
    filter: TagFilterSelection;
    actions: TagFilterActions;
    counts: ScopeCounts;
    emptyHint?: string;
}

interface NodeRowProps {
    node: TagFilterNode;
    depth: number;
    filter: TagFilterSelection;
    selectedIds: Set<string>;
    onToggleSelect: (nodeId: string) => void;
    actions: TagFilterActions;
}

function FilterLeafRow({
    depth,
    selected,
    selectLabel,
    removeLabel,
    mode,
    onToggleSelect,
    onSetMode,
    onRemove,
    children,
}: {
    depth: number;
    selected: boolean;
    selectLabel: string;
    removeLabel: string;
    mode: TagFilterMode;
    onToggleSelect: () => void;
    onSetMode: (mode: TagFilterMode) => void;
    onRemove: () => void;
    children: ReactNode;
}): JSX.Element {
    return (
        <li
            className="flex items-center gap-2 rounded-md border border-border/60 p-2"
            style={{ marginLeft: depth * 12 }}
        >
            <Checkbox
                checked={selected}
                onCheckedChange={onToggleSelect}
                aria-label={selectLabel}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{children}</span>
            <ModeButtons mode={mode} onChange={onSetMode} />
            <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={removeLabel}
                onClick={onRemove}
            >
                <X className="size-3.5" />
            </Button>
        </li>
    );
}

const FilterNodeRow = memo(function FilterNodeRow({
    node,
    depth,
    filter,
    selectedIds,
    onToggleSelect,
    actions,
}: NodeRowProps): JSX.Element {
    if (isTagFilterClause(node)) {
        return (
            <FilterLeafRow
                depth={depth}
                selected={selectedIds.has(node.id)}
                selectLabel={`Select ${describeTagFilterClause(node)}`}
                removeLabel={`Remove ${node.tag}`}
                mode={node.mode}
                onToggleSelect={() => onToggleSelect(node.id)}
                onSetMode={(mode) => actions.setClauseMode(node.id, mode)}
                onRemove={() => actions.removeNode(node.id)}
            >
                {node.tag}
            </FilterLeafRow>
        );
    }

    if (isTagFilterKit(node)) {
        return (
            <FilterLeafRow
                depth={depth}
                selected={selectedIds.has(node.id)}
                selectLabel={`Select ${describeTagFilterKit(node)}`}
                removeLabel={`Remove kit ${node.name}`}
                mode={node.mode}
                onToggleSelect={() => onToggleSelect(node.id)}
                onSetMode={(mode) => actions.setClauseMode(node.id, mode)}
                onRemove={() => actions.removeNode(node.id)}
            >
                <span className="font-medium">{node.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                    Kit · {node.tags.join(", ")}
                </span>
            </FilterLeafRow>
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
                <MatchJoinToggle
                    value={node.op}
                    onChange={(op) => {
                        actions.setGroupOp(node.id, op);
                    }}
                />
                <TagClausePicker
                    filter={filter}
                    targetGroupId={node.id}
                    onSetClauseInGroup={actions.setClauseInGroup}
                    onSetKitInGroup={actions.setKitInGroup}
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
                        actions.ungroup(node.id);
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
                        actions={actions}
                    />
                ))}
            </ul>
        </li>
    );
});

function RootGroupSection({
    group,
    filter,
    selectedIds,
    emptyHint,
    onToggleSelect,
    actions,
}: {
    group: TagFilterGroup;
    emptyHint: string;
} & Omit<NodeRowProps, "node" | "depth">): JSX.Element {
    if (group.children.length === 0) {
        return (
            <div className="flex flex-col gap-2">
                <p className="shrink-0 px-1 py-2 text-xs text-muted-foreground">
                    {emptyHint}
                </p>
                <TagClausePicker
                    filter={filter}
                    targetGroupId={group.id}
                    onSetClauseInGroup={actions.setClauseInGroup}
                    onSetKitInGroup={actions.setKitInGroup}
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
                <MatchJoinToggle
                    value={group.op}
                    onChange={(op) => {
                        actions.setGroupOp(group.id, op);
                    }}
                />
                <TagClausePicker
                    filter={filter}
                    targetGroupId={group.id}
                    onSetClauseInGroup={actions.setClauseInGroup}
                    onSetKitInGroup={actions.setKitInGroup}
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
                        actions={actions}
                    />
                ))}
            </ul>
        </div>
    );
}

/**
 * Controlled tag query tree editor (scope, favourites, AND/OR/ONLY grouping).
 */
export function TagQueryEditor({
    filter,
    actions,
    counts,
    emptyHint = "No tag steps yet. Add tags below, then group steps with AND, OR, or ONLY.",
}: TagQueryEditorProps): JSX.Element {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [wrapGroupOp, setWrapGroupOp] = useState<TagFilterJoin>("and");

    const selectedList = useMemo((): string[] => [...selectedIds], [selectedIds]);

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
                <ScopeFilterMenu
                    filter={filter}
                    setScope={actions.setScope}
                    counts={counts}
                />
            </div>

            <RootGroupSection
                group={filter.root}
                filter={filter}
                selectedIds={selectedIds}
                emptyHint={emptyHint}
                onToggleSelect={handleToggleSelect}
                actions={actions}
            />

            {selectedList.length >= 2 ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                    <MatchJoinToggle
                        value={wrapGroupOp}
                        onChange={setWrapGroupOp}
                    />
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
