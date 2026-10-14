/**
 * Throwaway Ente test account credentials for local dev and agent testing.
 * Dev only: set these in `.env.local` (gitignored); they are empty otherwise.
 *
 *   NEXT_PUBLIC_DEV_TEST_EMAIL=...
 *   NEXT_PUBLIC_DEV_TEST_PASSWORD=...
 */
export const testAccountEmail: string = process.env.NEXT_PUBLIC_DEV_TEST_EMAIL ?? "";

export const testAccountPassword: string =
    process.env.NEXT_PUBLIC_DEV_TEST_PASSWORD ?? "";

export const testAccountCredentials: { email: string; password: string } = {
    email: testAccountEmail,
    password: testAccountPassword,
};
