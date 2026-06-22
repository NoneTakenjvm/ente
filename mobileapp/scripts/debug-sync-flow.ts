/**
 * Node script: login + full library sync (no browser). Run from mobileapp:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/debug-sync-flow.ts
 */
import { getEnteCore } from "../src/core/instance";
import { testAccountCredentials } from "../src/dev/test-account";

const main = async (): Promise<void> => {
    const core = getEnteCore();
    console.log("Logging in…");
    const session = await core.login(testAccountCredentials);
    console.log("Authenticated user", session.userID);

    console.log("Syncing library…");
    const files = await core.syncLibrary({
        onProgress: (current, total) => {
            if (current % 5 === 0 || current === total) {
                console.log(`  collection ${current}/${total}`);
            }
        },
    });
    console.log("Files synced:", files.length);
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
