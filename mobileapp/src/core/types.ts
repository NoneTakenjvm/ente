export interface LoginCredentials {
    email: string;
    password: string;
    totp?: string;
}

export interface Session {
    userID: number;
}

export interface EnteCoreConfig {
    /** Defaults to NEXT_PUBLIC_ENTE_ENDPOINT or https://api.ente.com */
    apiOrigin?: string;
}
