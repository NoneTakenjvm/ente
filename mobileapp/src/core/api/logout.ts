import type { HttpClient } from "./http";

/**
 * Revoke {@link authToken} on the server (`POST /users/logout`).
 *
 * Takes the token explicitly so a locked session, which has no in-memory
 * token, can still sign out. Uses a plain fetch so a 401 cannot re-enter the
 * unauthorized handler (which calls logout).
 */
export const logoutRemote = async (
    http: HttpClient,
    authToken: string,
): Promise<void> => {
    const res = await fetch(http.apiURL("/users/logout"), {
        method: "POST",
        headers: { ...http.publicHeaders(), "X-Auth-Token": authToken },
    });
    // 401 means the token already expired or was revoked.
    if (res.status !== 401) {
        http.ensurePublicOk(res);
    }
};
