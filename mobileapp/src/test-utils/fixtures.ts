import type { EnteFile } from "ente-media/file";
import { FileType } from "ente-media/file-type";
import {
    newTagFilterNodeId,
    type TagFilterClauseNode,
    type TagFilterGroup,
} from "@/lib/tags";

/** A minimal {@link EnteFile}; `overrides` replace top-level fields wholesale. */
export const stubFile = (overrides: Partial<EnteFile> = {}): EnteFile =>
    ({
        id: 1,
        collectionID: 1,
        ownerID: 1,
        updationTime: 0,
        key: "key",
        encryptedKey: "key",
        keyDecryptionNonce: "nonce",
        metadata: {
            creationTime: 0,
            modificationTime: 0,
            title: "file",
            fileType: FileType.image,
            hash: "hash",
        },
        isDeleted: false,
        ...overrides,
    }) as unknown as EnteFile;

/** A {@link stubFile} carrying organizer tags in `pubMagicMetadata`. */
export const fileWithTags = (
    id: number,
    tags: string[],
    overrides: Partial<EnteFile> = {},
): EnteFile =>
    stubFile({
        id,
        pubMagicMetadata: {
            version: 1,
            count: 1,
            data: { _organizer_v1: { tags, updatedAt: 1 } },
        },
        ...overrides,
    } as Partial<EnteFile>);

/** Only an `id`, for tests that never look at anything else on the file. */
export const bareFile = (id: number): EnteFile => ({ id }) as EnteFile;

export const toEmb = (values: number[]): Float32Array =>
    Float32Array.from(values);

export const embMap = (
    entries: Array<[number, number[]]>,
): Map<number, Float32Array> =>
    new Map(entries.map(([id, values]) => [id, toEmb(values)]));

/** Unit vector with a 1 at index `dim`. */
export const axis = (dim: number, dims = 512): number[] => {
    const out = new Array<number>(dims).fill(0);
    out[dim] = 1;
    return out;
};

export const rgbaImageData = (
    width: number,
    height: number,
    pixelAt: (x: number, y: number) => [number, number, number, number],
): ImageData => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [red, green, blue, alpha] = pixelAt(x, y);
            const index = (y * width + x) * 4;
            data[index] = red;
            data[index + 1] = green;
            data[index + 2] = blue;
            data[index + 3] = alpha;
        }
    }
    return { width, height, data, colorSpace: "srgb" } as ImageData;
};

export const includeClause = (tag: string): TagFilterClauseNode => ({
    kind: "clause",
    id: newTagFilterNodeId(),
    tag,
    mode: "include",
});

export const andRoot = (
    ...children: TagFilterGroup["children"]
): TagFilterGroup => ({
    kind: "group",
    id: newTagFilterNodeId(),
    op: "and",
    children,
});
