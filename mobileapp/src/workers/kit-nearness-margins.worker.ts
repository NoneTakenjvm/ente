/// <reference lib="webworker" />

import {
    buildKitWhitening,
    rankByKitMargins,
    tagPresenceProbabilities,
    trainTagLogOddsModel,
    type KitMarginsWorkerResponse,
    type KitPresenceWorkerResponse,
    type KitWhitening,
    type KitWorkerRequest,
    type TagLogOddsModel,
} from "@/lib/kit-nearness-margins";

type MarginsCache = {
    libraryKey: string;
    whitening: KitWhitening;
    tagModels: Map<string, TagLogOddsModel>;
};

/**
 * Derived state for the last training population. Whitening is reused while
 * the training ids are unchanged; tag models while a tag's labels are
 * unchanged. Shared by ranking and presence requests. Lives only in this
 * worker and dies with it on logout.
 */
let cache: MarginsCache | undefined;

/** FNV-1a over the view's bytes plus its length. */
const hashOf = (view: Int32Array | Uint8Array): string => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash = Math.imul(hash ^ byte, 0x01000193);
    }
    return `${(hash >>> 0).toString(16)}:${view.length}`;
};

/** Whitening and one model per request tag, trained on first use. */
const modelsFor = (
    request: KitWorkerRequest,
): { whitening: KitWhitening; models: TagLogOddsModel[] } => {
    const libraryKey = hashOf(request.trainingIds);
    if (cache?.libraryKey !== libraryKey) {
        cache = {
            libraryKey,
            whitening: buildKitWhitening(
                request.trainingVectors,
                request.trainingIds.length,
                request.dim,
            ),
            tagModels: new Map(),
        };
    }
    const { whitening, tagModels } = cache;
    const models = request.tags.map((tag) => {
        const key = `${tag.name}\u0000${hashOf(tag.labels)}`;
        let model = tagModels.get(key);
        if (!model) {
            model = trainTagLogOddsModel(whitening, tag.labels);
            tagModels.set(key, model);
        }
        return model;
    });
    return { whitening, models };
};

self.onmessage = (event: MessageEvent<KitWorkerRequest>): void => {
    const request = event.data;
    try {
        const { whitening, models } = modelsFor(request);
        if (request.kind === "presence") {
            const tagProbabilities = tagPresenceProbabilities(request, models);
            const response: KitPresenceWorkerResponse = {
                requestId: request.requestId,
                tagProbabilities,
            };
            self.postMessage(response, [tagProbabilities.buffer]);
            return;
        }
        const orderIds = rankByKitMargins(request, whitening, models);
        if (!orderIds) {
            throw new Error("Kit has no complete or partial members");
        }
        const response: KitMarginsWorkerResponse = {
            requestId: request.requestId,
            orderIds,
        };
        self.postMessage(response, [orderIds.buffer]);
    } catch (error: unknown) {
        const response: KitMarginsWorkerResponse = {
            requestId: request.requestId,
            error:
                error instanceof Error ?
                    error.message :
                    "Kit nearness margins failed",
        };
        self.postMessage(response);
    }
};
