import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import { ChevronDown, Stamp, Tag } from "lucide-react";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { ToolFooter } from "@/components/ToolFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    rankPresetsByMatchCount,
    tagSetsEqual,
    workingSetTags,
    type TagPreset,
} from "@/lib/tag-presets";
import { cn } from "@/lib/utils";
import { useLibraryStore } from "@/stores/library-store";
import {
    useSelectionStore,
    type StampPickMode,
} from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";

interface RankedKit {
    preset: TagPreset;
    count: number;
}

/**
 * True when `tags` is exactly the preset's tag set (order-independent).
 */
const tagsMatchPreset = (tags: string[], preset: TagPreset): boolean =>
    tags.length > 0 && tagSetsEqual(tags, preset.tags);

/**
 * Footer for the stamp tool: Kit or Tag pick mode, then tap photos to apply.
 * Collapsed by default (session-only expand); summary + Close always visible.
 */
export function StampToolFooter(): JSX.Element | null {
    const stampActive = useSelectionStore((s) => s.mode === "stamp");
    const stampTags = useSelectionStore((s) => s.stampTags);
    const stampPickMode = useSelectionStore((s) => s.stampPickMode);
    const stampSheetOpen = useSelectionStore((s) => s.stampSheetOpen);
    const setMode = useSelectionStore((s) => s.setMode);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const toggleStampTag = useSelectionStore((s) => s.toggleStampTag);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const allFiles = useLibraryStore((s) => s.allFiles);
    const knownTags = useTagStore((s) => s.tags);
    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const recentTags = useTagSpeedStore((s) => s.recentTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);
    /** When equal to the current kit key, show the full kit list. */
    const [expandedKitKey, setExpandedKitKey] = useState<string | null>(null);
    /** Session-only: kit/tag chrome starts collapsed. */
    const [expanded, setExpanded] = useState(false);

    const rankedKits = useMemo(
        () => rankPresetsByMatchCount(presets, allFiles),
        [allFiles, presets],
    );

    const activeKit = useMemo(
        (): TagPreset | undefined =>
            presets.find((preset) => tagsMatchPreset(stampTags, preset)),
        [presets, stampTags],
    );

    const kitListExpanded =
        activeKit?.id === expandedKitKey;

    const tagChips = useMemo(
        () => workingSetTags(stampTags, pinnedTags, recentTags),
        [pinnedTags, recentTags, stampTags],
    );

    const exitStamp = useCallback((): void => {
        setExpandedKitKey(null);
        setExpanded(false);
        setMode("none");
    }, [setMode]);

    const handlePickModeChange = useCallback(
        (next: unknown): void => {
            const value = Array.isArray(next) ? next[0] : next;
            if (value === "kit" || value === "tag") {
                setStampPickMode(value as StampPickMode);
            }
        },
        [setStampPickMode],
    );

    const selectKit = useCallback(
        (preset: TagPreset): void => {
            if (tagsMatchPreset(stampTags, preset)) {
                setStampTags([]);
                return;
            }
            setStampTags(preset.tags);
        },
        [setStampTags, stampTags],
    );

    if (!stampActive) {
        return null;
    }

    const stampLabel =
        activeKit?.name ??
        (stampTags.length > 0 ?
            stampTags.join(", ") :
            stampPickMode === "kit" ?
                "pick a kit" :
                "pick tags");

    return (
        <>
            <ToolFooter
                className="max-h-[45dvh]"
                icon={<Stamp className="size-3.5 shrink-0" />}
                title={`Stamp: ${stampLabel}`}
                actions={
                    <>
                        {expanded && kitListExpanded ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpandedKitKey(null)}
                            >
                                Cancel
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={exitStamp}
                        >
                            Close
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={
                                expanded ?
                                    "Collapse stamp kit" :
                                    "Expand stamp kit"
                            }
                            aria-expanded={expanded}
                            onClick={() => setExpanded((value) => !value)}
                        >
                            <ChevronDown
                                className={cn(
                                    "size-4 transition-transform",
                                    expanded && "rotate-180",
                                )}
                            />
                        </Button>
                    </>
                }
            >
                {expanded && activeKit && !kitListExpanded ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="self-start"
                        onClick={() => {
                            setStampPickMode("kit");
                            setExpandedKitKey(activeKit.id);
                        }}
                    >
                        Change kit
                    </Button>
                ) : null}
                {expanded && !(activeKit && !kitListExpanded) ? (
                    <>
                        <ToggleGroup
                            variant="outline"
                            size="sm"
                            value={[stampPickMode]}
                            onValueChange={handlePickModeChange}
                            className="w-full"
                        >
                            <ToggleGroupItem value="kit" className="flex-1">
                                Kit
                            </ToggleGroupItem>
                            <ToggleGroupItem value="tag" className="flex-1">
                                Tag
                            </ToggleGroupItem>
                        </ToggleGroup>
                        {stampPickMode === "kit" ? (
                            <KitList
                                rankedKits={rankedKits}
                                stampTags={stampTags}
                                onSelect={(preset) => {
                                    selectKit(preset);
                                    setExpandedKitKey(null);
                                }}
                            />
                        ) : (
                            <TagChips
                                tags={tagChips}
                                stampTags={stampTags}
                                onToggle={toggleStampTag}
                                onTogglePin={togglePinnedTag}
                                onOpenSheet={() => setStampSheetOpen(true)}
                            />
                        )}
                    </>
                ) : null}
            </ToolFooter>

            <TagPickerSheet
                open={stampSheetOpen}
                appliedTags={stampTags}
                knownTags={knownTags}
                pinnedTags={pinnedTags}
                batchSelectionHint="Choose tags, then tap photos to stamp them on."
                onOpenChange={(open) => {
                    setStampSheetOpen(open);
                }}
                onAddTag={(name) => {
                    setStampTags([...stampTags, name]);
                }}
                onRemoveTag={(name) => {
                    setStampTags(stampTags.filter((tag) => tag !== name));
                }}
                onTogglePinTag={togglePinnedTag}
            />
        </>
    );
}

