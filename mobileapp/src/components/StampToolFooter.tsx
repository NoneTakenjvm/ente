import {
    useCallback,
    useMemo,
    useState,
    type JSX,
} from "react";
import { Stamp, Tag } from "lucide-react";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    countFilesMatchingKit,
    type TagPreset,
} from "@/lib/tag-presets";
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
const tagsMatchPreset = (tags: string[], preset: TagPreset): boolean => {
    if (tags.length === 0 || tags.length !== preset.tags.length) {
        return false;
    }
    return preset.tags.every((tag) => tags.includes(tag));
};

/**
 * Footer for the stamp tool: Kit or Tag pick mode, then tap photos to apply.
 */
export function StampToolFooter(): JSX.Element | null {
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const stampPickMode = useSelectionStore((s) => s.stampPickMode);
    const stampSheetOpen = useSelectionStore((s) => s.stampSheetOpen);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
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

    const rankedKits = useMemo((): RankedKit[] => {
        if (!presets.length) {
            return [];
        }
        const scored = presets.map((preset) => ({
            preset,
            count: countFilesMatchingKit(allFiles, preset.tags),
        }));
        scored.sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return a.preset.name.localeCompare(b.preset.name);
        });
        return scored;
    }, [allFiles, presets]);

    const activeKit = useMemo((): TagPreset | undefined => {
        if (!stampTags.length) {
            return undefined;
        }
        return presets.find((preset) => tagsMatchPreset(stampTags, preset));
    }, [presets, stampTags]);

    const activeKitKey = activeKit?.id ?? null;
    const kitListExpanded =
        activeKitKey !== null && expandedKitKey === activeKitKey;

    const workingSetTags = useMemo((): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const tag of [...stampTags, ...pinnedTags, ...recentTags]) {
            if (seen.has(tag)) {
                continue;
            }
            seen.add(tag);
            result.push(tag);
        }
        return result.slice(0, 16);
    }, [pinnedTags, recentTags, stampTags]);

    const exitStamp = useCallback((): void => {
        setExpandedKitKey(null);
        setStampActive(false);
    }, [setStampActive]);

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
            <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex max-h-[45dvh] flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur">
                <div className="flex items-center justify-between gap-2">
                    <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-muted-foreground">
                        <Stamp className="size-3.5 shrink-0" />
                        <span className="truncate">Stamp: {stampLabel}</span>
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={exitStamp}
                    >
                        Done
                    </Button>
                </div>

                {activeKit && !kitListExpanded ? (
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
                ) : (
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
                            rankedKits.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    No kits yet. Create them in Manage → Tags.
                                </p>
                            ) : (
                                <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain">
                                    {rankedKits.map(({ preset, count }) => {
                                        const selected = tagsMatchPreset(
                                            stampTags,
                                            preset,
                                        );
                                        return (
                                            <li key={preset.id}>
                                                <Button
                                                    type="button"
                                                    variant={
                                                        selected ?
                                                            "secondary" :
                                                            "ghost"
                                                    }
                                                    className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5"
                                                    onClick={() => {
                                                        selectKit(preset);
                                                        setExpandedKitKey(null);
                                                    }}
                                                >
                                                    <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                                                        <span className="truncate text-sm font-medium">
                                                            {preset.name}
                                                        </span>
                                                        <span className="truncate text-xs text-muted-foreground">
                                                            {preset.tags.join(
                                                                ", ",
                                                            )}
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
                                        );
                                    })}
                                </ul>
                            )
                        ) : (
                            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                                {workingSetTags.map((tag) => {
                                    const isStamp = stampTags.includes(tag);
                                    return (
                                        <Button
                                            key={tag}
                                            type="button"
                                            variant={
                                                isStamp ? "secondary" : "outline"
                                            }
                                            size="sm"
                                            className="h-8 shrink-0"
                                            onClick={() => {
                                                toggleStampTag(tag);
                                            }}
                                            onContextMenu={(event) => {
                                                event.preventDefault();
                                                togglePinnedTag(tag);
                                            }}
                                        >
                                            {tag}
                                        </Button>
                                    );
                                })}
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 shrink-0 gap-1.5"
                                    onClick={() => setStampSheetOpen(true)}
                                >
                                    <Tag className="size-3.5 shrink-0" />
                                    Tags
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </footer>

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
