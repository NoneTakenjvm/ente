import { Stamp } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { stampTagsFromNearnessFilter } from "@/lib/tag-presets";
import { isTagFilterActive } from "@/lib/tags";
import { useSelectionStore } from "@/stores/selection-store";
import { useTagSpeedStore } from "@/stores/tag-speed-store";
import { useUIStore } from "@/stores/ui-store";

/** Toolbar control that enters or exits the stamp tagging tool. */
export function StampModeToggle(): JSX.Element {
    const stampActive = useSelectionStore((s) => s.stampActive);
    const setStampActive = useSelectionStore((s) => s.setStampActive);
    const setStampTags = useSelectionStore((s) => s.setStampTags);
    const setStampPickMode = useSelectionStore((s) => s.setStampPickMode);
    const setStampSheetOpen = useSelectionStore((s) => s.setStampSheetOpen);

    return (
        <Button
            type="button"
            variant={stampActive ? "secondary" : "outline"}
            size="icon-sm"
            aria-label={stampActive ? "Exit stamp tool" : "Stamp tags onto photos"}
            aria-pressed={stampActive}
            title={stampActive ? "Exit stamp" : "Stamp — pick tags, tap photos"}
            onClick={() => {
                if (stampActive) {
                    setStampActive(false);
                    return;
                }
                const nearnessFilter = useUIStore.getState().nearnessFilter;
                if (
                    nearnessFilter !== undefined &&
                    isTagFilterActive(nearnessFilter)
                ) {
                    const from = stampTagsFromNearnessFilter(
                        nearnessFilter,
                        useTagSpeedStore.getState().presets,
                    );
                    if (from) {
                        setStampPickMode(from.pickMode);
                        setStampTags(from.tags);
                        setStampSheetOpen(false);
                    }
                }
                setStampActive(true);
            }}
        >
            <Stamp />
        </Button>
    );
}
