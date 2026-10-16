import type { PasswordKeyAttributes } from "./auth/key-attributes";

export interface LoginCredentials {
    email: string;
    password: string;
    totp?: string;
}

export interface Session {
    userID: number;
    /** Password-encrypted master key, kept so the session can be unlocked offline. */
    keyAttributes: PasswordKeyAttributes;
}

export interface EnteCoreConfig {
    /** Defaults to NEXT_PUBLIC_ENTE_ENDPOINT or https://api.ente.com */
    apiOrigin?: string;
}
