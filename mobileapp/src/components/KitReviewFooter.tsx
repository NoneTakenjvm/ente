import { useMemo, useState, type JSX } from "react";
import { ListChecks } from "lucide-react";
import { KitList } from "@/components/KitList";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { ToolFooter } from "@/components/ToolFooter";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
    applyKitReview,
    confirmDiscardReviewMarks,
    countUnembeddedImages,
    embedKitReviewCandidates,
    exitKitReview,
    markRestReviewNo,
    markReviewWithUndo,
    startKitReview,
} from "@/lib/kit-review";
import { KIT_MATCH_MIN_MEMBERS } from "@/lib/kit-nearness-margins";
import { rankPresetsByMatchCount, type TagPreset } from "@/lib/tag-presets";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { useUIStore } from "@/stores/ui-store";
import type { EnteFile } from "ente-media/file";

/**
 * Starting match cutoff (%): photos that score at least as well as half the
 * kit's own tagged photos.
 */
const DEFAULT_MATCH_CUTOFF = 50;

/** Lowest cutoff the slider offers; below this nearly everything matches. */
const MATCH_CUTOFF_MIN = 5;

/**
 * Footer for the kit review tool: pick a kit, then stage yes/no marks on the
 * ranked photos and Apply. Renders only while the review mode is active.
 */
export function KitReviewFooter({ files }: { files: EnteFile[] }): JSX.Element | null {
    const active = useSelectionStore((s) => s.mode === "kitReview");
    return active ? <ActiveKitReviewFooter files={files} /> : null;
}

