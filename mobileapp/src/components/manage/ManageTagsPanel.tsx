import {
    useCallback,
    useMemo,
    useState,
    type FormEvent,
    type JSX,
} from "react";
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
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    tagsGroupedByType,
    typeForTag,
} from "@/lib/tag-types";
import { normalizeTagName } from "@/lib/tag-writes";
import { isReservedTag } from "@/lib/tags";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";
import { Tags, Plus } from "lucide-react";

export function ManageTagsPanel(): JSX.Element {
    const tags = useTagStore((s) => s.tags);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const setTagType = useTagStore((s) => s.setTagType);
    const ensureTagType = useTagStore((s) => s.ensureTagType);
    const registerTag = useTagStore((s) => s.registerTag);
    const renameTag = useLibraryStore((s) => s.renameTag);
    const deleteTag = useLibraryStore((s) => s.deleteTag);
    const mergeTags = useLibraryStore((s) => s.mergeTags);

    const [renameTarget, setRenameTarget] = useState<string | undefined>();
    const [renameValue, setRenameValue] = useState<string>("");
    const [mergeSources, setMergeSources] = useState<string[]>([]);
    const [mergeTarget, setMergeTarget] = useState<string>("");
    const [deleteTarget, setDeleteTarget] = useState<string | undefined>();
    const [progress, setProgress] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [newTypeName, setNewTypeName] = useState<string>("");
    const [newTagName, setNewTagName] = useState<string>("");
    const [newTagType, setNewTagType] = useState<string>("");

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
