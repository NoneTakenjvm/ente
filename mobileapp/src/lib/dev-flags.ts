/**
 * Compile-time gate for local developer tools.
 *
 * Next replaces `NODE_ENV` at build time, so production static exports never
 * enable these paths via this flag alone. Matches other local-only surfaces
 * (`LoginForm`, `/dev-login`).
 */
export const isLocalDevToolsEnabled: boolean =
    process.env.NODE_ENV === "development";
