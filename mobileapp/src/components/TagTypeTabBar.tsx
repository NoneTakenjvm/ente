import type { JSX } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ALL_TAG_TYPES_TAB } from "@/lib/tag-types";
import { cn } from "@/lib/utils";

interface TagTypeTabBarProps {
    types: string[];
    selected: string;
    onSelect: (type: string) => void;
    /** Tabs shown before All / type tabs (e.g. Kits). */
    leadingTabs?: string[];
    className?: string;
}

export function TagTypeTabBar({
    types,
    selected,
    onSelect,
    leadingTabs,
    className,
}: TagTypeTabBarProps): JSX.Element {
    const tabs = [...(leadingTabs ?? []), ALL_TAG_TYPES_TAB, ...types];

    return (
        <ScrollArea className={cn("w-full whitespace-nowrap", className)}>
            <ToggleGroup
                value={[selected]}
                onValueChange={(next) => {
                    const value = Array.isArray(next) ? next[0] : next;
                    if (value) {
                        onSelect(value);
                    }
                }}
                spacing={2}
                className="w-max"
            >
                {tabs.map((type) => (
                    <ToggleGroupItem key={type} value={type} size="sm">
                        {type}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <ScrollBar orientation="horizontal" />
        </ScrollArea>
    );
}
