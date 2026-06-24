export const ACCEPT_LOCAL_MEDIA =
    "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,image/*," +
    "video/mp4,video/quicktime,video/webm,video/*,.mp4,.mov,.webm,.m4v";

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|mkv|avi)$/iu;

/**
 * True when the picked file should be uploaded as a video.
 */
export const isVideoFile = (file: File): boolean =>
    file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name);

/**
 * True when the picked file should be uploaded as an image.
 */
export const isImageFile = (file: File): boolean =>
    file.type.startsWith("image/") ||
    /\.(jpe?g|png|webp|heic|heif|gif)$/iu.test(file.name);

/**
 * True when the file can be staged in the upload panel.
 */
export const isUploadableLocalFile = (file: File): boolean =>
    isVideoFile(file) || isImageFile(file);

export const sanitizeUploadImageTitle = (fileName: string): string => {
    const trimmed = fileName.trim() || "upload";
    const safe = trimmed.replace(/[^\w.\- ]+/gu, "").trim() || "upload";
    if (/\.jpe?g$/iu.test(safe)) {
        return safe;
    }
    const base = safe.replace(/\.[^.]+$/u, "") || "upload";
    return `${base}.jpg`;
};

export const sanitizeUploadVideoTitle = (fileName: string): string => {
    const trimmed = fileName.trim() || "upload";
    const safe = trimmed.replace(/[^\w.\- ]+/gu, "").trim() || "upload";
    if (/\.mp4$/iu.test(safe)) {
        return safe;
    }
    const base = safe.replace(/\.[^.]+$/u, "") || "upload";
    return `${base}.mp4`;
};
