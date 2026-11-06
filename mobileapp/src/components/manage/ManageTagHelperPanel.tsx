import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";
import { TagHelperLog } from "@/components/manage/TagHelperLog";
import { PageLoader } from "@/components/PageLoader";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { ThumbnailImage } from "@/components/ThumbnailImage";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { eligibleImageFiles } from "@/lib/job-utils";
import { runKitEmbeddingJob } from "@/lib/kit-embedding";
import {
    buildKitFitModels,
    isFileUntagged,
    listUntaggedImageIds,
    rankKitsForImage,
    TAG_HELPER_MIN_MEMBERS,
    type KitFit,
    type KitFitModel,
} from "@/lib/tag-helper-fit";
import type { TagPreset } from "@/lib/tag-presets";
import { addTagNames, removeTagNames, type TagMutator } from "@/lib/tag-writes";
import { extractTags } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useSessionStore } from "@/stores/session-store";
import {
    useTagHelperStore,
    type TagHelperLogEntry,
} from "@/stores/tag-helper-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import type { EnteFile } from "ente-media/file";

interface UntaggedPhoto {
    file: EnteFile;
    queueIndex: number;
}

interface KitRow {
    fit: KitFit;
    /** The kit has fewer than {@link TAG_HELPER_MIN_MEMBERS} photos. */
    isNew: boolean;
}

interface BuiltKits {
    /** The presets these models were built from; stale once presets change. */
    presets: readonly TagPreset[];
    models: KitFitModel[];
}

/** Photos after the current one that also get a CLIP vector ahead of time. */
const PREFETCH_AHEAD_COUNT = 12;
/** Photos per background scan job. */
const PREFETCH_BATCH_SIZE = 4;
/** Horizontal drag, in px, that commits a skip (left) or a back (right). */
const SWIPE_COMMIT_PX = 64;
/** Kits 1 to 9 have keyboard shortcuts on desktop. */
const SHORTCUT_KIT_COUNT = 9;

/**
 * One background scan at a time, across panel mounts: leaving and reopening
 * the tool must not start a second job over the same photos.
 */
let embeddingJobRunning = false;

/**
 * Tag Helper: shows one untagged photo with every kit ranked by how well it
 * fits. Tapping a kit tags the photo and moves on; Skip and Back move through
 * the pass, and the Log undoes earlier tags.
 */
