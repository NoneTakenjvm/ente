import { useMemo, useState, type FormEvent, type JSX } from "react";
import { AlbumCoverPickerSheet } from "@/components/albums/AlbumCoverPickerSheet";
import { AlbumCoverThumb } from "@/components/albums/AlbumCoverThumb";
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
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TagClausePicker } from "@/components/TagClausePicker";
import { TagQueryEditor } from "@/components/TagQueryEditor";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    resolveAlbumCoverFile,
    validCoverFileIdForMatches,
} from "@/lib/album-cover";
import { queryAlbumFilter, type QueryAlbum } from "@/lib/query-albums";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { sortFilesByUpload } from "@/lib/sort-files";
import {
    countFavoritesInCandidates,
    countFilesMatchingTagFilter,
    countManuallyCroppedInCandidates,
    countNotFavoritesInCandidates,
    countNotManuallyCroppedInCandidates,
    countPhotosInCandidates,
    countTaggedInCandidates,
    countUntaggedInCandidates,
    countVideosInCandidates,
    describeTagFilter,
    emptyTagFilter,
    filterFilesByTags,
    GROUPED_TAG_FILTER_DROPDOWN_HINT,
    isFlatTagFilterRoot,
} from "@/lib/tags";
import { useAlbumStore } from "@/stores/album-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import { useLibraryStore } from "@/stores/library-store";
import { useTagStore } from "@/stores/tag-store";

interface AlbumEditorPanelProps {
    album: QueryAlbum | undefined;
    onSave: (name: string) => void;
    onCancel: () => void;
    onDelete: (() => void) | undefined;
}

