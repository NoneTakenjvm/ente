export interface PreparedLocalVideo {
    bytes: Uint8Array;
    width: number;
    height: number;
    duration: number;
    mimeType: string;
}

export const mimeTypeForVideoFile = (file: File): string => {
    if (file.type.startsWith("video/")) {
        return file.type;
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) {
        return "video/quicktime";
    }
    if (lower.endsWith(".webm")) {
        return "video/webm";
    }
    return "video/mp4";
};

const probeVideoFile = async (
    file: File,
): Promise<{ width: number; height: number; duration: number }> => {
    const url = URL.createObjectURL(file);
    try {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            const fail = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new Error("Could not read video metadata"));
            };
            video.onloadedmetadata = finish;
            video.onloadeddata = finish;
            video.onerror = fail;
            video.src = url;
            if (typeof video.load === "function") {
                video.load();
            }
        });
        const rawDuration = video.duration;
        if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
            throw new Error("Could not determine video duration");
        }
        const duration = Math.max(1, Math.round(rawDuration));
        const { videoWidth: width, videoHeight: height } = video;
        if (width <= 0 || height <= 0) {
            throw new Error("Could not determine video dimensions");
        }
        return { width, height, duration };
    } finally {
        URL.revokeObjectURL(url);
    }
};

/**
 * Read original video bytes and probe dimensions plus duration for upload.
 */
export const prepareLocalVideo = async (file: File): Promise<PreparedLocalVideo> => {
    const mimeType = mimeTypeForVideoFile(file);
    const meta = await probeVideoFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { bytes, mimeType, ...meta };
};