export function ManageTagHelperPanel(): JSX.Element {
    const userId = useSessionStore((s) => s.userID) ?? 0;
    const allFiles = useLibraryStore((s) => s.allFiles);
    const fileIndexById = useLibraryStore((s) => s.fileIndexById);
    const batchUpdateTagsOnFiles = useLibraryStore(
        (s) => s.batchUpdateTagsOnFiles,
    );
    const presenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );
    const knownTags = useTagStore((s) => s.tags);
    const presets = useTagSpeedStore((s) => s.presets);
    const pinnedTags = useTagSpeedStore((s) => s.pinnedTags);
    const togglePinnedTag = useTagSpeedStore((s) => s.togglePinnedTag);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const isCoarsePointer = useCoarsePointer();

    const queue = useTagHelperStore((s) => s.queue);
    const position = useTagHelperStore((s) => s.position);
    const steps = useTagHelperStore((s) => s.steps);
    const log = useTagHelperStore((s) => s.log);
    const startQueue = useTagHelperStore((s) => s.startQueue);
    const recordTagged = useTagHelperStore((s) => s.recordTagged);
    const recordSkipped = useTagHelperStore((s) => s.recordSkipped);
    const stepBack = useTagHelperStore((s) => s.stepBack);
    const reopenLogEntry = useTagHelperStore((s) => s.reopenLogEntry);

    const [logOpen, setLogOpen] = useState<boolean>(false);
    const [otherTagsOpen, setOtherTagsOpen] = useState<boolean>(false);
    const [otherTagDraft, setOtherTagDraft] = useState<string[]>([]);
    const [builtKits, setBuiltKits] = useState<BuiltKits | undefined>(
        undefined,
    );
    const [kitProgress, setKitProgress] = useState<
        { done: number; total: number } | undefined
    >(undefined);
    /** Bumped when a background scan ends, so the next window is checked. */
    const [embeddingRound, setEmbeddingRound] = useState<number>(0);
    /** Photos whose scan gave no vector; not retried while the panel is open. */
    const [failedEmbeddingIds, setFailedEmbeddingIds] = useState<
        ReadonlySet<number>
    >(new Set());
    const kitListRef = useRef<HTMLDivElement>(null);
    const embeddingEntries = useEmbeddingIndexStore((s) => s.entries);

    // Only the next few photos are resolved, so a tap costs the same on a
    // library of any size.
    const upcoming = useMemo(
        (): UntaggedPhoto[] =>
            queue ?
                untaggedPhotosFrom(
                    queue,
                    position,
                    PREFETCH_AHEAD_COUNT + 1,
                    allFiles,
                    fileIndexById,
                    presenceByName,
                ) :
                [],
        [queue, position, allFiles, fileIndexById, presenceByName],
    );
    const currentPhoto = upcoming[0];
    const currentFileId = currentPhoto?.file.id;
    /** Queue entries from the current photo on (photos tagged elsewhere since the pass began still count). */
    const leftCount = queue && currentPhoto ?
        queue.length - currentPhoto.queueIndex :
        0;
    const currentVector = useEmbeddingIndexStore((s) =>
        currentFileId === undefined ? undefined : s.entries.get(currentFileId));
    const currentScanFailed =
        currentFileId !== undefined && failedEmbeddingIds.has(currentFileId);
    /** The photo is still being scanned: kits would reorder under the finger, so they wait. */
    const scoringPending = currentVector === undefined && !currentScanFailed;
    const kitModels =
        builtKits?.presets === presets ? builtKits.models : undefined;

    const kitRows = useMemo((): KitRow[] => {
        if (!kitModels) {
            return [];
        }
        const memberCountById = new Map<string, number>(
            kitModels.map((model): [string, number] => [
                model.preset.id,
                model.memberCount,
            ]),
        );
        return rankKitsForImage(currentVector, kitModels).map((fit) => ({
            fit,
            isNew:
                (memberCountById.get(fit.preset.id) ?? 0) <
                TAG_HELPER_MIN_MEMBERS,
        }));
    }, [currentVector, kitModels]);

    const taggedCount = steps.filter((step) => step.kind === "tagged").length;
    const skippedCount = steps.length - taggedCount;
    const showUnscoredHint =
        currentVector !== undefined &&
        kitRows.length > 0 &&
        kitRows.every((row) => row.fit.distance === Infinity);

    useEffect(() => {
        if (useTagHelperStore.getState().queue === undefined) {
            startQueue(buildQueueFromLibrary());
        }
    }, [startQueue]);

    useEffect(() => {
        if (!embeddingHydrated) {
            return;
        }
        const controller = new AbortController();
        const { allFiles: libraryFiles } = useLibraryStore.getState();
        const { fileIdsByTag } = useTagStore.getState();
        const { entries } = useEmbeddingIndexStore.getState();
        buildKitFitModels(presets, libraryFiles, fileIdsByTag, entries, {
            signal: controller.signal,
            onProgress: (done, total) => {
                setKitProgress({ done, total });
            },
        })
            .then((models) => {
                setBuiltKits({ presets, models });
            })
            .catch((error: unknown) => {
                if (!isAbortError(error)) {
                    console.warn("[tag-helper] could not prepare kits");
                }
            });
        return (): void => {
            controller.abort();
        };
    }, [presets, embeddingHydrated]);

    // Embed the current photo and the next few untagged ones, one job at a time.
    useEffect(() => {
        if (!embeddingHydrated || embeddingJobRunning) {
            return;
        }
        const entries = embeddingEntries;
        const unscanned = eligibleImageFiles(
            upcoming.map((photo) => photo.file),
            userId,
        ).filter(
            (file) =>
                !entries.has(file.id) && !failedEmbeddingIds.has(file.id),
        );
        // The photo on screen goes alone so its kits rank at once; the rest go
        // in small batches so advancing never waits long behind one.
        const missing = unscanned[0]?.id === currentFileId ?
            unscanned.slice(0, 1) :
            unscanned.slice(0, PREFETCH_BATCH_SIZE);
        if (missing.length === 0) {
            return;
        }
        const requestedIds = missing.map((file) => file.id);
        embeddingJobRunning = true;
        runKitEmbeddingJob({
            files: missing,
            userId,
            existing: new Map(entries),
        })
            .then((result) => {
                // Merge into the live index: other scans may have landed since
                // this one took its snapshot.
                const store = useEmbeddingIndexStore.getState();
                const merged = new Map(store.entries);
                const failed: number[] = [];
                for (const fileId of requestedIds) {
                    const vector = result.get(fileId);
                    if (vector) {
                        merged.set(fileId, vector);
                    } else {
                        failed.push(fileId);
                    }
                }
                store.setEntries(merged);
                if (failed.length > 0) {
                    setFailedEmbeddingIds((ids) => new Set([...ids, ...failed]));
                }
            })
            .catch((error: unknown) => {
                setFailedEmbeddingIds((ids) => new Set([...ids, ...requestedIds]));
                console.warn("[tag-helper] could not scan photos", error);
            })
            .finally(() => {
                embeddingJobRunning = false;
                setEmbeddingRound((round) => round + 1);
            });
    }, [
        embeddingHydrated,
        upcoming,
        currentFileId,
        failedEmbeddingIds,
        embeddingEntries,
        userId,
        embeddingRound,
    ]);

    useEffect(() => {
        kitListRef.current?.scrollTo({ top: 0 });
    }, [currentFileId]);

    /** Write `mutator` to one photo. The library updates before the write lands. */
    const writePhotoTags = (
        fileId: number,
        mutator: TagMutator,
        failureMessage: string,
    ): void => {
        batchUpdateTagsOnFiles([fileId], mutator)
            .then((result) => {
                if (result.failed > 0) {
                    toast.error(failureMessage);
                }
            })
            .catch(() => {
                toast.error(failureMessage);
            });
    };

    /** Remove the tags a log entry added to its photo. */
    const removeLoggedTags = (entry: TagHelperLogEntry): void => {
        if (entry.tags.length === 0) {
            return;
        }
        writePhotoTags(
            entry.fileId,
            (current) => removeTagNames(current, ...entry.tags),
            "Could not undo tags",
        );
    };

    /** Tag the current photo with the tags it lacks, then move on. */
    const tagCurrentPhoto = (label: string, tags: string[]): void => {
        if (!currentPhoto) {
            return;
        }
        const { file, queueIndex } = currentPhoto;
        const existingTags = extractTags(file);
        const addedTags = tags.filter((tag) => !existingTags.includes(tag));
        if (addedTags.length > 0) {
            writePhotoTags(
                file.id,
                (current) => addTagNames(current, ...addedTags),
                "Could not tag photo",
            );
            navigator.vibrate?.(10);
        }
        recordTagged(file.id, queueIndex, label, addedTags);
    };

    const skipCurrentPhoto = (): void => {
        if (currentPhoto) {
            recordSkipped(currentPhoto.file.id, currentPhoto.queueIndex);
        }
    };

    const goBack = (): void => {
        const undone = stepBack();
        if (undone?.entry) {
            removeLoggedTags(undone.entry);
        }
    };

    const undoLogEntry = (entry: TagHelperLogEntry): void => {
        const reopened = reopenLogEntry(entry.id);
        if (reopened) {
            removeLoggedTags(reopened);
        }
        setLogOpen(false);
    };

    const handleOtherTagsOpenChange = (open: boolean): void => {
        setOtherTagsOpen(open);
        if (!open) {
            if (otherTagDraft.length > 0) {
                tagCurrentPhoto("Other tags", otherTagDraft);
            }
            setOtherTagDraft([]);
        }
    };

    // Re-bound on each render so the shortcuts see the current photo and kits.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (
                event.repeat ||
                event.defaultPrevented ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                logOpen ||
                otherTagsOpen ||
                isTypingTarget(event.target)
            ) {
                return;
            }
            if (/^[1-9]$/.test(event.key)) {
                const row = scoringPending ?
                    undefined :
                    kitRows[Number(event.key) - 1];
                if (row) {
                    tagCurrentPhoto(row.fit.preset.name, row.fit.preset.tags);
                }
                return;
            }
            if (
                event.key === "ArrowRight" ||
                event.key === "s" ||
                event.key === "S"
            ) {
                skipCurrentPhoto();
            } else if (event.key === "ArrowLeft" || event.key === "Backspace") {
                goBack();
            } else if (event.key === "l" || event.key === "L") {
                setLogOpen(true);
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return (): void => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    });

    if (!queue) {
        return <PageLoader message="Finding untagged photos…" />;
    }

    const hint = isCoarsePointer ?
        "Tap a kit to tag · swipe left to skip, right to go back" :
        "1–9 tag · → skip · ← back · L log";

    const renderKitList = (): JSX.Element => {
        if (!currentPhoto) {
            return (
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>All caught up</EmptyTitle>
                        <EmptyDescription>
                            {taggedCount} tagged · {skippedCount} skipped this
                            pass.
                        </EmptyDescription>
                    </EmptyHeader>
                    <Button
                        type="button"
                        onClick={() => {
                            startQueue(buildQueueFromLibrary());
                        }}
                    >
                        Start over
                    </Button>
                </Empty>
            );
        }
        if (presets.length === 0) {
            return (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                    No kits yet. Make kits in Manage → Tags, or use Other tags…
                </p>
            );
        }
        if (!kitModels) {
            return (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                    Preparing kits
                    {kitProgress ? ` ${kitProgress.done} / ${kitProgress.total}` : ""}
                    …
                </p>
            );
        }
        return (
            <>
                {scoringPending ? (
                    <p className="px-1 text-xs text-muted-foreground">
                        Scanning photo…
                    </p>
                ) : null}
                {currentScanFailed ? (
                    <p className="px-1 text-xs text-muted-foreground">
                        Couldn't scan this photo; kits are in their usual order.
                    </p>
                ) : null}
                {showUnscoredHint ? (
                    <p className="px-1 text-xs text-muted-foreground">
                        Run Manage → Settings → Scan CLIP embeddings for better
                        suggestions.
                    </p>
                ) : null}
                {kitRows.map((row, index) => (
                    <KitButton
                        key={row.fit.preset.id}
                        row={row}
                        shortcut={
                            !isCoarsePointer && index < SHORTCUT_KIT_COUNT ?
                                index + 1 :
                                undefined
                        }
                        highlighted={index === 0 && currentVector !== undefined}
                        disabled={scoringPending}
                        onPick={() => {
                            tagCurrentPhoto(row.fit.preset.name, row.fit.preset.tags);
                        }}
                    />
                ))}
            </>
        );
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {currentPhoto ? (
                <SwipePhoto
                    file={currentPhoto.file}
                    onSkip={skipCurrentPhoto}
                    onBack={goBack}
                />
            ) : null}

            <section
                className={cn(
                    "flex min-h-0 flex-1 flex-col",
                    currentPhoto &&
                        "md:w-96 md:flex-none md:border-l md:border-border lg:w-[28rem]",
                )}
            >
                <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
                    <p className="text-sm tabular-nums">
                        {leftCount.toLocaleString()} left · {taggedCount}{" "}
                        tagged
                    </p>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setLogOpen(true);
                        }}
                    >
                        Log{log.length > 0 ? ` (${log.length})` : ""}
                    </Button>
                </div>
                <p className="shrink-0 px-4 pt-1 pb-2 text-xs text-muted-foreground">
                    {hint}
                </p>
                <div
                    ref={kitListRef}
                    className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-3 pb-3"
                >
                    {renderKitList()}
                </div>
                <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-border p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                    <Button
                        type="button"
                        variant="outline"
                        className="h-11"
                        disabled={steps.length === 0}
                        onClick={goBack}
                    >
                        Back
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        className="h-11"
                        disabled={!currentPhoto}
                        onClick={() => {
                            setOtherTagsOpen(true);
                        }}
                    >
                        Other tags…
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        className="h-11"
                        disabled={!currentPhoto}
                        onClick={skipCurrentPhoto}
                    >
                        Skip
                    </Button>
                </div>
            </section>

            <TagHelperLog
                open={logOpen}
                entries={log}
                onOpenChange={setLogOpen}
                onUndo={undoLogEntry}
            />
            <TagPickerSheet
                open={otherTagsOpen}
                appliedTags={otherTagDraft}
                knownTags={knownTags}
                pinnedTags={pinnedTags}
                batchSelectionHint="Pick tags for this photo. Closing applies them."
                onOpenChange={handleOtherTagsOpenChange}
                onAddTag={(name) => {
                    setOtherTagDraft((draft) =>
                        draft.includes(name) ? draft : [...draft, name]);
                }}
                onRemoveTag={(name) => {
                    setOtherTagDraft((draft) =>
                        draft.filter((tag) => tag !== name));
                }}
                onTogglePinTag={togglePinnedTag}
            />
        </div>
    );
}

