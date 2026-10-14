import type { JSX } from "react";
import {
    Archive,
    ChartPie,
    ChevronRight,
    Copy,
    Crop,
    ImageIcon,
    Minimize2,
    Settings,
    Tags,
    Trash2,
    Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface ManageCategory {
    id: string;
    title: string;
    description: string;
    icon: typeof Copy;
}

export type ManageToolSection = (typeof toolCategories)[number]["id"];

export type ManageSection =
    "hub" |
    (typeof hubCategories)[number]["id"] |
    ManageToolSection;

export const isManageToolSection = (
    section: ManageSection,
): section is ManageToolSection =>
    toolCategories.some(({ id }) => id === section);

const CategoryList = <T extends string>({
    categories,
    onSelect,
}: {
    categories: readonly (ManageCategory & { id: T })[];
    onSelect: (id: T) => void;
}): JSX.Element => (
    <div className="flex flex-col gap-3 px-4 py-4">
        {categories.map(({ id, title, description, icon: Icon }) => (
            <Button
                key={id}
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 px-4 py-3 text-left"
                onClick={() => onSelect(id)}
            >
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                    <span className="block font-medium">{title}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                        {description}
                    </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Button>
        ))}
    </div>
);

const hubCategories = [
    {
        id: "tools",
        title: "Tools",
        description: "Duplicates, similar photos, compress, and auto-crop.",
        icon: Wrench,
    },
    {
        id: "archived",
        title: "Archived images",
        description: "Browse and restore archived photos.",
        icon: Archive,
    },
    {
        id: "trash",
        title: "Trash",
        description: "Restore or permanently delete trashed items.",
        icon: Trash2,
    },
    {
        id: "tags",
        title: "Tags",
        description: "Rename, merge, and organize tag types.",
        icon: Tags,
    },
    {
        id: "usage",
        title: "Usage",
        description: "Cloud storage used vs your Ente plan.",
        icon: ChartPie,
    },
    {
        id: "settings",
        title: "Settings",
        description: "App-wide preferences that sync across devices.",
        icon: Settings,
    },
] as const satisfies readonly ManageCategory[];

const toolCategories = [
    {
        id: "exact",
        title: "Exact duplicates",
        description: "Find and remove byte-identical copies.",
        icon: Copy,
    },
    {
        id: "similar",
        title: "Similar photos",
        description: "Scan for perceptually similar images.",
        icon: ImageIcon,
    },
    {
        id: "compress",
        title: "Compress",
        description: "Reduce file sizes for selected photos.",
        icon: Minimize2,
    },
    {
        id: "auto-crop",
        title: "Auto-crop",
        description: "Find black borders and crop them away.",
        icon: Crop,
    },
] as const satisfies readonly ManageCategory[];

const allCategories: readonly ManageCategory[] = [
    ...hubCategories,
    ...toolCategories,
];

const allSections: readonly string[] = [
    "hub",
    ...allCategories.map(({ id }) => id),
];

const sectionTitles = Object.fromEntries(
    allCategories.map(({ id, title }) => [id, title]),
) as Record<Exclude<ManageSection, "hub">, string>;

/** Whether a `?section=` query value names a Manage section. */
export const isManageSection = (value: unknown): value is ManageSection =>
    typeof value === "string" && allSections.includes(value);

export const manageSectionTitle = (
    section: Exclude<ManageSection, "hub">,
): string => sectionTitles[section];

interface ManageHubProps {
    onSelect: (section: Exclude<ManageSection, "hub">) => void;
}

export function ManageHub({ onSelect }: ManageHubProps): JSX.Element {
    return <CategoryList categories={hubCategories} onSelect={onSelect} />;
}

interface ManageToolsHubProps {
    onSelect: (section: ManageToolSection) => void;
}

/**
 * Second-level Manage hub for library maintenance tools.
 */
export function ManageToolsHub({ onSelect }: ManageToolsHubProps): JSX.Element {
    return <CategoryList categories={toolCategories} onSelect={onSelect} />;
}
