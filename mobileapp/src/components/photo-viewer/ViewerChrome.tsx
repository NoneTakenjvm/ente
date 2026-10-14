import type { JSX, RefObject } from "react";
import {
    Archive,
    ArchiveRestore,
    ChevronLeft,
    ChevronRight,
    Crop,
    Heart,
    Image,
    MoreVertical,
    Tag,
    Trash2,
    Undo2,
    X,
} from "lucide-react";
import { VideoPlaybackControls } from "@/components/VideoPlaybackControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { canCrop, canCropVideo } from "@/lib/crop";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";
import type { SlideMedia } from "@/hooks/use-slide-media";

interface ViewerChromeProps {
    /** Whether the bars are slid into view. */
    shown: boolean;
    readOnly: boolean;
    file: EnteFile;
    isVideo: boolean;
    currentIndex: number;
    fileCount: number;
    activeSlideMedia: SlideMedia | undefined;
    activeVideoRef: RefObject<HTMLVideoElement | null>;
    carouselAnimating: boolean;
    isFavorite: boolean;
    favoriteDisabled: boolean;
    isArchived: boolean;
    archiveBusy: boolean;
    canRevertEdit: boolean;
    revertBusy: boolean;
    albumCoverFileId: number | undefined;
    /** Shown when set; hidden when the viewer has no album-cover action. */
    onSetAlbumCover: ((fileId: number) => void) | undefined;
    showSetRelative: boolean;
    relativeStartFileId: number | undefined;
    tags: string[];
    tagSaveBusy: boolean;
    showTagPicker: boolean;
    errors: { tag?: string; favorite?: string; delete?: string };
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    onSetRelative: () => void;
    onToggleFavorite: () => void;
    onToggleArchive: () => void;
    onRevert: () => void;
    onCrop: () => void;
    onDelete: () => void;
    onEditTags: () => void;
    onScrubbingChange: (scrubbing: boolean) => void;
}

/**
 * Top action bar and bottom tag/playback bar of the viewer. Both slide out
 * together when {@link ViewerChromeProps.shown} is false.
 */
