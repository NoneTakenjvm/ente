import { Stamp } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { useSelectionStore } from "@/stores/selection-store";

/** Toolbar control that enters or exits the stamp tagging tool. */
export function StampModeToggle(): JSX.Element {
    const stampActive = useSelectionStore((s) => s.stampActive);
    const setStampActive = useSelectionStore((s) => s.setStampActive);

    return (
        <Button
            type="button"
            variant={stampActive ? "secondary" : "outline"}
            size="icon-sm"
            aria-label={stampActive ? "Exit stamp tool" : "Stamp tags onto photos"}
            aria-pressed={stampActive}
            title={stampActive ? "Exit stamp" : "Stamp — pick tags, tap photos"}
            onClick={() => {
                setStampActive(!stampActive);
            }}
        >
            <Stamp />
        </Button>
    );
}
