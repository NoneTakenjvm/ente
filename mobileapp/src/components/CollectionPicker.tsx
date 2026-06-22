import type { JSX } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLibraryStore } from "@/stores/library-store";

export function CollectionPicker(): JSX.Element {
    const collections = useLibraryStore((s) => s.collections);
    const activeCollectionId = useLibraryStore((s) => s.activeCollectionId);
    const setActiveCollection = useLibraryStore((s) => s.setActiveCollection);
    const syncStatus = useLibraryStore((s) => s.syncStatus);

    const loading: boolean =
        syncStatus === "syncing" || syncStatus === "loadingFromCache";

    const value =
        activeCollectionId === null ? "all" : String(activeCollectionId);

    const handleValueChange = (next: string | string[]): void => {
        const selected = Array.isArray(next) ? next[0] : next;
        if (!selected) {
            return;
        }
        setActiveCollection(selected === "all" ? null : Number(selected));
    };

    return (
        <ScrollArea className="w-full whitespace-nowrap px-4 py-2">
            <ToggleGroup
                value={[value]}
                onValueChange={handleValueChange}
                spacing={2}
                className="w-max"
            >
                <ToggleGroupItem value="all" disabled={loading} size="sm">
                    All photos
                </ToggleGroupItem>
                {collections
                    .filter((collection) => collection.type !== "favorites")
                    .map((collection) => (
                        <ToggleGroupItem
                            key={collection.id}
                            value={String(collection.id)}
                            disabled={loading}
                            size="sm"
                        >
                            {collection.name}
                        </ToggleGroupItem>
                    ))}
            </ToggleGroup>
            <ScrollBar orientation="horizontal" />
        </ScrollArea>
    );
}
