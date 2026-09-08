import path from "node:path";
import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import type { ManifestEntry, ManifestTransform } from "@serwist/build";

type PrecacheManifestEntry = ManifestEntry & { size: number };

/** Webpack config slice we touch — avoid depending on webpack's Configuration type. */
type WebpackConfigSlice = {
    experiments?: Record<string, unknown>;
};

/** Serwist glob on Windows can emit backslashes — URLs must use forward slashes. */
const normalizePrecacheManifest: ManifestTransform = async (
    manifest: PrecacheManifestEntry[],
): Promise<{ manifest: PrecacheManifestEntry[]; warnings: string[] }> => ({
    manifest: manifest.map(
        (entry: PrecacheManifestEntry): PrecacheManifestEntry => ({
            ...entry,
            url: entry.url.replace(/\\/g, "/"),
        }),
    ),
    warnings: [],
});

const withSerwist: (config: NextConfig) => NextConfig = withSerwistInit({
    swSrc: "src/sw.ts",
    swDest: "public/sw.js",
    disable: process.env.NODE_ENV === "development",
    manifestTransforms: [normalizePrecacheManifest],
});

const nextConfig: NextConfig = {
    // Static export for PWA preview/build; keep a Node server in `next dev`
    // so same-origin debug/API routes work from phones on LAN.
    ...(process.env.NODE_ENV === "production" ? { output: "export" as const } : {}),
    outputFileTracingRoot: path.join(__dirname, ".."),
    transpilePackages: ["ente-base", "ente-media", "ente-utils"],
    webpack: (config: WebpackConfigSlice & {
        resolve?: { alias?: Record<string, string | false> };
        externals?: unknown;
    }): WebpackConfigSlice => {
        config.experiments = {
            ...config.experiments,
            asyncWebAssembly: true,
        };
        // transformers.js pulls Node-only optional deps; stub for browser bundle.
        config.resolve = {
            ...config.resolve,
            alias: {
                ...config.resolve?.alias,
                sharp: false,
                "onnxruntime-node": false,
            },
        };
        return config;
    },
};

export default withSerwist(nextConfig);
