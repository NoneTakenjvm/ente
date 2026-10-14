import { Fragment, useState, type JSX, type ReactNode } from "react";
import { ChevronDown, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import {
    hasActiveScope,
    type ScopeKey,
    type TagFilterSelection,
} from "@/lib/tag-filter";
import { cn } from "@/lib/utils";

interface RadioOption<T extends string> {
    value: T;
    label: string;
    /** Shown beside the label when set. */
    count?: number;
}

/** Open/toggle props for one {@link OptionsSection}. */
export type SectionState = (
    id: string,
    forceOpen: boolean,
) => { open: boolean; onToggle: () => void };

interface ScopeSection {
    key: ScopeKey;
    title: string;
    options: readonly { value: string; label: string }[];
}

const SCOPE_SECTIONS: readonly ScopeSection[] = [
    {
        key: "tagScope",
        title: "Tag presence",
        options: [
            { value: "all", label: "All" },
            { value: "tagged", label: "Any tag" },
            { value: "untagged", label: "No tag" },
        ],
    },
    {
        key: "favoritesScope",
        title: "Favourites",
        options: [
            { value: "all", label: "All" },
            { value: "favorites", label: "Favourite" },
            { value: "not-favorites", label: "Not favourite" },
        ],
    },
    {
        key: "croppedScope",
        title: "Manual crop",
        options: [
            { value: "all", label: "All" },
            { value: "cropped", label: "Cropped" },
            { value: "not-cropped", label: "Not cropped" },
        ],
    },
    {
        key: "rotatedScope",
        title: "Manual rotate",
        options: [
            { value: "all", label: "All" },
            { value: "rotated", label: "Rotated" },
            { value: "not-rotated", label: "Not rotated" },
        ],
    },
    {
        key: "mediaScope",
        title: "Media type",
        options: [
            { value: "all", label: "All" },
            { value: "photo", label: "Photo" },
            { value: "video", label: "Video" },
        ],
    },
];

/**
 * Tracks which Options sections the user opened by hand. A section can also
 * be pinned open (`forceOpen`) while its choice is active.
 */
export const useSectionState = (): SectionState => {
    const [manualOpenSections, setManualOpenSections] = useState<
        ReadonlySet<string>
    >(() => new Set());

    return (id, forceOpen) => ({
        open: forceOpen || manualOpenSections.has(id),
        onToggle: () => {
            if (forceOpen) {
                return;
            }
            setManualOpenSections((prev) => {
                const next = new Set(prev);
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return next;
            });
        },
    });
};

/**
 * Collapsible Options block (Sort or Filter). Stays open while its choice is
 * active; otherwise the title toggles the body.
 */
export function OptionsSection({
    title,
    open,
    onToggle,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}): JSX.Element {
    return (
        <DropdownMenuGroup>
            <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                aria-expanded={open}
                onClick={(event) => {
                    event.preventDefault();
                    onToggle();
                }}
            >
                <span>{title}</span>
                <ChevronDown
                    className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        open && "rotate-180",
                    )}
                    aria-hidden
                />
            </button>
            {open ? children : null}
        </DropdownMenuGroup>
    );
}

/** An {@link OptionsSection} holding one radio group; `children` follow it. */
export function RadioOptionsSection({
    title,
    open,
    onToggle,
    value,
    options,
    onChange,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    value: string;
    options: readonly RadioOption<string>[];
    onChange: (value: string) => void;
    children?: ReactNode;
}): JSX.Element {
    return (
        <OptionsSection title={title} open={open} onToggle={onToggle}>
            <DropdownMenuRadioGroup
                value={value}
                onValueChange={(next) => {
                    const option = options.find(
                        (candidate) => candidate.value === next,
                    );
                    if (option) {
                        onChange(option.value);
                    }
                }}
            >
                {options.map((option) => (
                    <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        closeOnClick
                    >
                        {option.count === undefined ? (
                            option.label
                        ) : (
                            <span className="flex w-full items-center justify-between gap-2">
                                {option.label}
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {option.count}
                                </span>
                            </span>
                        )}
                    </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
            {children}
        </OptionsSection>
    );
}

/** Clear button plus one radio section per scope. */
export function ScopeFilterPanel({
    filter,
    setScope,
    counts,
    sectionState,
}: {
    filter: TagFilterSelection;
    setScope: (key: ScopeKey, value: string) => void;
    counts: ScopeCounts;
    sectionState: SectionState;
}): JSX.Element {
    const filterActive = hasActiveScope(filter);

    return (
        <>
            <div className="px-1 pb-1">
                <Button
                    type="button"
                    variant={filterActive ? "outline" : "secondary"}
                    size="sm"
                    className="w-full"
                    aria-pressed={!filterActive}
                    disabled={!filterActive}
                    onClick={() => {
                        for (const section of SCOPE_SECTIONS) {
                            setScope(section.key, "all");
                        }
                    }}
                >
                    Clear
                </Button>
            </div>
            {SCOPE_SECTIONS.map((section) => (
                <Fragment key={section.key}>
                    <DropdownMenuSeparator />
                    <RadioOptionsSection
                        title={section.title}
                        {...sectionState(
                            section.key,
                            filter[section.key] !== "all",
                        )}
                        value={filter[section.key]}
                        onChange={(value) => setScope(section.key, value)}
                        options={section.options.map((option) => ({
                            ...option,
                            count: counts[option.value as keyof ScopeCounts],
                        }))}
                    />
                </Fragment>
            ))}
        </>
    );
}

/** Filter-only dropdown over the five scopes (tag presence, favourites, …). */
export function ScopeFilterMenu({
    filter,
    setScope,
    counts,
}: {
    filter: TagFilterSelection;
    setScope: (key: ScopeKey, value: string) => void;
    counts: ScopeCounts;
}): JSX.Element {
    const sectionState = useSectionState();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        type="button"
                        variant={hasActiveScope(filter) ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 gap-1.5"
                        aria-label="Filter by tag presence, favourites, media type, crop, and rotation"
                    >
                        <Filter className="size-3.5 shrink-0" />
                        Filter
                    </Button>
                }
            />
            <DropdownMenuContent align="start" className="w-56 p-1.5">
                <ScopeFilterPanel
                    filter={filter}
                    setScope={setScope}
                    counts={counts}
                    sectionState={sectionState}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
