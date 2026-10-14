import type { JSX } from "react";
import { ArrowDownUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settings-store";

/** Header button toggling the library sort between upload and edit time. */
export function GallerySortToggle(): JSX.Element {
    const gallerySortBy = useSettingsStore((s) => s.gallerySortBy);
    const patchSettings = useSettingsStore((s) => s.patchSettings);
    const edited = gallerySortBy === "edited";

    return (
        <Button
            type="button"
            variant={edited ? "secondary" : "outline"}
            size="icon-sm"
            aria-label={edited ? "Sort by upload date" : "Sort by last edited"}
            aria-pressed={edited}
            onClick={() =>
                patchSettings({ gallerySortBy: edited ? "uploaded" : "edited" })}
            title={
                edited ?
                    "Sorting by edit time — tap to sort by upload" :
                    "Sorting by upload — tap to sort by edit"
            }
        >
            <ArrowDownUp />
        </Button>
    );
}
