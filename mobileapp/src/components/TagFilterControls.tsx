import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TagFilterJoin, TagFilterMode } from "@/lib/tag-filter";
import { cn } from "@/lib/utils";

const isTagFilterJoin = (value: unknown): value is TagFilterJoin =>
    value === "and" || value === "or" || value === "only";

/** AND / OR / ONLY switch for how a group combines its steps. */
export function MatchJoinToggle({
    value,
    onChange,
}: {
    value: TagFilterJoin;
    onChange: (op: TagFilterJoin) => void;
}): JSX.Element {
    return (
        <ToggleGroup
            value={[value]}
            spacing={0}
            className="shrink-0"
            onValueChange={(next) => {
                const nextValue = Array.isArray(next) ? next[0] : next;
                if (isTagFilterJoin(nextValue)) {
                    onChange(nextValue);
                }
            }}
        >
            <ToggleGroupItem
                value="and"
                size="sm"
                className="h-7 px-2 text-xs"
            >
                AND
            </ToggleGroupItem>
            <ToggleGroupItem
                value="or"
                size="sm"
                className="h-7 px-2 text-xs"
            >
                OR
            </ToggleGroupItem>
            <ToggleGroupItem
                value="only"
                size="sm"
                className="h-7 px-2 text-xs"
                title="Photos whose tags are exactly the selected Has tags"
            >
                ONLY
            </ToggleGroupItem>
        </ToggleGroup>
    );
}

/** Has / Not buttons; `onChange` receives the button that was pressed. */
export function ModeButtons({
    mode,
    notDisabled = false,
    hasTitle,
    notTitle,
    onChange,
}: {
    mode: TagFilterMode | null;
    notDisabled?: boolean;
    hasTitle?: string;
    notTitle?: string;
    onChange: (pressed: TagFilterMode) => void;
}): JSX.Element {
    return (
        <div className="flex shrink-0 items-center gap-1">
            <Button
                type="button"
                size="xs"
                variant={mode === "include" ? "default" : "outline"}
                className="h-7 px-2"
                title={hasTitle}
                onClick={() => {
                    onChange("include");
                }}
            >
                Has
            </Button>
            <Button
                type="button"
                size="xs"
                variant={mode === "exclude" ? "destructive" : "outline"}
                className={cn(
                    "h-7 px-2",
                    mode === "exclude" && "text-destructive-foreground",
                )}
                disabled={notDisabled}
                title={notTitle}
                onClick={() => {
                    onChange("exclude");
                }}
            >
                Not
            </Button>
        </div>
    );
}
