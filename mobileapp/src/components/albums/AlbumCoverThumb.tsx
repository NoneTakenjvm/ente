import type { JSX } from "react";
import { ImageIcon } from "lucide-react";
import { ThumbnailImage } from "@/components/ThumbnailImage";
import { cn } from "@/lib/utils";
import type { EnteFile } from "ente-media/file";

interface AlbumCoverThumbProps {
    file: EnteFile | undefined;
    className?: string;
    onClick?: () => void;
}

export function AlbumCoverThumb({
    file,
    className,
    onClick,
}: AlbumCoverThumbProps): JSX.Element {
    const content = file ? (
        <ThumbnailImage file={file} />
    ) : (
        <ImageIcon className="size-5 text-muted-foreground" aria-hidden />
    );

    if (onClick) {
        return (
            <button
                type="button"
                className={cn(
                    "relative size-14 shrink-0 overflow-hidden rounded-md bg-muted",
                    className,
                )}
                onClick={onClick}
                aria-label="Change album thumbnail"
            >
                {content}
            </button>
        );
    }

    return (
        <div
            className={cn(
                "relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted",
                className,
            )}
        >
            {content}
        </div>
    );
}
