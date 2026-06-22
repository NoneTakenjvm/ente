/**
 * Throwaway Ente test account (~1,001 photos) for local dev and agent testing.
 * Safe to keep locally; do not use for real data.
 */
export const testAccountEmail = "redacted@example.com";

export const testAccountPassword = "REDACTED_TEST_PASSWORD";

export const testAccountCredentials = {
    email: testAccountEmail,
    password: testAccountPassword,
} as const;
