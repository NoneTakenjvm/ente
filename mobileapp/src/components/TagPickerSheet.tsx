import {
    useEffect,
    useMemo,
    useState,
    type FormEvent,
    type JSX,
} from "react";
import { Check, Plus } from "lucide-react";
import { TagTypeTabBar } from "@/components/TagTypeTabBar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    ALL_TAG_TYPES_TAB,
    DEFAULT_TAG_TYPE,
    normalizeTagTypeName,
    tagsForTypeView,
} from "@/lib/tag-types";
import { normalizeTagName } from "@/lib/tag-writes";
import { isReservedTag, tagFileCount } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useTagStore } from "@/stores/tag-store";

interface TagPickerSheetProps {
    open: boolean;
    appliedTags: string[];
    knownTags: string[];
    error?: string;
    onOpenChange: (open: boolean) => void;
    onAddTag: (name: string) => void;
    onRemoveTag: (name: string) => void;
}

export function TagPickerSheet({
    open,
    appliedTags,
    knownTags,
    error,
    onOpenChange,
    onAddTag,
    onRemoveTag,
}: TagPickerSheetProps): JSX.Element {
    const fileIdsByTag = useTagStore((s) => s.fileIdsByTag);
    const tagTypes = useTagStore((s) => s.tagTypes);
    const tagTypeByName = useTagStore((s) => s.tagTypeByName);
    const ensureTagType = useTagStore((s) => s.ensureTagType);
    const setTagType = useTagStore((s) => s.setTagType);

    const [selectedType, setSelectedType] = useState<string>(DEFAULT_TAG_TYPE);
    const [newTag, setNewTag] = useState<string>("");
    const [newType, setNewType] = useState<string>("");

    const libraryTags = useMemo(
        (): string[] =>
            tagsForTypeView(
                knownTags.filter((tag) => !isReservedTag(tag)),
                tagTypeByName,
                selectedType,
                fileIdsByTag,
            ),
        [knownTags, tagTypeByName, selectedType, fileIdsByTag],
    );

    const defaultCreateType = useMemo((): string => {
        if (selectedType !== ALL_TAG_TYPES_TAB) {
            return selectedType;
        }
        return DEFAULT_TAG_TYPE;
    }, [selectedType]);

    const isSpecificTypeTab =
        selectedType !== ALL_TAG_TYPES_TAB &&
        selectedType !== DEFAULT_TAG_TYPE;

    useEffect(() => {
        setNewType(isSpecificTypeTab ? selectedType : "");
    }, [isSpecificTypeTab, selectedType]);

    const clearCreateForm = (): void => {
        setNewTag("");
        setNewType(isSpecificTypeTab ? selectedType : "");
    };

    const handleOpenChange = (nextOpen: boolean): void => {
        if (!nextOpen) {
            setNewTag("");
            setNewType("");
            setSelectedType(DEFAULT_TAG_TYPE);
        }
        onOpenChange(nextOpen);
    };

    const handleCreateTag = (event: FormEvent): void => {
        event.preventDefault();
        const name = normalizeTagName(newTag);
        if (!name || isReservedTag(name) || appliedTags.includes(name)) {
            return;
        }
        const type =
            normalizeTagTypeName(newType) ??
            defaultCreateType;
        ensureTagType(type);
        setTagType(name, type);
        onAddTag(name);
        clearCreateForm();
    };

    return (
        <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent
                side="bottom"
                className="flex h-[75dvh] max-h-[75dvh] flex-col gap-0 overflow-hidden rounded-t-xl p-0"
            >
                <SheetHeader className="shrink-0 gap-2 border-b border-border px-4 pt-4 pb-3">
                    <SheetTitle>Tags</SheetTitle>
                    <TagTypeTabBar
                        types={tagTypes}
                        selected={selectedType}
                        onSelect={setSelectedType}
                    />
                </SheetHeader>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                        {libraryTags.length === 0 ? (
                            <p className="px-2 py-4 text-sm text-muted-foreground">
                                No tags in this group yet. Create one below.
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-0.5">
                                {libraryTags.map((tag) => {
                                    const applied = appliedTags.includes(tag);
                                    const count = tagFileCount(
                                        tag,
                                        fileIdsByTag,
                                    );
                                    return (
                                        <li key={tag}>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                className={cn(
                                                    "h-10 w-full justify-between gap-2 px-3",
                                                    applied && "bg-secondary/80",
                                                )}
                                                onClick={() => {
                                                    if (applied) {
                                                        onRemoveTag(tag);
                                                    } else {
                                                        onAddTag(tag);
                                                    }
                                                }}
                                            >
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <Check
                                                        className={cn(
                                                            "size-4 shrink-0",
                                                            applied ?
                                                                "opacity-100" :
                                                                "opacity-0",
                                                        )}
                                                        aria-hidden={!applied}
                                                    />
                                                    <span className="truncate">
                                                        {tag}
                                                    </span>
                                                </span>
                                                <Badge
                                                    variant="secondary"
                                                    className="tabular-nums"
                                                >
                                                    {count}
                                                </Badge>
                                            </Button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>

                <SheetFooter className="shrink-0 gap-3 border-t border-border p-4">
                    <form
                        className="flex w-full flex-col gap-2"
                        onSubmit={handleCreateTag}
                    >
                        <div className="flex w-full items-center gap-2">
                            <Button
                                type="submit"
                                variant="outline"
                                size="icon-sm"
                                disabled={!newTag.trim()}
                                aria-label="Create tag"
                            >
                                <Plus />
                            </Button>
                            <Input
                                placeholder="Create new tag"
                                value={newTag}
                                className="min-w-0 flex-1"
                                onChange={(event) => {
                                    setNewTag(event.target.value);
                                }}
                            />
                            <Input
                                placeholder="Type (optional)"
                                value={newType}
                                className="min-w-0 w-28 shrink-0"
                                onChange={(event) => {
                                    setNewType(event.target.value);
                                }}
                            />
                        </div>
                    </form>
                    <p className="text-xs text-muted-foreground">
                        Tap a tag to add or remove it. The type field fills
                        from the selected tab when you pick a custom type.
                    </p>
                    {error ? (
                        <Alert variant="destructive" className="py-2">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