function KitList({
    rankedKits,
    stampTags,
    onSelect,
}: {
    rankedKits: RankedKit[];
    stampTags: string[];
    onSelect: (preset: TagPreset) => void;
}): JSX.Element {
    if (rankedKits.length === 0) {
        return (
            <p className="text-xs text-muted-foreground">
                No kits yet. Create them in Manage → Tags.
            </p>
        );
    }
    return (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            {rankedKits.map(({ preset, count }) => (
                <li key={preset.id}>
                    <Button
                        type="button"
                        variant={
                            tagsMatchPreset(stampTags, preset) ?
                                "secondary" :
                                "ghost"
                        }
                        className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5"
                        onClick={() => onSelect(preset)}
                    >
                        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                            <span className="truncate text-sm font-medium">
                                {preset.name}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                                {preset.tags.join(", ")}
                            </span>
                        </span>
                        <Badge
                            variant="secondary"
                            className="shrink-0 tabular-nums"
                        >
                            {count}
                        </Badge>
                    </Button>
                </li>
            ))}
        </ul>
    );
}

function TagChips({
    tags,
    stampTags,
    onToggle,
    onTogglePin,
    onOpenSheet,
}: {
    tags: string[];
    stampTags: string[];
    onToggle: (tag: string) => void;
    onTogglePin: (tag: string) => void;
    onOpenSheet: () => void;
}): JSX.Element {
    return (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {tags.map((tag) => (
                <Button
                    key={tag}
                    type="button"
                    variant={stampTags.includes(tag) ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => onToggle(tag)}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        onTogglePin(tag);
                    }}
                >
                    {tag}
                </Button>
            ))}
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5"
                onClick={onOpenSheet}
            >
                <Tag className="size-3.5 shrink-0" />
                Tags
            </Button>
        </div>
    );
}
