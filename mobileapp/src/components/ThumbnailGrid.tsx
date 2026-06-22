import { memo, useMemo, type JSX } from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FixedSizeList,
    type ListChildComponentProps,
} from "react-window";
import {
    computeThumbnailGridLayout,
    rowCountForFiles,
    type ThumbnailGridLayout,
} from "@/lib/thumbnail-grid-layout";
import type { EnteFile } from "ente-media/file";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Images } from "lucide-react";
import { ThumbnailCell } from "./ThumbnailCell";

export interface ThumbnailGridSelection {
    selectedIds: Set<number>;
    onToggle: (file: EnteFile) => void;
    isAlreadyCompressed?: (file: EnteFile) => boolean;
    disabled?: boolean;
}

interface ThumbnailGridProps {
    files: EnteFile[];
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
}

interface RowData {
    files: EnteFile[];
    layout: ThumbnailGridLayout;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
}

const GridRow = memo(function GridRow({
    index,
    style,
    data,
}: ListChildComponentProps<RowData>): JSX.Element {
    const { files, layout, onOpenFile, selection } = data;
    const start: number = index * layout.columns;
    const rowFiles: EnteFile[] = files.slice(start, start + layout.columns);

    return (
        <div
            className="flex w-full"
            style={{
                ...style,
                paddingInline: layout.paddingInline,
                gap: layout.gap,
            }}
        >
            {rowFiles.map((file) => (
                <ThumbnailCell
                    key={file.id}
                    file={file}
                    size={layout.itemSize}
                    onOpen={onOpenFile}
                    isSelected={selection?.selectedIds.has(file.id)}
                    onToggleSelect={selection?.onToggle}
                    isAlreadyCompressed={selection?.isAlreadyCompressed?.(file)}
                    disabled={selection?.disabled}
                />
            ))}
        </div>
    );
});

interface SizedGridProps {
    files: EnteFile[];
    width: number;
    height: number;
    onOpenFile?: (file: EnteFile) => void;
    selection?: ThumbnailGridSelection;
}

function SizedGrid({
    files,
    width,
    height,
    onOpenFile,
    selection,
}: SizedGridProps): JSX.Element {
    const layout: ThumbnailGridLayout = useMemo(
        () => computeThumbnailGridLayout(width),
        [width],
    );
    const rowCount: number = rowCountForFiles(files.length, layout.columns);
    const itemData: RowData = useMemo(
        () => ({ files, layout, onOpenFile, selection }),
        [files, layout, onOpenFile, selection],
    );

    return (
        <FixedSizeList
            key={`${width}-${layout.columns}`}
            height={height}
            width={width}
            itemCount={rowCount}
            itemSize={layout.rowHeight}
            itemData={itemData}
        >
            {GridRow}
        </FixedSizeList>
    );
}

export function ThumbnailGrid({
    files,
    onOpenFile,
    selection,
}: ThumbnailGridProps): JSX.Element {
    if (files.length === 0) {
        return (
            <Empty className="flex-1 border-0">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Images />
                    </EmptyMedia>
                    <EmptyTitle>No photos in this view</EmptyTitle>
                    <EmptyDescription>
                        {selection ?
                            "No compressible files match the current filter." :
                            "Try another album or clear tag filters."}
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div className="min-h-0 flex-1">
            <AutoSizer>
                {({ height, width }: { height: number; width: number }) => (
                    <SizedGrid
                        files={files}
                        width={width}
                        height={height}
                        onOpenFile={onOpenFile}
                        selection={selection}
                    />
                )}
            </AutoSizer>
        </div>
    );
}
