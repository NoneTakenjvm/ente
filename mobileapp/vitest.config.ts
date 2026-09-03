import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "node",
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
            // Prefer the installed package junction so a git worktree can share
            // main's node_modules without resolving worktree-local web/tsconfig.
            "ente-base/crypto/libsodium": path.resolve(
                __dirname,
                "node_modules/ente-base/crypto/libsodium.ts",
            ),
            "ente-base/crypto": path.resolve(
                __dirname,
                "src/core/crypto-shim.ts",
            ),
        },
    },
});