/** Footer body; remounts on each activation so the picker state starts fresh. */
function ActiveKitReviewFooter({ files }: { files: EnteFile[] }): JSX.Element {
    const reviewKitId = useSelectionStore((s) => s.reviewKitId);
    const reviewMarks = useSelectionStore((s) => s.reviewMarks);
    const clearReviewMarks = useSelectionStore((s) => s.clearReviewMarks);
    const rejectedCount = useUIStore((s) =>
        reviewKitId ?
            (s.kitReviewRejectedIds.get(reviewKitId)?.size ?? 0) :
            0);
    const embeddings = useEmbeddingIndexStore((s) => s.entries);
    const matchById = useUIStore((s) => s.kitReviewMatchById);
    const allFiles = useLibraryStore((s) => s.allFiles);
    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);
    const knownTags = useTagStore((s) => s.tags);

    const [changingKit, setChangingKit] = useState<boolean>(false);
    const [kitSheetOpen, setKitSheetOpen] = useState<boolean>(false);
    const [newKitTags, setNewKitTags] = useState<string[]>([]);
    const [scanBusy, setScanBusy] = useState<boolean>(false);
    const [matchCutoff, setMatchCutoff] = useState<number>(
        DEFAULT_MATCH_CUTOFF,
    );

    const kit: TagPreset | undefined = presets.find(
        (preset) => preset.id === reviewKitId,
    );
    const rankedKits = useMemo(
        () => rankPresetsByMatchCount(presets, allFiles),
        [allFiles, presets],
    );
    const { yes, no } = useMemo(() => {
        const marks = [...reviewMarks.values()];
        return {
            yes: marks.filter((mark) => mark === "yes").length,
            no: marks.filter((mark) => mark === "no").length,
        };
    }, [reviewMarks]);
    const unembeddedCount = useMemo(
        () => countUnembeddedImages(files, embeddings),
        [embeddings, files],
    );
    /** Unmarked photos at or above the match cutoff, in grid order. */
    const cutoffIds = useMemo((): number[] => {
        if (!matchById) {
            return [];
        }
        // Compare the rounded percent the tiles show, so a "70%" tile is in
        // "≥ 70%" (the raw float32 fraction can sit just below it).
        return files
            .filter(
                (file) =>
                    !reviewMarks.has(file.id) &&
                    Math.round((matchById.get(file.id) ?? Number.NaN) * 100) >=
                        matchCutoff,
            )
            .map((file) => file.id);
    }, [files, matchById, matchCutoff, reviewMarks]);

    const pickKit = (preset: TagPreset): void => {
        startKitReview(preset);
        setChangingKit(false);
    };

    const handleKitSheetOpenChange = (open: boolean): void => {
        setKitSheetOpen(open);
        if (open || newKitTags.length === 0) {
            return;
        }
        const preset = useTagSpeedStore
            .getState()
            .addPreset(newKitTags.join(" + "), newKitTags);
        setNewKitTags([]);
        if (preset) {
            pickKit(preset);
        }
    };

    const handleScan = async (): Promise<void> => {
        setScanBusy(true);
        try {
            await embedKitReviewCandidates(files);
        } catch (error: unknown) {
            console.warn("Kit review scan failed", error);
        } finally {
            setScanBusy(false);
        }
    };

    if (!kit || changingKit) {
        return (
            <>
                <ToolFooter
                    icon={<ListChecks className="size-3.5 shrink-0" />}
                    title="Review: pick a kit"
                    actions={
                        <>
                            {kit ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setChangingKit(false)}
                                >
                                    Cancel
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={exitKitReview}
                            >
                                Close
                            </Button>
                        </>
                    }
                >
                    <KitList
                        rankedKits={rankedKits}
                        isActive={(preset) => preset.id === reviewKitId}
                        onSelect={pickKit}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => setKitSheetOpen(true)}
                    >
                        New kit
                    </Button>
                </ToolFooter>
                <TagPickerSheet
                    open={kitSheetOpen}
                    appliedTags={newKitTags}
                    knownTags={knownTags}
                    pinnedTags={pinnedTags}
                    batchSelectionHint="Choose tags for the new kit, then close to start reviewing."
                    onOpenChange={handleKitSheetOpenChange}
                    onAddTag={(name) => {
                        setNewKitTags([...newKitTags, name]);
                    }}
                    onRemoveTag={(name) => {
                        setNewKitTags(newKitTags.filter((tag) => tag !== name));
                    }}
                    onTogglePinTag={togglePinnedTag}
                />
            </>
        );
    }

    const marked = yes + no > 0;

    return (
        <ToolFooter
            icon={<ListChecks className="size-3.5 shrink-0" />}
            title={`${kit.name} · ${yes} yes · ${no} no`}
            actions={
                <>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setChangingKit(true)}
                    >
                        Kit
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={exitKitReview}
                    >
                        Close
                    </Button>
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={!marked}
                        onClick={() => void applyKitReview()}
                    >
                        Apply
                    </Button>
                </>
            }
        >
            <p className="text-xs text-muted-foreground">
                {files.length === 0 ?
                    "Nothing left to review here." :
                    `${files.length} to review · tap: yes → no → clear · hold: yes up to here`}
                {files.length > 0 && !matchById ?
                    ` · match % shows once ${KIT_MATCH_MIN_MEMBERS}+ photos have the kit` :
                    null}
            </p>
            {matchById && files.length > 0 ? (
                <div className="flex items-center gap-3">
                    <Slider
                        className="flex-1"
                        aria-label="Kit match cutoff"
                        min={MATCH_CUTOFF_MIN}
                        max={100}
                        step={5}
                        value={[matchCutoff]}
                        onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (typeof next === "number") {
                                setMatchCutoff(next);
                            }
                        }}
                    />
                    <FooterChip
                        label={`Yes to ${cutoffIds.length} ≥ ${matchCutoff}%`}
                        title="Mark every unmarked photo with at least this kit match as yes"
                        disabled={cutoffIds.length === 0}
                        onClick={() => markReviewWithUndo(cutoffIds, "yes")}
                    />
                </div>
            ) : null}
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {marked ? (
                    <>
                        <FooterChip
                            label="Rest no"
                            title="Mark every unmarked photo above your last mark as no"
                            onClick={() =>
                                markRestReviewNo(files.map((file) => file.id))}
                        />
                        <FooterChip
                            label="Clear marks"
                            onClick={() => {
                                if (confirmDiscardReviewMarks()) {
                                    clearReviewMarks();
                                }
                            }}
                        />
                    </>
                ) : null}
                {unembeddedCount > 0 ? (
                    <FooterChip
                        label={`Scan ${unembeddedCount} new`}
                        title="Photos without a CLIP scan rank last until scanned"
                        disabled={scanBusy}
                        onClick={() => void handleScan()}
                    />
                ) : null}
                {rejectedCount > 0 ? (
                    <FooterChip
                        label={`Restore ${rejectedCount} skipped`}
                        onClick={() => {
                            const ui = useUIStore.getState();
                            ui.clearKitReviewRejections(kit.id);
                            ui.reapplyNearness();
                        }}
                    />
                ) : null}
            </div>
        </ToolFooter>
    );
}

/** Small secondary action under the review footer title. */
function FooterChip({
    label,
    title,
    disabled,
    onClick,
}: {
    label: string;
    title?: string;
    disabled?: boolean;
    onClick: () => void;
}): JSX.Element {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            title={title}
            disabled={disabled}
            onClick={onClick}
        >
            {label}
        </Button>
    );
}
