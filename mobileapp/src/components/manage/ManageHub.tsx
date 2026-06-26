import type { JSX } from "react";
import {
    ChevronRight,
    Copy,
    ImageIcon,
    Minimize2,
    Settings,
    Tags,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type ManageSection =
    "hub" |
    "exact" |
    "similar" |
    "compress" |
    "tags" |
    "settings";

interface ManageHubProps {
    onSelect: (section: Exclude<ManageSection, "hub">) => void;
}

const categories: {
    id: Exclude<ManageSection, "hub">;
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
        id: "tags",
        title: "Tags",
        description: "Rename, merge, and organize tag types.",
        icon: Tags,
    },
    {
        id: "settings",
        title: "Settings",
        description: "App-wide preferences that sync across devices.",
        icon: Settings,
    },
];

const sectionTitles: Record<Exclude<ManageSection, "hub">, string> = {
    exact: "Exact duplicates",
    similar: "Similar photos",
    compress: "Compress",
    tags: "Tags",
    settings: "Settings",
};

export const manageSectionTitle = (
    section: Exclude<ManageSection, "hub">,
): string => sectionTitles[section];

export function ManageHub({ onSelect }: ManageHubProps): JSX.Element {
    return (
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
}
