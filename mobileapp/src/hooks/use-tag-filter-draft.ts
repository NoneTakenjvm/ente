import { useMemo, useState } from "react";
import {
    tagFilterActions,
    type TagFilterActions,
} from "@/lib/tag-filter-mutations";
import { emptyTagFilter, type TagFilterSelection } from "@/lib/tag-filter";
import { useTagStore } from "@/stores/tag-store";

export interface TagFilterDraft {
    filter: TagFilterSelection;
    setFilter: (filter: TagFilterSelection) => void;
    actions: TagFilterActions;
}

/**
 * Local editable tag filter state for album create/edit forms.
 */
export const useTagFilterDraft = (
    initial: TagFilterSelection = emptyTagFilter(),
): TagFilterDraft => {
    const [filter, setFilter] = useState<TagFilterSelection>(initial);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );

    const actions = useMemo(
        (): TagFilterActions =>
            tagFilterActions(setFilter, includeInEffectsPresenceByName),
        [includeInEffectsPresenceByName],
    );

    return { filter, setFilter, actions };
};
