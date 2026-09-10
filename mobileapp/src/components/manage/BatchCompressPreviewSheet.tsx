import { useMemo, type JSX } from "react";
import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    fileByteSize,
    formatSizeDelta,
} from "@/lib/compress";
import type { EnteFile } from "ente-media/file";

interface BatchCompressPreviewSheetProps {
    open: boolean;
    files: EnteFile[];
    minSizeLabel: string;
    videoCrf: number;
    onClose: () => void;
    onConfirm: () => void;
}

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function BatchCompressPreviewSheet({
    open,
    files,
    minSizeLabel,
    videoCrf,
    onClose,
    onConfirm,
}: BatchCompressPreviewSheetProps): JSX.Element {
    const totalBytes = useMemo(
        () => files.reduce((sum, file) => sum + fileByteSize(file), 0),
        [files],
    );

    const settingsSummary = `Skip under ${minSizeLabel.replace(/\+$/u, "")} · Video CRF ${videoCrf}`;

    const sizeSummary = formatSizeDelta(totalBytes, Math.round(totalBytes * 0.7));

    return (
        <Sheet
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    onClose();
                }
            }}
        >
            <SheetContent
                side="bottom"
                className="max-h-[85dvh] overflow-y-auto rounded-t-xl"
            >
                <SheetHeader>
                    <SheetTitle>Review compression</SheetTitle>
                </SheetHeader>

                <div className="flex flex-col gap-4 px-4">
                    <p className="text-sm text-muted-foreground">
                        {files.length} file{files.length === 1 ? "" : "s"} selected ·{" "}
                        {formatBytes(totalBytes)} total
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {settingsSummary}. Files that would not shrink by at least 2%
                        are skipped automatically.
                    </p>
                    {totalBytes > 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Typical savings for large photos and videos are substantial;
                            already-optimized files are left unchanged.
                        </p>
                    ) : null}
                    <ul className="max-h-48 overflow-y-auto rounded-md border border-border text-sm">
                        {files.slice(0, 40).map((file) => (
                            <li
                                key={file.id}
                                className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0"
                            >
                                <span className="truncate">
                                    {file.metadata.title}
                                </span>
                                <span className="shrink-0 text-muted-foreground">
                                    {fileByteSize(file) > 0 ?
                                        formatBytes(fileByteSize(file)) :
                                        "Unknown size"}
                                </span>
                            </li>
                        ))}
                        {files.length > 40 ? (
                            <li className="px-3 py-2 text-muted-foreground">
                                …and {files.length - 40} more
                            </li>
                        ) : null}
                    </ul>
                    {totalBytes > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            Selected total: {sizeSummary.originalLabel}
                        </p>
                    ) : null}
                </div>

                <SheetFooter className="flex-row justify-end gap-2">
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={onConfirm}>
                        Start compression
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
