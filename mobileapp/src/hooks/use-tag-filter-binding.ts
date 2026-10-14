import { useMemo } from "react";
import {
    tagFilterActions,
    type TagFilterActions,
} from "@/lib/tag-filter-mutations";
import type { TagFilterSelection } from "@/lib/tag-filter";
import {
    type TagFilterTarget,
    useTagStore,
} from "@/stores/tag-store";

export interface TagFilterBinding {
    filter: TagFilterSelection;
    actions: TagFilterActions;
}

/**
 * Route tag-filter reads and writes to the gallery or album-view slice.
 */
export function useTagFilterBinding(
    target: TagFilterTarget = "gallery",
): TagFilterBinding {
    const filter = useTagStore((s) =>
        target === "gallery" ? s.tagFilter : s.albumViewFilter);
    const includeInEffectsPresenceByName = useTagStore(
        (s) => s.typeConfig.includeInEffectsPresenceByName,
    );

    const actions = useMemo(
        (): TagFilterActions =>
            tagFilterActions(
                (update) => useTagStore.getState().updateTagFilter(target, update),
                includeInEffectsPresenceByName,
            ),
        [target, includeInEffectsPresenceByName],
    );

    return useMemo(
        (): TagFilterBinding => ({ filter, actions }),
        [filter, actions],
    );
}