export function ViewerChrome({
    shown,
    readOnly,
    file,
    isVideo,
    currentIndex,
    fileCount,
    activeSlideMedia,
    activeVideoRef,
    carouselAnimating,
    isFavorite,
    favoriteDisabled,
    isArchived,
    archiveBusy,
    canRevertEdit,
    revertBusy,
    albumCoverFileId,
    onSetAlbumCover,
    showSetRelative,
    relativeStartFileId,
    tags,
    tagSaveBusy,
    showTagPicker,
    errors,
    onClose,
    onPrev,
    onNext,
    onSetRelative,
    onToggleFavorite,
    onToggleArchive,
    onRevert,
    onCrop,
    onDelete,
    onEditTags,
    onScrubbingChange,
}: ViewerChromeProps): JSX.Element {
    const mediaKey =
        activeSlideMedia?.url ? `${file.id}:${activeSlideMedia.url}` : undefined;

    return (
        <>
            <div
                className={cn(
                    "absolute inset-x-0 top-0 z-10 border-b border-border bg-background transition-transform duration-200",
                    shown ?
                        "translate-y-0" :
                        "-translate-y-full pointer-events-none",
                )}
            >
                <div className="flex items-center justify-between gap-2 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <X />
                    </Button>
                    <span className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
                        {currentIndex + 1} / {fileCount}
                    </span>
                    {showSetRelative ? (
                        <Button
                            type="button"
                            variant={
                                file.id === relativeStartFileId ?
                                    "secondary" :
                                    "outline"
                            }
                            size="sm"
                            className="h-8 shrink-0 px-2 text-xs"
                            onClick={onSetRelative}
                            aria-pressed={file.id === relativeStartFileId}
                        >
                            Set Relative
                        </Button>
                    ) : null}
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={onPrev}
                            disabled={currentIndex === 0 || carouselAnimating}
                            aria-label="Previous"
                        >
                            <ChevronLeft />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={onNext}
                            disabled={
                                currentIndex >= fileCount - 1 ||
                                carouselAnimating
                            }
                            aria-label="Next"
                        >
                            <ChevronRight />
                        </Button>
                        {!readOnly ? (
                            <Button
                                type="button"
                                variant={isFavorite ? "secondary" : "ghost"}
                                size="icon-sm"
                                onClick={onToggleFavorite}
                                disabled={favoriteDisabled}
                                aria-label={
                                    isFavorite ?
                                        "Remove from favourites" :
                                        "Add to favourites"
                                }
                                aria-pressed={isFavorite}
                            >
                                <Heart className={cn(isFavorite && "fill-current")} />
                            </Button>
                        ) : null}
                        {!readOnly && canRevertEdit ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={onRevert}
                                disabled={revertBusy}
                                aria-label="Revert last edit"
                            >
                                <Undo2 />
                            </Button>
                        ) : null}
                        {!readOnly && onSetAlbumCover ? (
                            <Button
                                type="button"
                                variant={
                                    file.id === albumCoverFileId ?
                                        "secondary" :
                                        "ghost"
                                }
                                size="icon-sm"
                                onClick={() => {
                                    onSetAlbumCover(file.id);
                                }}
                                aria-label="Set as album cover"
                                aria-pressed={file.id === albumCoverFileId}
                            >
                                <Image />
                            </Button>
                        ) : null}
                        {!readOnly && (canCrop(file) || canCropVideo(file)) ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={onCrop}
                                disabled={activeSlideMedia?.status !== "ready"}
                                aria-label={isVideo ? "Edit video" : "Crop image"}
                            >
                                <Crop />
                            </Button>
                        ) : null}
                        {!readOnly ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={onDelete}
                                aria-label="Delete"
                            >
                                <Trash2 />
                            </Button>
                        ) : null}
                        {!readOnly ? (
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label="More actions"
                                        />
                                    }
                                >
                                    <MoreVertical />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                    <DropdownMenuGroup>
                                        <DropdownMenuItem
                                            disabled={archiveBusy}
                                            onClick={onToggleArchive}
                                        >
                                            {isArchived ?
                                                <ArchiveRestore data-icon="inline-start" /> :
                                                <Archive data-icon="inline-start" />}
                                            {isArchived ? "Unarchive" : "Archive"}
                                        </DropdownMenuItem>
                                    </DropdownMenuGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : null}
                    </div>
                </div>
            </div>

            <div
                className={cn(
                    "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-background px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-transform duration-200",
                    isVideo && "rounded-t-xl shadow-lg",
                    shown ?
                        "translate-y-0" :
                        "translate-y-full pointer-events-none",
                )}
            >
                {isVideo ? (
                    <VideoPlaybackControls
                        key={mediaKey ?? "idle"}
                        videoRef={activeVideoRef}
                        attachKey={
                            activeSlideMedia?.status === "ready" ?
                                mediaKey :
                                undefined
                        }
                        visible={shown}
                        onScrubbingChange={onScrubbingChange}
                    />
                ) : null}
                <div className="flex h-8 shrink-0 items-center gap-1.5">
                    {!readOnly ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={tagSaveBusy}
                            onClick={onEditTags}
                        >
                            {tagSaveBusy ? <Spinner /> : <Tag />}
                            Tags
                        </Button>
                    ) : null}
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain">
                        {tags.length === 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {readOnly ? "" : "No tags"}
                            </span>
                        ) : (
                            tags.map((tag) => (
                                <Badge
                                    key={tag}
                                    variant="secondary"
                                    className="max-w-[12rem] shrink-0"
                                >
                                    <span className="truncate">{tag}</span>
                                </Badge>
                            ))
                        )}
                    </div>
                </div>
                {tagSaveBusy && !showTagPicker ? (
                    <p className="text-xs text-muted-foreground">
                        Saving tags…
                    </p>
                ) : null}
                {errors.tag && !showTagPicker ? (
                    <ErrorAlert message={errors.tag} />
                ) : null}
                {errors.favorite ? <ErrorAlert message={errors.favorite} /> : null}
                {errors.delete ? <ErrorAlert message={errors.delete} /> : null}
            </div>
        </>
    );
}

function ErrorAlert({ message }: { message: string }): JSX.Element {
    return (
        <Alert variant="destructive" className="py-2">
            <AlertDescription>{message}</AlertDescription>
        </Alert>
    );
}
