import {
    boxSealOpenBytes,
    decryptBox,
    deriveKey,
    deriveSubKeyBytes,
    toB64,
    toB64URLSafe,
} from "ente-base/crypto/libsodium";
import { SRP, SrpClient } from "fast-srp-hap";
import { z } from "zod";
import type { HttpClient } from "../api/http";
import type { LoginCredentials } from "../types";
import { setSessionData, type CoreSession } from "../session";

const RemoteSRPAttributes = z.object({
    srpUserID: z.string(),
    srpSalt: z.string(),
    kekSalt: z.string(),
    memLimit: z.number(),
    opsLimit: z.number(),
    isEmailMFAEnabled: z.boolean(),
});

type SRPAttributes = z.infer<typeof RemoteSRPAttributes>;

const RemoteKeyAttributes = z.object({
    kekSalt: z.string(),
    encryptedKey: z.string(),
    keyDecryptionNonce: z.string(),
    publicKey: z.string(),
    encryptedSecretKey: z.string(),
    secretKeyDecryptionNonce: z.string(),
    memLimit: z.number(),
    opsLimit: z.number(),
});

type KeyAttributes = z.infer<typeof RemoteKeyAttributes>;

const RemoteSRPVerificationResponse = z.object({
    id: z.number(),
    keyAttributes: RemoteKeyAttributes.optional(),
    encryptedToken: z.string().optional(),
    token: z.string().optional(),
    twoFactorSessionID: z.string().optional(),
    passkeySessionID: z.string().optional(),
    accountsUrl: z.string().optional(),
    twoFactorSessionIDV2: z.string().optional(),
    srpM2: z.string(),
});

const TwoFactorAuthorizationResponse = z.object({
    id: z.number(),
    keyAttributes: RemoteKeyAttributes,
    encryptedToken: z.string(),
});

const b64ToBuffer = (base64: string) => Buffer.from(base64, "base64");
const bufferToB64 = (buffer: Buffer) => buffer.toString("base64");

const deriveSRPLoginSubKey = async (kek: string): Promise<string> => {
    const kekSubKeyBytes = await deriveSubKeyBytes(kek, 32, 1, "loginctx");
    return toB64(kekSubKeyBytes.slice(0, 16));
};

const generateSRPClient = (
    srpSalt: string,
    srpUserID: string,
    loginSubKey: string,
): Promise<SrpClient> =>
    new Promise((resolve, reject) => {
        SRP.genKey((err, clientKey) => {
            if (err) {
                reject(err);
                return;
            }
            if (!clientKey) {
                reject(new Error("SRP key generation failed"));
                return;
            }
            resolve(
                new SrpClient(
                    SRP.params["4096"],
                    b64ToBuffer(srpSalt),
                    Buffer.from(srpUserID),
                    b64ToBuffer(loginSubKey),
                    clientKey,
                    false,
                ),
            );
        });
    });

const getSRPAttributes = async (
    http: HttpClient,
    email: string,
): Promise<SRPAttributes | undefined> => {
    const res = await fetch(http.apiURL("/users/srp/attributes", { email }), {
        headers: http.publicHeaders(),
    });
    if (res.status === 404) {
        return undefined;
    }
    http.ensureOk(res);
    const { attributes } = z
        .object({ attributes: RemoteSRPAttributes })
        .parse(await res.json());
    return attributes;
};

const verifySRP = async (
    http: HttpClient,
    { srpUserID, srpSalt }: SRPAttributes,
    kek: string,
) => {
    const loginSubKey = await deriveSRPLoginSubKey(kek);
    const srpClient = await generateSRPClient(srpSalt, srpUserID, loginSubKey);

    const createRes = await http.publicFetchJSON<{
        sessionID: string;
        srpB: string;
    }>("/users/srp/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            srpUserID,
            srpA: bufferToB64(srpClient.computeA()),
        }),
    });

    srpClient.setB(b64ToBuffer(createRes.srpB));

    const verifyRes = await fetch(http.apiURL("/users/srp/verify-session"), {
        method: "POST",
        headers: {
            ...http.publicHeaders(),
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            sessionID: createRes.sessionID,
            srpUserID,
            srpM1: bufferToB64(srpClient.computeM1()),
        }),
    });
    if (verifyRes.status === 401) {
        throw new Error("SRP verification failed — check email and password");
    }
    http.ensureOk(verifyRes);

    const parsed = RemoteSRPVerificationResponse.parse(await verifyRes.json());
    srpClient.checkM2(b64ToBuffer(parsed.srpM2));
    return parsed;
};

const verifyTwoFactor = async (
    http: HttpClient,
    code: string,
    sessionID: string,
) =>
    TwoFactorAuthorizationResponse.parse(
        await http.publicFetchJSON("/users/two-factor/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, sessionID }),
        }),
    );

const unwrapSession = async (
    keyAttributes: KeyAttributes,
    encryptedToken: string,
    kek: string,
): Promise<{ masterKey: string; authToken: string }> => {
    const masterKey = await decryptBox(
        {
            encryptedData: keyAttributes.encryptedKey,
            nonce: keyAttributes.keyDecryptionNonce,
        },
        kek,
    );

    const privateKey = await decryptBox(
        {
            encryptedData: keyAttributes.encryptedSecretKey,
            nonce: keyAttributes.secretKeyDecryptionNonce,
        },
        masterKey,
    );

    const authToken = await toB64URLSafe(
        await boxSealOpenBytes(encryptedToken, {
            publicKey: keyAttributes.publicKey,
            privateKey,
        }),
    );

    return { masterKey, authToken };
};

/**
 * Authenticate via SRP (+ optional TOTP 2FA) and populate the session.
 */
export const loginSRP = async (
    http: HttpClient,
    session: CoreSession,
    credentials: LoginCredentials,
): Promise<number> => {
    const { email, password, totp } = credentials;

    const srpAttributes = await getSRPAttributes(http, email);
    if (!srpAttributes) {
        throw new Error(
            "SRP attributes not found — email OTP login is not supported",
        );
    }
    if (srpAttributes.isEmailMFAEnabled) {
        throw new Error(
            "Email MFA is enabled — use the official app or CLI for this account",
        );
    }

    const kek = await deriveKey(
        password,
        srpAttributes.kekSalt,
        srpAttributes.opsLimit,
        srpAttributes.memLimit,
    );

    let authResponse = await verifySRP(http, srpAttributes, kek);

    if (authResponse.passkeySessionID && !authResponse.twoFactorSessionID) {
        throw new Error(
            "Passkey-only 2FA is not supported — use TOTP or no 2FA",
        );
    }

    if (
        authResponse.twoFactorSessionID ||
        authResponse.twoFactorSessionIDV2
    ) {
        if (!totp) {
            throw new Error("2FA code required (pass totp in credentials)");
        }
        const sessionID =
            authResponse.twoFactorSessionIDV2 ??
            authResponse.twoFactorSessionID!;
        const twoFactorResponse = await verifyTwoFactor(http, totp, sessionID);
        authResponse = { ...twoFactorResponse, srpM2: "" };
    }

    const { keyAttributes, encryptedToken, token, id } = authResponse;
    if (!keyAttributes || !encryptedToken) {
        if (token) {
            throw new Error(
                "Account has no key attributes yet — complete setup in official app first",
            );
        }
        throw new Error("Login response missing key attributes");
    }

    const { masterKey, authToken } = await unwrapSession(
        keyAttributes,
        encryptedToken,
        kek,
    );

    setSessionData(session, authToken, masterKey, id);
    return id;
};
