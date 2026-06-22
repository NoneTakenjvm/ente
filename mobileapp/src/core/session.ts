export interface CoreSession {
    authToken?: string;
    masterKey?: string;
    userID?: number;
}

export const clientPackageName = "io.ente.photos.web";

export const createEmptySession = (): CoreSession => ({});

export const setSessionData = (
    session: CoreSession,
    authToken: string,
    masterKey: string,
    userID: number,
): void => {
    session.authToken = authToken;
    session.masterKey = masterKey;
    session.userID = userID;
};

export const requireAuth = (
    session: CoreSession,
): { authToken: string; masterKey: string; userID: number } => {
    const { authToken, masterKey, userID } = session;
    if (!authToken || !masterKey || userID === undefined) {
        throw new Error("Not authenticated");
    }
    return { authToken, masterKey, userID };
};

export const publicHeaders = (): Record<string, string> => ({
    "X-Client-Package": clientPackageName,
});

export const authHeadersFor = (
    session: CoreSession,
): Record<string, string> => ({
    "X-Auth-Token": requireAuth(session).authToken,
    "X-Client-Package": clientPackageName,
});

export const clearSession = (session: CoreSession): void => {
    delete session.authToken;
    delete session.masterKey;
    delete session.userID;
};
