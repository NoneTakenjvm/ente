import { useState, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUIStore } from "@/stores/ui-store";

type Axis = "width" | "height";

const AXES: readonly { axis: Axis; label: string; ariaLabel: string }[] = [
    { axis: "width", label: "W", ariaLabel: "Target viewport width" },
    { axis: "height", label: "H", ariaLabel: "Target viewport height" },
];

/** Width / height fields for the viewport the "Viewport fit" sort targets. */
export function ViewportTargetInputs(): JSX.Element {
    const width = useUIStore((s) => s.viewportTargetWidth);
    const height = useUIStore((s) => s.viewportTargetHeight);
    const setViewportTargetSize = useUIStore((s) => s.setViewportTargetSize);
    const resetViewportTargetToDevice = useUIStore(
        (s) => s.resetViewportTargetToDevice,
    );
    const [drafts, setDrafts] = useState({
        width: String(width),
        height: String(height),
    });

    const commitViewport = (axis: Axis): void => {
        const parsed = Number.parseInt(drafts[axis], 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setDrafts({ ...drafts, [axis]: String({ width, height }[axis]) });
            return;
        }
        const next = Math.max(1, Math.round(parsed));
        setViewportTargetSize(
            axis === "width" ? next : width,
            axis === "height" ? next : height,
        );
        setDrafts({ ...drafts, [axis]: String(next) });
    };

    return (
        <div className="mt-2 flex flex-col gap-1.5 px-2 pb-1">
            <div className="flex items-center gap-1.5">
                {AXES.map(({ axis, label, ariaLabel }) => (
                    <ViewportSizeInput
                        key={axis}
                        axis={label}
                        value={drafts[axis]}
                        onChange={(value) =>
                            setDrafts({ ...drafts, [axis]: value })}
                        onCommit={() => commitViewport(axis)}
                        ariaLabel={ariaLabel}
                    />
                ))}
            </div>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 justify-start px-1 text-xs text-muted-foreground"
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    resetViewportTargetToDevice();
                    const size = useUIStore.getState();
                    setDrafts({
                        width: String(size.viewportTargetWidth),
                        height: String(size.viewportTargetHeight),
                    });
                }}
            >
                Use device
            </Button>
        </div>
    );
}

function ViewportSizeInput({
    axis,
    value,
    onChange,
    onCommit,
    ariaLabel,
}: {
    axis: string;
    value: string;
    onChange: (value: string) => void;
    onCommit: () => void;
    ariaLabel: string;
}): JSX.Element {
    return (
        <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
            <span className="shrink-0">{axis}</span>
            <Input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onCommit}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                        event.currentTarget.blur();
                    }
                }}
                onClick={(event) => event.stopPropagation()}
                className="h-7 px-1.5 text-xs tabular-nums"
                aria-label={ariaLabel}
            />
        </label>
    );
}
