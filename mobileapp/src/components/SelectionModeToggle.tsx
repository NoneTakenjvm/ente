import { Check } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { useSelectionStore } from "@/stores/selection-store";

export function SelectionModeToggle(): JSX.Element {
    const enabled = useSelectionStore((s) => s.enabled);
    const setEnabled = useSelectionStore((s) => s.setEnabled);

    return (
        <Button
            type="button"
            variant={enabled ? "secondary" : "outline"}
            size="icon-sm"
            aria-label={enabled ? "Exit selection mode" : "Select media"}
            aria-pressed={enabled}
            onClick={() => {
                setEnabled(!enabled);
            }}
        >
            <Check />
        </Button>
    );
}