/**
 * The current photo. A horizontal drag follows the finger: a left swipe past
 * the threshold skips, a right swipe goes back, and a shorter drag springs back.
 */
function SwipePhoto({
    file,
    onSkip,
    onBack,
}: {
    file: EnteFile;
    onSkip: () => void;
    onBack: () => void;
}): JSX.Element {
    const [dragX, setDragX] = useState<number>(0);
    const swipeStart = useRef<
        { pointerId: number; x: number; y: number } | undefined
    >(undefined);
    const dragXRef = useRef<number>(0);

    const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const start = swipeStart.current;
        if (start?.pointerId !== event.pointerId) {
            return;
        }
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        // A vertical-dominant move is scrolling, not a swipe.
        const nextX = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0;
        dragXRef.current = nextX;
        setDragX(nextX);
    };

    const finishSwipe = (
        event: ReactPointerEvent<HTMLDivElement>,
        committed: boolean,
    ): void => {
        const start = swipeStart.current;
        if (start?.pointerId !== event.pointerId) {
            return;
        }
        swipeStart.current = undefined;
        const finalX = dragXRef.current;
        dragXRef.current = 0;
        setDragX(0);
        if (!committed) {
            return;
        }
        if (finalX < -SWIPE_COMMIT_PX) {
            onSkip();
        } else if (finalX > SWIPE_COMMIT_PX) {
            onBack();
        }
    };

    return (
        <div className="relative flex min-h-0 shrink-0 basis-[45%] overflow-hidden bg-muted/40 select-none md:flex-1">
            <div
                className={cn(
                    "size-full touch-pan-y p-3",
                    dragX === 0 && "transition-transform duration-200 ease-out",
                )}
                style={{
                    transform:
                        dragX === 0 ?
                            undefined :
                            `translateX(${dragX}px) rotate(${dragX / 40}deg)`,
                }}
                // A native image drag would cancel the pointer and the swipe.
                onDragStart={(event) => {
                    event.preventDefault();
                }}
                onPointerDown={(event) => {
                    // Keep receiving moves when a mouse drag leaves the photo.
                    event.currentTarget.setPointerCapture(event.pointerId);
                    swipeStart.current = {
                        pointerId: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                    };
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => {
                    finishSwipe(event, true);
                }}
                onPointerCancel={(event) => {
                    finishSwipe(event, false);
                }}
            >
                <ThumbnailImage file={file} contain />
            </div>
            <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-muted-foreground">
                {captionDate(file.metadata.creationTime)}
            </p>
        </div>
    );
}

