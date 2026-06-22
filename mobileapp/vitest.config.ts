import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "node",
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
            "ente-base/crypto/libsodium": path.resolve(
                __dirname,
                "../web/packages/base/crypto/libsodium.ts",
            ),
            "ente-base/crypto": path.resolve(
                __dirname,
                "src/core/crypto-shim.ts",
            ),
        },
    },
});
