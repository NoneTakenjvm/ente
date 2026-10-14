import { useMemo, useState, type FormEvent, type JSX } from "react";
import { AlbumCoverPickerSheet } from "@/components/albums/AlbumCoverPickerSheet";
import { AlbumCoverThumb } from "@/components/albums/AlbumCoverThumb";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TagFilterEditor } from "@/components/TagFilterEditor";
import { useScopeCounts } from "@/hooks/use-scope-counts";
import { useTagFilterDraft } from "@/hooks/use-tag-filter-draft";
import {
    resolveAlbumCoverFile,
    validCoverFileIdForMatches,
} from "@/lib/album-cover";
import { queryAlbumFilter, type QueryAlbum } from "@/lib/query-albums";
import { dedupeFilesById } from "@/lib/sync/merge-files";
import { sortFilesByUpload } from "@/lib/sort-files";
import {
    emptyTagFilter,
    filterFilesByTags,
} from "@/lib/tag-filter";
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
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );

    const initialFilter = album ? queryAlbumFilter(album) : emptyTagFilter();
    const { filter, actions } = useTagFilterDraft(initialFilter);

    const [name, setName] = useState<string>(album?.name ?? "");
    const [coverFileId, setCoverFileId] = useState<number | undefined>(
        album?.coverFileId,
    );
    const [showCoverPicker, setShowCoverPicker] = useState<boolean>(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);

    const libraryFiles = useMemo(
        () => sortFilesByUpload(dedupeFilesById(allFiles)),
        [allFiles],
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

    const counts = useScopeCounts(libraryFiles);

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

            <TagFilterEditor
                filter={filter}
                actions={actions}
                counts={counts}
                emptyDescription="All photos in your library"
                matchCount={matchFiles.length}
                className="gap-4"
            />

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

            <ConfirmDialog
                open={showDeleteConfirm}
                title="Delete album?"
                description={
                    album ?
                        `"${album.name}" will be removed. Your photos are not affected.` :
                        ""
                }
                confirmLabel="Delete"
                destructive
                onCancel={() => setShowDeleteConfirm(false)}
                onConfirm={() => {
                    setShowDeleteConfirm(false);
                    onDelete?.();
                }}
            />

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