/** One kit as a full-width tap target, with its match on the right. */
function KitButton({
    row,
    shortcut,
    highlighted,
    disabled,
    onPick,
}: {
    row: KitRow;
    /** Desktop keyboard key (1 to 9) for this kit. */
    shortcut: number | undefined;
    highlighted: boolean;
    disabled: boolean;
    onPick: () => void;
}): JSX.Element {
    const { preset } = row.fit;
    const tagsLabel = preset.tags.join(", ");
    const match = kitMatchLabel(row);
    return (
        <Button
            type="button"
            variant="outline"
            className={cn(
                "h-auto min-h-11 w-full justify-start gap-3 px-3 py-2 text-left",
                highlighted && "border-primary bg-primary/10",
            )}
            disabled={disabled}
            onClick={onPick}
        >
            {shortcut === undefined ? null : (
                <kbd className="shrink-0 rounded border border-border px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
                    {shortcut}
                </kbd>
            )}
            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="w-full truncate font-medium">{preset.name}</span>
                {tagsLabel === preset.name ? null : (
                    <span className="w-full truncate text-xs font-normal text-muted-foreground">
                        {tagsLabel}
                    </span>
                )}
            </span>
            {match === undefined ? null : (
                <span className="shrink-0 text-sm font-normal tabular-nums text-muted-foreground">
                    {match}
                </span>
            )}
        </Button>
    );
}

