import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type JSX,
} from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import {
    DEFAULT_TAG_TYPE,
    isTagIncludedInEffectsPresence,
    isTagIncludedInKitNearness,
    normalizeTagTypeName,
    tagsGroupedByType,
    typeForTag,
} from "@/lib/tag-types";
import {
    suggestTagKits,
    type TagKitSuggestion,
} from "@/lib/tag-presets";
import { normalizeTagName } from "@/lib/tag-writes";
import { isReservedTag } from "@/lib/tags";
import {
    runKitNearnessTune,
    type KitNearnessTuneProgress,
} from "@/lib/kit-nearness-embedding-tune";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useTagStore } from "@/stores/tag-store";
import { Tags, Plus } from "lucide-react";

export function ManageTagsPanel(): JSX.Element {
    const tags = useTagStore((s) => s.tags);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const includeInKitNearnessByName = useTagStore(
        (s) => s.includeInKitNearnessByName,
    );
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );
    const setTagType = useTagStore((s) => s.setTagType);
    const setIncludeInKitNearness = useTagStore(
        (s) => s.setIncludeInKitNearness,
    );
    const setIncludeInEffectsPresence = useTagStore(
        (s) => s.setIncludeInEffectsPresence,
    );
    const ensureTagType = useTagStore((s) => s.ensureTagType);
    const registerTag = useTagStore((s) => s.registerTag);
    const allFiles = useLibraryStore((s) => s.allFiles);
    const renameTag = useLibraryStore((s) => s.renameTag);
    const deleteTag = useLibraryStore((s) => s.deleteTag);
    const mergeTags = useLibraryStore((s) => s.mergeTags);

    const presets = useTagSpeedStore((s) => s.presets);
    const addPreset = useTagSpeedStore((s) => s.addPreset);
    const updatePreset = useTagSpeedStore((s) => s.updatePreset);
    const deletePreset = useTagSpeedStore((s) => s.deletePreset);

    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.hydrate);

    const [renameTarget, setRenameTarget] = useState<string | undefined>();
    const [renameValue, setRenameValue] = useState<string>("");
    const [mergeSources, setMergeSources] = useState<string[]>([]);
    const [mergeTarget, setMergeTarget] = useState<string>("");
    const [tuningPresetId, setTuningPresetId] = useState<string | undefined>();
    const [tuneProgress, setTuneProgress] = useState<
        KitNearnessTuneProgress | undefined
    >();
    const tuneAbort = useRef<AbortController | undefined>(undefined);
    const [deleteTarget, setDeleteTarget] = useState<string | undefined>();
    const [progress, setProgress] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [newTypeName, setNewTypeName] = useState<string>("");
    const [newTagName, setNewTagName] = useState<string>("");
    const [newTagType, setNewTagType] = useState<string>("");
    const [presetName, setPresetName] = useState<string>("");
    const [presetTags, setPresetTags] = useState<string[]>([]);
    const [renamingPresetId, setRenamingPresetId] = useState<string | undefined>(
        undefined,
    );
    const [renameDraft, setRenameDraft] = useState<string>("");
    const [suggestionsOpen, setSuggestionsOpen] = useState<boolean>(false);
    const [kitSuggestions, setKitSuggestions] = useState<TagKitSuggestion[]>(
        [],
    );

    const userTags = useMemo(
        (): string[] => tags.filter((tag) => !isReservedTag(tag)),
        [tags],
    );

    const tagGroups = useMemo(
        () =>
            tagsGroupedByType(
                userTags,
                tagTypes,
                tagTypeByName,
                fileIdsByTag,
            ),
        [userTags, tagTypes, tagTypeByName, fileIdsByTag],
    );

    const runWithProgress = useCallback(
        async (label: string, task: () => Promise<{ failed: number; errors: string[] }>): Promise<void> => {
            setError(undefined);
            setProgress(`${label}…`);
            try {
                const result = await task();
                if (result.failed > 0) {
                    setError(
                        `${result.failed} failed. ${result.errors.slice(0, 3).join("; ")}`,
                    );
                }
            } catch (taskError) {
                setError(
                    taskError instanceof Error ?
                        taskError.message :
                        "Operation failed",
                );
            } finally {
                setProgress(undefined);
            }
        },
        [],
    );

    const handleRenameStart = (tag: string): void => {
        setRenameTarget(tag);
        setRenameValue(tag);
        setError(undefined);
    };

    const handleRenameSubmit = (event: FormEvent): void => {
        event.preventDefault();
        if (!renameTarget) {
            return;
        }
        const newName = normalizeTagName(renameValue);
        if (!newName || newName === renameTarget) {
            setRenameTarget(undefined);
            return;
        }
        void runWithProgress(`Renaming "${renameTarget}"`, () => renameTag(renameTarget, newName, (completed, total) => {
            setProgress(`Renaming… ${completed} / ${total}`);
        })).then(() => {
            setRenameTarget(undefined);
        });
    };

    const handleConfirmDelete = (): void => {
        if (!deleteTarget) {
            return;
        }
        const tag = deleteTarget;
        setDeleteTarget(undefined);
        void runWithProgress(`Removing "${tag}"`, () => deleteTag(tag, (completed, total) => {
            setProgress(`Removing… ${completed} / ${total}`);
        }));
    };

    const handleAddType = (event: FormEvent): void => {
        event.preventDefault();
        const type = normalizeTagTypeName(newTypeName);
        if (!type) {
            return;
        }
        ensureTagType(type);
        setNewTypeName("");
    };

    const handleCreateTag = (event: FormEvent): void => {
        event.preventDefault();
        setError(undefined);
        const type =
            normalizeTagTypeName(newTagType) ?? DEFAULT_TAG_TYPE;
        const created = registerTag(newTagName, type);
        if (!created) {
            const name = normalizeTagName(newTagName);
            if (!name) {
                setError("Enter a tag name.");
            } else if (isReservedTag(name)) {
                setError("That tag name is reserved.");
            } else {
                setError("That tag already exists.");
            }
            return;
        }
        setNewTagName("");
        setNewTagType("");
    };

    const renderTagRow = (tag: string): JSX.Element => {
        const count = fileIdsByTag.get(tag)?.size ?? 0;
        return (
            <div
                key={tag}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
                {renameTarget === tag ? (
                    <form
                        className="flex flex-1 flex-col gap-2 sm:flex-row"
                        onSubmit={handleRenameSubmit}
                    >
                        <Input
                            value={renameValue}
                            onChange={(event) =>
                                setRenameValue(event.target.value)
                            }
                            autoFocus
                        />
                        <div className="flex gap-2">
                            <Button type="submit" size="sm">
                                Save
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setRenameTarget(undefined)}
                            >
                                Cancel
                            </Button>
                        </div>
                    </form>
                ) : (
                    <>
                        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-medium">
                                    {tag}
                                </span>
                                <Badge variant="secondary">{count}</Badge>
                            </div>
                            <select
                                className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
                                value={typeForTag(tag, tagTypeByName)}
                                onChange={(event) => {
                                    setTagType(tag, event.target.value);
                                }}
                            >
                                {tagTypes.map((type) => (
                                    <option key={type} value={type}>
                                        {type}
                                    </option>
                                ))}
                            </select>
                            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                <Switch
                                    checked={isTagIncludedInKitNearness(
                                        tag,
                                        includeInKitNearnessByName,
                                    )}
                                    onCheckedChange={(checked) => {
                                        setIncludeInKitNearness(tag, checked);
                                    }}
                                    aria-label={`Include ${tag} in kit nearness`}
                                />
                                Kit nearness
                            </label>
                            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                <Switch
                                    checked={isTagIncludedInEffectsPresence(
                                        tag,
                                        includeInEffectsPresenceByName,
                                    )}
                                    onCheckedChange={(checked) => {
                                        setIncludeInEffectsPresence(
                                            tag,
                                            checked,
                                        );
                                    }}
                                    aria-label={`Include ${tag} in effects presence`}
                                />
                                Effects presence
                            </label>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleRenameStart(tag)}
                            >
                                Rename
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                onClick={() => setDeleteTarget(tag)}
                            >
                                Delete
                            </Button>
                        </div>
                    </>
                )}
            </div>
        );
    };

    const handleMergeSubmit = (event: FormEvent): void => {
        event.preventDefault();
        const target = normalizeTagName(mergeTarget);
        if (!target || mergeSources.length < 2) {
            setError("Pick at least two tags and enter a target name.");
            return;
        }
        void runWithProgress(`Merging into "${target}"`, () => mergeTags(mergeSources, target, (completed, total) => {
            setProgress(`Merging… ${completed} / ${total}`);
        })).then(() => {
            setMergeSources([]);
            setMergeTarget("");
        });
    };

    const handleCreatePreset = (event: FormEvent): void => {
        event.preventDefault();
        setError(undefined);
        const created = addPreset(presetName, presetTags);
        if (!created) {
            setError("Preset needs a name and at least one tag.");
            return;
        }
        setPresetName("");
        setPresetTags([]);
    };

    const beginRenamePreset = (id: string, currentName: string): void => {
        setRenamingPresetId(id);
        setRenameDraft(currentName);
    };

    const commitRenamePreset = (): void => {
        if (!renamingPresetId) {
            return;
        }
        const next = renameDraft.trim();
        if (next) {
            updatePreset(renamingPresetId, { name: next });
        }
        setRenamingPresetId(undefined);
        setRenameDraft("");
    };

    const cancelRenamePreset = (): void => {
        setRenamingPresetId(undefined);
        setRenameDraft("");
    };

    const handleCancelTune = (): void => {
        tuneAbort.current?.abort();
        tuneAbort.current = undefined;
        setTuningPresetId(undefined);
        setTuneProgress(undefined);
    };

    const handleClearTune = (presetId: string): void => {
        updatePreset(presetId, { nearnessTune: null });
        toast.message("Cleared kit nearness tune — using global defaults");
    };

    const handleTunePreset = (presetId: string): void => {
        if (tuningPresetId) {
            return;
        }
        const preset = presets.find((entry) => entry.id === presetId);
        if (!preset) {
            return;
        }
        void (async (): Promise<void> => {
            if (!embeddingHydrated) {
                await hydrateEmbeddings();
            }
            const embeddings = useEmbeddingIndexStore.getState().entries;
            if (embeddings.size < 20) {
                toast.message(
                    "Run Manage → Settings → Scan CLIP embeddings before tuning",
                );
                return;
            }
            tuneAbort.current?.abort();
            const abort = new AbortController();
            tuneAbort.current = abort;
            setTuningPresetId(presetId);
            setTuneProgress({
                phase: "setup",
                label: "Starting…",
                current: 0,
                total: 1,
            });
            try {
                const result = await runKitNearnessTune({
                    libraryFiles: allFiles,
                    kitTags: preset.tags,
                    kitId: preset.id,
                    embeddings,
                    rivalKits: presets.map((entry) => ({
                        id: entry.id,
                        tags: entry.tags,
                        genome: entry.nearnessTune?.genome,
                    })),
                    signal: abort.signal,
                    onProgress: setTuneProgress,
                });
                if (abort.signal.aborted) {
                    return;
                }
                if (result) {
                    updatePreset(presetId, { nearnessTune: result });
                    toast.success(
                        `Tuned “${preset.name}” — fitness ${(result.fitness * 100).toFixed(1)}% (default ${(result.baselineFitness * 100).toFixed(1)}%)`,
                    );
                } else {
                    updatePreset(presetId, { nearnessTune: null });
                    toast.message(
                        `No clear gain for “${preset.name}” — keeping global defaults`,
                    );
                }
            } catch (error: unknown) {
                if (
                    error instanceof DOMException &&
                    error.name === "AbortError"
                ) {
                    toast.message("Tune cancelled");
                    return;
                }
                toast.error(
                    error instanceof Error ? error.message : "Tune failed",
                );
            } finally {
                if (tuneAbort.current === abort) {
                    tuneAbort.current = undefined;
                    setTuningPresetId(undefined);
                    setTuneProgress(undefined);
                }
            }
        })();
    };

    const handleOpenSuggestions = (): void => {
        setError(undefined);
        setKitSuggestions(
            suggestTagKits(allFiles, {
                existingPresets: presets,
                includeInKitNearnessByName,
            }),
        );
        setSuggestionsOpen(true);
    };

    const handleAddSuggestion = (suggestion: TagKitSuggestion): void => {
        const created = addPreset(suggestion.name, suggestion.tags);
        if (!created) {
            setError("Could not add that kit.");
            return;
        }
        setKitSuggestions((current) =>
            current.filter(
                (entry) =>
                    entry.tags.join("\0") !== suggestion.tags.join("\0"),
            ));
    };

    const presetTagChoices = useMemo(
        (): string[] =>
            userTags.filter((tag) => !presetTags.includes(tag)),
        [userTags, presetTags],
    );

    return (
        <div className="flex flex-col gap-4 px-4 py-4">
            {progress ? (
                <Alert>
                    <AlertDescription>{progress}</AlertDescription>
                </Alert>
            ) : null}
            {error ? (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>Your tags</CardTitle>
                    <CardDescription>
                        Create tags, assign types, rename, or remove tags
                        across your library.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <form
                        className="flex items-center gap-2"
                        onSubmit={handleCreateTag}
                    >
                        <Button
                            type="submit"
                            variant="outline"
                            size="icon-sm"
                            disabled={!newTagName.trim()}
                            aria-label="Create tag"
                        >
                            <Plus />
                        </Button>
                        <Input
                            placeholder="New tag name"
                            value={newTagName}
                            className="min-w-0 flex-1"
                            onChange={(event) => {
                                setNewTagName(event.target.value);
                            }}
                        />
                        <Input
                            placeholder="Type (optional)"
                            value={newTagType}
                            className="w-28 shrink-0"
                            onChange={(event) => {
                                setNewTagType(event.target.value);
                            }}
                        />
                    </form>
                    <form
                        className="flex items-center gap-2"
                        onSubmit={handleAddType}
                    >
                        <Input
                            placeholder="New type name"
                            value={newTypeName}
                            className="min-w-0 flex-1"
                            onChange={(event) => {
                                setNewTypeName(event.target.value);
                            }}
                        />
                        <Button
                            type="submit"
                            variant="outline"
                            size="sm"
                            disabled={!newTypeName.trim()}
                        >
                            Add type
                        </Button>
                    </form>
                    {userTags.length === 0 ? (
                        <Empty className="border-0 p-4">
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <Tags />
                                </EmptyMedia>
                                <EmptyTitle>No tags yet</EmptyTitle>
                                <EmptyDescription>
                                    Create a tag above or add tags from a photo
                                    in the gallery.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : (
                        tagGroups.map((group) => (
                            <div
                                key={group.type}
                                className="flex flex-col gap-2"
                            >
                                <h3 className="text-sm font-medium text-muted-foreground capitalize">
                                    {group.type}
                                </h3>
                                {group.tags.map((tag) => renderTagRow(tag))}
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Tag presets</CardTitle>
                    <CardDescription>
                        Named kits for stamp / nearness. Tune nearness runs a
                        short holdout grid on that kit’s CLIP embeddings and
                        keeps kit-specific params only when they beat the
                        global default.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <form
                        className="flex flex-col gap-2"
                        onSubmit={handleCreatePreset}
                    >
                        <Input
                            placeholder="Preset name (e.g. Vietnam trip)"
                            value={presetName}
                            onChange={(event) => {
                                setPresetName(event.target.value);
                            }}
                        />
                        {presetTags.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {presetTags.map((tag) => (
                                    <Badge
                                        key={tag}
                                        variant="secondary"
                                        className="gap-1"
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-foreground"
                                            aria-label={`Remove ${tag}`}
                                            onClick={() => {
                                                setPresetTags((current) =>
                                                    current.filter(
                                                        (entry) => entry !== tag,
                                                    ));
                                            }}
                                        >
                                            ×
                                        </button>
                                    </Badge>
                                ))}
                            </div>
                        ) : null}
                        <select
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value=""
                            disabled={presetTagChoices.length === 0}
                            aria-label="Add tag to preset"
                            onChange={(event) => {
                                const tag = event.target.value;
                                if (!tag) {
                                    return;
                                }
                                setPresetTags((current) =>
                                    current.includes(tag) ?
                                        current :
                                        [...current, tag]);
                            }}
                        >
                            <option value="">
                                {presetTagChoices.length === 0 ?
                                    (userTags.length === 0 ?
                                        "Create tags first" :
                                        "All tags already added") :
                                    "Add a tag…"}
                            </option>
                            {presetTagChoices.map((tag) => (
                                <option key={tag} value={tag}>
                                    {tag}
                                </option>
                            ))}
                        </select>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="submit"
                                variant="outline"
                                size="sm"
                                disabled={!presetName.trim() || presetTags.length === 0}
                            >
                                Add preset
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={handleOpenSuggestions}
                            >
                                View suggestions
                            </Button>
                        </div>
                    </form>
                    {presets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No presets yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {presets.map((preset) => {
                                const addable = userTags.filter(
                                    (tag) => !preset.tags.includes(tag),
                                );
                                return (
                                    <li
                                        key={preset.id}
                                        className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            {renamingPresetId === preset.id ? (
                                                <Input
                                                    className="min-w-0 flex-1"
                                                    value={renameDraft}
                                                    autoFocus
                                                    aria-label={`Rename ${preset.name}`}
                                                    onChange={(event) => {
                                                        setRenameDraft(
                                                            event.target.value,
                                                        );
                                                    }}
                                                    onBlur={() => {
                                                        commitRenamePreset();
                                                    }}
                                                    onKeyDown={(event) => {
                                                        if (
                                                            event.key ===
                                                            "Enter"
                                                        ) {
                                                            event.preventDefault();
                                                            commitRenamePreset();
                                                        } else if (
                                                            event.key ===
                                                            "Escape"
                                                        ) {
                                                            event.preventDefault();
                                                            cancelRenamePreset();
                                                        }
                                                    }}
                                                />
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                                                    title="Rename kit"
                                                    onClick={() => {
                                                        beginRenamePreset(
                                                            preset.id,
                                                            preset.name,
                                                        );
                                                    }}
                                                >
                                                    {preset.name}
                                                </button>
                                            )}
                                            <Button
                                                type="button"
                                                variant="destructive"
                                                size="sm"
                                                onClick={() => {
                                                    deletePreset(preset.id);
                                                }}
                                            >
                                                Delete
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {preset.tags.map((tag) => (
                                                <Badge
                                                    key={tag}
                                                    variant="secondary"
                                                    className="gap-1"
                                                >
                                                    {tag}
                                                    <button
                                                        type="button"
                                                        className="text-muted-foreground hover:text-foreground"
                                                        aria-label={`Remove ${tag} from ${preset.name}`}
                                                        onClick={() => {
                                                            const next =
                                                                preset.tags.filter(
                                                                    (entry) =>
                                                                        entry !==
                                                                        tag,
                                                                );
                                                            if (
                                                                next.length === 0
                                                            ) {
                                                                deletePreset(
                                                                    preset.id,
                                                                );
                                                                return;
                                                            }
                                                            updatePreset(
                                                                preset.id,
                                                                { tags: next },
                                                            );
                                                        }}
                                                    >
                                                        ×
                                                    </button>
                                                </Badge>
                                            ))}
                                        </div>
                                        <select
                                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                                            value=""
                                            disabled={addable.length === 0}
                                            aria-label={`Add tag to ${preset.name}`}
                                            onChange={(event) => {
                                                const tag = event.target.value;
                                                if (!tag) {
                                                    return;
                                                }
                                                updatePreset(preset.id, {
                                                    tags: [
                                                        ...preset.tags,
                                                        tag,
                                                    ],
                                                });
                                            }}
                                        >
                                            <option value="">
                                                {addable.length === 0 ?
                                                    "No more tags to add" :
                                                    "Add a tag…"}
                                            </option>
                                            {addable.map((tag) => (
                                                <option key={tag} value={tag}>
                                                    {tag}
                                                </option>
                                            ))}
                                        </select>
                                        {tuningPresetId === preset.id &&
                                        tuneProgress ? (
                                                <div className="flex flex-col gap-1.5">
                                                    <p className="text-xs text-muted-foreground">
                                                        {tuneProgress.label}
                                                    </p>
                                                    <Progress
                                                        value={
                                                            tuneProgress.total > 0 ?
                                                                Math.min(
                                                                    100,
                                                                    Math.round(
                                                                        (100 *
                                                                          tuneProgress.current) /
                                                                          tuneProgress.total,
                                                                    ),
                                                                ) :
                                                                0
                                                        }
                                                        className="h-1"
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={handleCancelTune}
                                                    >
                                                        Cancel tune
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={
                                                            tuningPresetId !==
                                                        undefined
                                                        }
                                                        onClick={() => {
                                                            handleTunePreset(
                                                                preset.id,
                                                            );
                                                        }}
                                                    >
                                                        Tune nearness
                                                    </Button>
                                                    {preset.nearnessTune ? (
                                                        <>
                                                            <span className="text-xs text-muted-foreground">
                                                                Tuned · fitness{" "}
                                                                {(
                                                                    preset
                                                                        .nearnessTune
                                                                        .fitness *
                                                                100
                                                                ).toFixed(0)}
                                                                % (+
                                                                {(
                                                                    (preset
                                                                        .nearnessTune
                                                                        .fitness -
                                                                    preset
                                                                        .nearnessTune
                                                                        .baselineFitness) *
                                                                100
                                                                ).toFixed(1)}{" "}
                                                                pp)
                                                            </span>
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                disabled={
                                                                    tuningPresetId !==
                                                                undefined
                                                                }
                                                                onClick={() => {
                                                                    handleClearTune(
                                                                        preset.id,
                                                                    );
                                                                }}
                                                            >
                                                                Clear tune
                                                            </Button>
                                                        </>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground">
                                                            Using global defaults
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Merge tags</CardTitle>
                    <CardDescription>
                        Select two or more tags, then combine them under one
                        name.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <ScrollArea className="w-full whitespace-nowrap">
                        <ToggleGroup
                            multiple
                            value={mergeSources}
                            onValueChange={(next) => {
                                setMergeSources(
                                    Array.isArray(next) ? next : [],
                                );
                            }}
                            spacing={2}
                            className="w-max"
                        >
                            {userTags.map((tag) => (
                                <ToggleGroupItem
                                    key={tag}
                                    value={tag}
                                    size="sm"
                                >
                                    {tag}
                                </ToggleGroupItem>
                            ))}
                        </ToggleGroup>
                        <ScrollBar orientation="horizontal" />
                    </ScrollArea>
                    <Separator />
                    <form
                        className="flex flex-col gap-3"
                        onSubmit={handleMergeSubmit}
                    >
                        <FieldGroup>
                            <Field>
                                <FieldLabel htmlFor="merge-target">
                                    Merged tag name
                                </FieldLabel>
                                <Input
                                    id="merge-target"
                                    placeholder="Merged tag name"
                                    value={mergeTarget}
                                    onChange={(event) =>
                                        setMergeTarget(event.target.value)
                                    }
                                />
                            </Field>
                            <Button type="submit">Merge</Button>
                        </FieldGroup>
                    </form>
                </CardContent>
            </Card>

            <Dialog open={suggestionsOpen} onOpenChange={setSuggestionsOpen}>
                <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Suggested kits</DialogTitle>
                        <DialogDescription>
                            Exact tag sets shared by at least two photos (same
                            tags, nothing extra). Already-saved kits are hidden.
                        </DialogDescription>
                    </DialogHeader>
                    {kitSuggestions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No suggestions yet. Tag more photos with overlapping
                            mixes, or your common kits are already saved.
                        </p>
                    ) : (
                        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
                            {kitSuggestions.map((suggestion) => (
                                <li
                                    key={suggestion.tags.join("\0")}
                                    className="flex items-start justify-between gap-2 rounded-lg border border-border/60 p-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="font-medium">
                                            {suggestion.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            On {suggestion.count} photo
                                            {suggestion.count === 1 ? "" : "s"}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            handleAddSuggestion(suggestion);
                                        }}
                                    >
                                        Add
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog>

            <AlertDialog
                open={deleteTarget !== undefined}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteTarget(undefined);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove tag?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleteTarget ?
                                `Remove "${deleteTarget}" from ${fileIdsByTag.get(deleteTarget)?.size ?? 0} photo${(fileIdsByTag.get(deleteTarget)?.size ?? 0) === 1 ? "" : "s"}?` :
                                ""}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={handleConfirmDelete}
                        >
                            Remove tag
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
