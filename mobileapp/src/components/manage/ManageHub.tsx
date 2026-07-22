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

export type ManageToolSection =
    "exact" |
    "similar" |
    "compress" |
    "auto-crop";

export type ManageSection =
    "hub" |
    "tools" |
    ManageToolSection |
    "archived" |
    "trash" |
    "tags" |
    "usage" |
    "settings";

const toolSections: ManageToolSection[] = [
    "exact",
    "similar",
    "compress",
    "auto-crop",
];

export const isManageToolSection = (
    section: ManageSection,
): section is ManageToolSection =>
    (toolSections as string[]).includes(section);

const CategoryList = <T extends string>({
    categories,
    onSelect,
}: {
    categories: {
        id: T;
        title: string;
        description: string;
        icon: typeof Copy;
    }[];
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

const hubCategories: {
    id: Exclude<ManageSection, "hub" | ManageToolSection>;
    title: string;
    description: string;
    icon: typeof Copy;
}[] = [
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
];

const toolCategories: {
    id: ManageToolSection;
    title: string;
    description: string;
    icon: typeof Copy;
}[] = [
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
];

const sectionTitles: Record<Exclude<ManageSection, "hub">, string> = {
    tools: "Tools",
    exact: "Exact duplicates",
    similar: "Similar photos",
    compress: "Compress",
    "auto-crop": "Auto-crop",
    archived: "Archived images",
    trash: "Trash",
    tags: "Tags",
    usage: "Usage",
    settings: "Settings",
};

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
