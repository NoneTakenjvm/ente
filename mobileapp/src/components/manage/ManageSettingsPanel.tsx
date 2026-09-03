import type { JSX } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GalleryColumnCount } from "@/lib/app-settings";
import {
    MAX_SIMILAR_MAX_GROUP_SIZE,
    MIN_SIMILAR_MAX_GROUP_SIZE,
} from "@/lib/app-settings";
import { useSettingsStore } from "@/stores/settings-store";

const columnOptions: GalleryColumnCount[] = [2, 3, 4, 5, 6];

const similarMaxGroupSizeOptions: number[] = Array.from(
    { length: MAX_SIMILAR_MAX_GROUP_SIZE - MIN_SIMILAR_MAX_GROUP_SIZE + 1 },
    (_, i) => MIN_SIMILAR_MAX_GROUP_SIZE + i,
);

export function ManageSettingsPanel(): JSX.Element {
    const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
    const videoLoop = useSettingsStore((s) => s.videoLoop);
    const videoDefaultMuted = useSettingsStore((s) => s.videoDefaultMuted);
    const galleryColumns = useSettingsStore((s) => s.galleryColumns);
    const galleryThumbnailMode = useSettingsStore((s) => s.galleryThumbnailMode);
    const similarMaxGroupSize = useSettingsStore((s) => s.similarMaxGroupSize);
    const patchSettings = useSettingsStore((s) => s.patchSettings);

    return (
        <div className="flex flex-col gap-4 px-4 py-4">
            <Card>
                <CardHeader>
                    <CardTitle>Video</CardTitle>
                    <CardDescription>
                        Playback behavior in the photo viewer.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-auto-play">
                                Auto play
                            </FieldLabel>
                            <Switch
                                id="video-auto-play"
                                checked={videoAutoPlay}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoAutoPlay: checked });
                                }}
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-loop">Loop</FieldLabel>
                            <Switch
                                id="video-loop"
                                checked={videoLoop}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoLoop: checked });
                                }}
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldLabel htmlFor="video-default-muted">
                                Start muted
                            </FieldLabel>
                            <Switch
                                id="video-default-muted"
                                checked={videoDefaultMuted}
                                onCheckedChange={(checked) => {
                                    patchSettings({ videoDefaultMuted: checked });
                                }}
                            />
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Gallery</CardTitle>
                    <CardDescription>
                        How photos and videos appear in grid views.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>Gallery width</FieldLabel>
                            <Select
                                value={String(galleryColumns)}
                                onValueChange={(value) => {
                                    if (!value) {
                                        return;
                                    }
                                    patchSettings({
                                        galleryColumns: Number.parseInt(
                                            value,
                                            10,
                                        ) as GalleryColumnCount,
                                    });
                                }}
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {columnOptions.map((count) => (
                                        <SelectItem
                                            key={count}
                                            value={String(count)}
                                        >
                                            {count} across
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <FieldLabel>Thumbnail layout</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[galleryThumbnailMode]}
                                onValueChange={(next) => {
                                    const value = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (
                                        value === "grid" ||
                                        value === "fit"
                                    ) {
                                        patchSettings({
                                            galleryThumbnailMode: value,
                                        });
                                    }
                                }}
                                className="w-full"
                            >
                                <ToggleGroupItem
                                    value="grid"
                                    className="flex-1"
                                >
                                    Grid
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="fit"
                                    className="flex-1"
                                >
                                    Fit
                                </ToggleGroupItem>
                            </ToggleGroup>
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Similar photos</CardTitle>
                    <CardDescription>
                        Caps how many images can land in one similar group.
                        Real duplicates are almost never more than a handful.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>Max group size</FieldLabel>
                            <ToggleGroup
                                variant="outline"
                                value={[String(similarMaxGroupSize)]}
                                onValueChange={(next) => {
                                    const raw = Array.isArray(next) ?
                                        next[0] :
                                        next;
                                    if (raw === undefined || raw === "") {
                                        return;
                                    }
                                    const parsed = Number.parseInt(raw, 10);
                                    if (!Number.isFinite(parsed)) {
                                        return;
                                    }
                                    patchSettings({
                                        similarMaxGroupSize: parsed,
                                    });
                                }}
                                className="w-full"
                            >
                                {similarMaxGroupSizeOptions.map((size) => (
                                    <ToggleGroupItem
                                        key={size}
                                        value={String(size)}
                                        className="flex-1"
                                    >
                                        {size}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                            <p className="text-xs text-muted-foreground">
                                Images per group (larger piles are almost always
                                false positives)
                            </p>
                        </Field>
                    </FieldGroup>
                </CardContent>
            </Card>
        </div>
    );
}