export function AlbumEditorPanel({
    album,
    onSave,
    onCancel,
    onDelete,
}: AlbumEditorPanelProps): JSX.Element {
    const allFiles = useLibraryStore((s) => s.allFiles);
    const favoriteFileIds = useFavoritesStore((s) => s.favoriteFileIds);
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.includeInEffectsPresenceByName,
    );

    const initialFilter = album ? queryAlbumFilter(album) : emptyTagFilter();
    const { filter, actions } = useTagFilterDraft(initialFilter);

    const [name, setName] = useState<string>(album?.name ?? "");
    const [coverFileId, setCoverFileId] = useState<number | undefined>(
        album?.coverFileId,
    );
    const [showCoverPicker, setShowCoverPicker] = useState<boolean>(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);

    const libraryFiles = useMemo(() => {
        const deduped = dedupeFilesById(allFiles);
        return sortFilesByUpload(deduped);
    }, [allFiles]);

    const libraryFileIds = useMemo(
        (): Set<number> => new Set(libraryFiles.map((file) => file.id)),
        [libraryFiles],
    );

    const matchFiles = useMemo(
        () =>
            filterFilesByTags(
                libraryFiles,
                filter,
                fileIdsByTag,
                { favoriteFileIds, includeInEffectsPresenceByName },
            ),
        [
            favoriteFileIds,
            fileIdsByTag,
            filter,
            includeInEffectsPresenceByName,
            libraryFiles,
        ],
    );

    const previewAlbum = useMemo(
        (): QueryAlbum => ({
            id: album?.id ?? "draft",
            name: name.trim() || "Album",
            query: album?.query ?? emptyTagFilter(),
            coverFileId,
        }),
        [album?.id, album?.query, coverFileId, name],
    );

    const coverPreviewFile = useMemo(
        () => resolveAlbumCoverFile(previewAlbum, matchFiles),
        [matchFiles, previewAlbum],
    );

    const matchCount = useMemo(
        () =>
            countFilesMatchingTagFilter(
                libraryFileIds,
                filter,
                fileIdsByTag,
                libraryFiles,
                { favoriteFileIds, includeInEffectsPresenceByName },
            ),
        [
            favoriteFileIds,
            fileIdsByTag,
            filter,
            includeInEffectsPresenceByName,
            libraryFileIds,
            libraryFiles,
        ],
    );

    const taggedCount = useMemo(
        () =>
            countTaggedInCandidates(
                libraryFileIds,
                fileIdsByTag,
                includeInEffectsPresenceByName,
            ),
        [includeInEffectsPresenceByName, libraryFileIds, fileIdsByTag],
    );

    const untaggedCount = useMemo(
        () =>
            countUntaggedInCandidates(
                libraryFileIds,
                fileIdsByTag,
                includeInEffectsPresenceByName,
            ),
        [includeInEffectsPresenceByName, libraryFileIds, fileIdsByTag],
    );

    const favoritesCount = useMemo(
        () => countFavoritesInCandidates(libraryFileIds, favoriteFileIds),
        [favoriteFileIds, libraryFileIds],
    );

    const notFavoritesCount = useMemo(
        () => countNotFavoritesInCandidates(libraryFileIds, favoriteFileIds),
        [favoriteFileIds, libraryFileIds],
    );

    const photoCount = useMemo(
        () => countPhotosInCandidates(libraryFileIds, libraryFiles),
        [libraryFileIds, libraryFiles],
    );

    const videoCount = useMemo(
        () => countVideosInCandidates(libraryFileIds, libraryFiles),
        [libraryFileIds, libraryFiles],
    );

    const croppedCount = useMemo(
        () => countManuallyCroppedInCandidates(libraryFileIds, libraryFiles),
        [libraryFileIds, libraryFiles],
    );

    const notCroppedCount = useMemo(
        () => countNotManuallyCroppedInCandidates(libraryFileIds, libraryFiles),
        [libraryFileIds, libraryFiles],
    );

    const handleSubmit = (event: FormEvent): void => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const validCover = validCoverFileIdForMatches(coverFileId, matchFiles);
        if (album) {
            useAlbumStore.getState().updateAlbum(album.id, {
                name: trimmed,
                query: filter,
                ...(validCover !== undefined ?
                    { coverFileId: validCover } :
                    coverFileId !== undefined ?
                        { coverFileId: null } :
                        {}),
            });
        } else {
            const created = useAlbumStore.getState().createAlbum(trimmed, filter);
            if (validCover !== undefined) {
                useAlbumStore.getState().updateAlbum(created.id, {
                    coverFileId: validCover,
                });
            }
        }
        onSave(trimmed);
    };

    return (
        <form
            className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4"
            onSubmit={handleSubmit}
        >
            <Field>
                <FieldLabel htmlFor="album-name">Album name</FieldLabel>
                <Input
                    id="album-name"
                    value={name}
                    placeholder="My album"
                    onChange={(event) => setName(event.target.value)}
                    autoFocus={!album}
                />
            </Field>

            <div className="flex items-center gap-3">
                <AlbumCoverThumb
                    file={coverPreviewFile}
                    onClick={() => {
                        if (matchFiles.length > 0) {
                            setShowCoverPicker(true);
                        }
                    }}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">Thumbnail</span>
                    <span className="text-xs text-muted-foreground">
                        {matchFiles.length === 0 ?
                            "No matching photos yet" :
                            "Tap to choose a cover photo"}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                    <TagClausePicker
                        filter={filter}
                        onSetTagFilterMode={actions.setTagFilterMode}
                        onSetKitMode={actions.setKitMode}
                        onSetRootOp={(op) => {
                            actions.setGroupOp(filter.root.id, op);
                        }}
                        disabled={!isFlatTagFilterRoot(filter.root)}
                    />
                    <span className="text-xs text-muted-foreground">
                        {matchCount} photo{matchCount === 1 ? "" : "s"} match
                    </span>
                </div>
                {!isFlatTagFilterRoot(filter.root) ? (
                    <p className="text-xs text-muted-foreground">
                        {GROUPED_TAG_FILTER_DROPDOWN_HINT}
                    </p>
                ) : null}
            </div>

            <div className="rounded-lg border border-border/60 p-3">
                <TagQueryEditor
                    filter={filter}
                    actions={actions}
                    taggedCount={taggedCount}
                    untaggedCount={untaggedCount}
                    favoritesCount={favoritesCount}
                    notFavoritesCount={notFavoritesCount}
                    photoCount={photoCount}
                    videoCount={videoCount}
                    croppedCount={croppedCount}
                    notCroppedCount={notCroppedCount}
                />
            </div>

            <p className="text-xs text-muted-foreground">
                {describeTagFilter(filter) || "All photos in your library"}
            </p>

            <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
                <Button type="submit" disabled={!name.trim()}>
                    {album ? "Save changes" : "Create album"}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                {onDelete ? (
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={() => setShowDeleteConfirm(true)}
                    >
                        Delete album
                    </Button>
                ) : null}
            </div>

            <AlertDialog
                open={showDeleteConfirm}
                onOpenChange={setShowDeleteConfirm}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete album?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {album ?
                                `"${album.name}" will be removed. Your photos are not affected.` :
                                ""}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                                setShowDeleteConfirm(false);
                                onDelete?.();
                            }}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlbumCoverPickerSheet
                open={showCoverPicker}
                files={matchFiles}
                selectedFileId={coverFileId}
                onOpenChange={setShowCoverPicker}
                onSelect={setCoverFileId}
            />
        </form>
    );
}
