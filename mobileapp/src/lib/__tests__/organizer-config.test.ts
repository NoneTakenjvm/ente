import { describe, expect, it } from "vitest";
import { defaultAppSettings } from "@/lib/app-settings";
import {
    defaultOrganizerAppConfig,
    isOrganizerConfigCollection,
    mergeOrganizerAppConfig,
    ORGANIZER_APP_CONFIG_KEY,
    ORGANIZER_ROLE,
    ORGANIZER_ROLE_KEY,
} from "@/lib/organizer-config";
import { DEFAULT_TAG_TYPE } from "@/lib/tag-types";
import { ItemVisibility } from "ente-media/file-metadata";

describe("defaultOrganizerAppConfig", () => {
    it("includes the default tag type", () => {
        const config = defaultOrganizerAppConfig();
        expect(config.version).toBe(1);
        expect(config.tagTypes?.types).toContain(DEFAULT_TAG_TYPE);
    });

    it("includes default app settings", () => {
        const config = defaultOrganizerAppConfig();
        expect(config.appSettings).toEqual(defaultAppSettings());
    });
});

describe("mergeOrganizerAppConfig", () => {
    it("merges partial patches and bumps updatedAt", () => {
        const merged = mergeOrganizerAppConfig(
            {
                version: 1,
                updatedAt: 1,
                tagTypes: { types: ["default"], tagTypeByName: {} },
            },
            {
                tagTypes: {
                    types: ["default", "genre"],
                    tagTypeByName: { rock: "genre" },
                },
            },
        );
        expect(merged.tagTypes?.types).toEqual(["default", "genre"]);
        expect(merged.tagTypes?.tagTypeByName).toEqual({ rock: "genre" });
        expect(merged.updatedAt).toBeGreaterThan(1);
    });

    it("merges app settings patches", () => {
        const merged = mergeOrganizerAppConfig(
            {
                version: 1,
                updatedAt: 1,
                appSettings: defaultAppSettings(),
            },
            {
                appSettings: {
                    ...defaultAppSettings(),
                    galleryColumns: 6,
                    galleryThumbnailMode: "fit",
                },
            },
        );
        expect(merged.appSettings?.galleryColumns).toBe(6);
        expect(merged.appSettings?.galleryThumbnailMode).toBe("fit");
    });
});

describe("isOrganizerConfigCollection", () => {
    it("returns true when the organizer role marker is present", () => {
        const collection = {
            magicMetadata: {
                data: {
                    visibility: ItemVisibility.hidden,
                    [ORGANIZER_ROLE_KEY]: ORGANIZER_ROLE,
                    [ORGANIZER_APP_CONFIG_KEY]: defaultOrganizerAppConfig(),
                },
            },
        };
        expect(isOrganizerConfigCollection(collection)).toBe(true);
    });

    it("returns false for a normal collection", () => {
        expect(
            isOrganizerConfigCollection({
                magicMetadata: { data: { visibility: ItemVisibility.visible } },
            }),
        ).toBe(false);
    });
});
