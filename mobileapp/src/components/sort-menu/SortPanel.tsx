import type { JSX } from "react";
import {
    RadioOptionsSection,
    type SectionState,
} from "@/components/ScopeFilterMenu";
import {
    NearnessSection,
    type NearnessView,
} from "@/components/sort-menu/NearnessSection";
import { ViewportTargetInputs } from "@/components/sort-menu/ViewportTargetInputs";
import { Button } from "@/components/ui/button";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import type { ScopeCounts } from "@/hooks/use-scope-counts";
import type { TagPreset } from "@/lib/tag-presets";
import { useUIStore, type GalleryOrdering } from "@/stores/ui-store";

interface SortPanelProps {
    sectionState: SectionState;
    /** Whether a sort (not a shuffle) is applied; enables "None". */
    sortActive: boolean;
    /** Whether tag clauses exist, which enables the tag-filter-fit sort. */
    tagFilterFitAvailable: boolean;
    nearnessView: NearnessView;
    setNearnessView: (view: NearnessView) => void;
    counts: ScopeCounts;
    presets: TagPreset[];
    kitPresenceCountById: ReadonlyMap<string, number>;
}

/** Orderings that are a single direction choice. */
type DirectionSortKind = Exclude<
    GalleryOrdering["kind"],
    "nearness" | "shuffled"
>;

interface DirectionSortSection {
    kind: DirectionSortKind;
    title: string;
    options: readonly { value: string; label: string }[];
}

const DIRECTION_SORT_SECTIONS: readonly DirectionSortSection[] = [
    {
        kind: "uploadedAt",
        title: "Uploaded At",
        options: [
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
        ],
    },
    {
        kind: "viewportFit",
        title: "Viewport fit",
        options: [
            { value: "best", label: "Best Fit" },
            { value: "worst", label: "Worst Fit" },
        ],
    },
    {
        kind: "imageSize",
        title: "Image size",
        options: [
            { value: "largest", label: "Largest" },
            { value: "smallest", label: "Smallest" },
        ],
    },
    {
        kind: "imageQuality",
        title: "Image quality",
        options: [
            { value: "worst", label: "Worst" },
            { value: "best", label: "Best" },
        ],
    },
    {
        kind: "tagFilterFit",
        title: "Tag filter fit",
        options: [
            { value: "best", label: "Best fit" },
            { value: "worst", label: "Worst fit" },
        ],
    },
    {
        kind: "relative",
        title: "Relative",
        options: [
            { value: "closest", label: "Closest" },
            { value: "furthest", label: "Furthest" },
        ],
    },
];

/** The Sort tab: "None", the direction sorts, then nearness. */
export function SortPanel({
    sectionState,
    sortActive,
    tagFilterFitAvailable,
    nearnessView,
    setNearnessView,
    counts,
    presets,
    kitPresenceCountById,
}: SortPanelProps): JSX.Element {
    const setOrdering = useUIStore((s) => s.setOrdering);
    const directionSections = DIRECTION_SORT_SECTIONS.filter(
        (section) => section.kind !== "tagFilterFit" || tagFilterFitAvailable,
    );

    return (
        <>
            <div className="px-1 pb-1">
                <Button
                    type="button"
                    variant={sortActive ? "outline" : "secondary"}
                    size="sm"
                    className="w-full"
                    aria-pressed={!sortActive}
                    disabled={!sortActive}
                    onClick={() => {
                        // Never clears a shuffle: "None" is for sorts only.
                        if (sortActive) {
                            setOrdering(undefined);
                        }
                        setNearnessView("summary");
                    }}
                >
                    None
                </Button>
            </div>
            <DropdownMenuSeparator />
            {directionSections.map((section, index) => (
                <div key={section.kind}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    <DirectionSection
                        section={section}
                        sectionState={sectionState}
                    />
                </div>
            ))}
            <div>
                <DropdownMenuSeparator />
                <NearnessSection
                    sectionState={sectionState}
                    view={nearnessView}
                    setView={setNearnessView}
                    counts={counts}
                    presets={presets}
                    kitPresenceCountById={kitPresenceCountById}
                />
            </div>
        </>
    );
}

function DirectionSection({
    section,
    sectionState,
}: {
    section: DirectionSortSection;
    sectionState: SectionState;
}): JSX.Element {
    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);
    const reapplyRelativeSort = useUIStore((s) => s.reapplyRelativeSort);
    const direction = ordering?.kind === section.kind ? ordering.direction : "";

    const selectDirection = (next: string): void => {
        if (section.kind === "relative") {
            // New random tip only when turning relative on.
            const current = ordering?.kind === "relative" ? ordering : undefined;
            setOrdering({
                kind: "relative",
                direction: next as "closest" | "furthest",
                seed: current?.seed ?? Date.now(),
                startFileId: current?.startFileId,
            });
            return;
        }
        setOrdering({ kind: section.kind, direction: next } as GalleryOrdering);
    };

    return (
        <RadioOptionsSection
            title={section.title}
            {...sectionState(section.kind, direction !== "")}
            value={direction}
            onChange={selectDirection}
            options={section.options}
        >
            {section.kind === "viewportFit" ? <ViewportTargetInputs /> : null}
            {section.kind === "relative" && direction !== "" ? (
                <div className="px-2 pb-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={reapplyRelativeSort}
                    >
                        New start
                    </Button>
                </div>
            ) : null}
        </RadioOptionsSection>
    );
}
