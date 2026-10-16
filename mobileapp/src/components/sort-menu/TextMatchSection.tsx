import { useState, type JSX } from "react";
import { OptionsSection, type SectionState } from "@/components/ScopeFilterMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { warmTextModelInWorker } from "@/lib/kit-embedding";
import { useUIStore } from "@/stores/ui-store";

/** Sort by CLIP match to a typed description. */
export function TextMatchSection({
    sectionState,
}: {
    sectionState: SectionState;
}): JSX.Element {
    const ordering = useUIStore((s) => s.ordering);
    const setOrdering = useUIStore((s) => s.setOrdering);
    const activeQuery = ordering?.kind === "textMatch" ? ordering.query : "";
    const [draft, setDraft] = useState<string>(activeQuery);
    const trimmed = draft.trim();

    const apply = (): void => {
        if (trimmed) {
            setOrdering({ kind: "textMatch", query: trimmed });
        }
    };

    return (
        <OptionsSection
            title="Describe"
            {...sectionState("textMatch", activeQuery !== "")}
        >
            <div className="flex flex-col gap-1.5 px-1 pb-2">
                <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Describe photos…"
                    className="h-8"
                    onFocus={() => {
                        warmTextModelInWorker().catch((error: unknown) => {
                            console.warn("Text model preload failed", error);
                        });
                    }}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                            apply();
                        }
                    }}
                    onClick={(event) => event.stopPropagation()}
                />
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!trimmed}
                    onClick={apply}
                >
                    Sort
                </Button>
            </div>
        </OptionsSection>
    );
}