/** Up to `limit` photos still in the library and untagged, from `fromIndex` on, in queue order. */
const untaggedPhotosFrom = (
    queue: readonly number[],
    fromIndex: number,
    limit: number,
    allFiles: readonly EnteFile[],
    fileIndexById: ReadonlyMap<number, number>,
    presenceByName: ReadonlyMap<string, boolean>,
): UntaggedPhoto[] => {
    const photos: UntaggedPhoto[] = [];
    for (
        let queueIndex = fromIndex;
        queueIndex < queue.length && photos.length < limit;
        queueIndex += 1
    ) {
        const fileIndex = fileIndexById.get(queue[queueIndex]!);
        const file = fileIndex === undefined ? undefined : allFiles[fileIndex];
        if (file && isFileUntagged(file, presenceByName)) {
            photos.push({ file, queueIndex });
        }
    }
    return photos;
};

/** Every untagged image in the library, newest first: the queue for a fresh pass. */
const buildQueueFromLibrary = (): number[] =>
    listUntaggedImageIds(
        useLibraryStore.getState().allFiles,
        useSessionStore.getState().userID ?? 0,
        useTagStore.getState().typeConfig.includeInEffectsPresenceByName,
    );

/** The match shown on a kit row: "new" for small kits, nothing when unscored. */
const kitMatchLabel = (row: KitRow): string | undefined => {
    if (row.isNew) {
        return "new";
    }
    if (row.fit.match === undefined) {
        return undefined;
    }
    return `${Math.round(row.fit.match * 100)}%`;
};

const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === "AbortError";

/** Keyboard shortcuts stay out of the way while the user types. */
const isTypingTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Photo date for the caption; the file's creation time is in microseconds. */
const captionDate = (creationTimeMicros: number): string =>
    new Date(creationTimeMicros / 1000).toLocaleDateString(undefined, {
        dateStyle: "medium",
    });
