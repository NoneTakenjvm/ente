import {
    useCallback,
    useMemo,
    type JSX,
} from "react";
import { Stamp, Tag } from "lucide-react";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";

/**
 * Footer for the stamp tool: choose tags/kits, then tap photos to apply.
 */
export function StampToolFooter(): JSX.Element | null {
    const stampActive = useSelectionStore((s) => s.stampActive);
    const stampTags = useSelectionStore((s) => s.stampTags);
    const stampSheetOpen = useSelectionStore((s) => s.stampSheetOpen);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const toggleStampTag = useSelectionStore((s) => s.toggleStampTag);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    const knownTags = useTagStore((s) => s.tags);
    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const recentTags = useTagSpeedStore((s) => s.recentTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);

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
        setStampActive(false);
    }, [setStampActive]);

    if (!stampActive) {
        return null;
    }

    const stampLabel =
        stampTags.length > 0 ? stampTags.join(", ") : "pick tags or a kit";

    return (
        <>
            <footer className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur">
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

                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                    {workingSetTags.map((tag) => {
                        const isStamp = stampTags.includes(tag);
                        return (
                            <Button
                                key={tag}
                                type="button"
                                variant={isStamp ? "secondary" : "outline"}
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
                    {presets.slice(0, 6).map((preset) => {
                        const isActive =
                            preset.tags.length > 0 &&
                            preset.tags.length === stampTags.length &&
                            preset.tags.every((tag) => stampTags.includes(tag));
                        return (
                            <Button
                                key={preset.id}
                                type="button"
                                variant={isActive ? "secondary" : "outline"}
                                size="sm"
                                className={cn(
                                    "h-8 shrink-0",
                                    !isActive && "border-dashed",
                                )}
                                onClick={() => {
                                    setStampTags(preset.tags);
                                }}
                            >
                                {preset.name}
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
            </footer>

            <TagPickerSheet
                open={stampSheetOpen}
                appliedTags={stampTags}
                knownTags={knownTags}
                presets={presets}
                defaultToKits={presets.length > 0}
                pinnedTags={pinnedTags}
                batchSelectionHint="Choose tags or a kit, then tap photos to stamp them on."
                onOpenChange={(open) => {
                    setStampSheetOpen(open);
                }}
                onAddTag={(name) => {
                    setStampTags([...stampTags, name]);
                }}
                onRemoveTag={(name) => {
                    setStampTags(stampTags.filter((tag) => tag !== name));
                }}
                onApplyPreset={(tags) => {
                    setStampTags(tags);
                    setStampSheetOpen(false);
                }}
                onTogglePinTag={togglePinnedTag}
            />
        </>
    );
}
