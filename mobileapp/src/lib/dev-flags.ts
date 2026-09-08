/**
 * Compile-time gate for local developer tools.
 *
 * Next replaces `NODE_ENV` at build time, so production static exports never
 * enable these paths via this flag alone. Matches other local-only surfaces
 * (`LoginForm`, `/dev-login`).
 */
export const isLocalDevToolsEnabled: boolean =
    process.env.NODE_ENV === "development";

/**
 * Whether to show local-only Manage tools (corpus export, etc.).
 *
 * True for Next `development` builds, and for production static previews when
 * opened on localhost / private LAN (phone QA against `npm run preview`).
 */
export const isLocalDevToolsVisible = (): boolean => {
    if (isLocalDevToolsEnabled) {
        return true;
    }
    if (typeof window === "undefined") {
        return false;
    }
    const host = window.location.hostname;
    if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "0.0.0.0"
    ) {
        return true;
    }
    // RFC1918 / link-local — typical phone → PC preview.
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) {
        return true;
    }
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
        return true;
    }
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) {
        return true;
    }
    return false;
};
