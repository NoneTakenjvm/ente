import path from "node:path";
import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import type { ManifestTransform } from "@serwist/build";

/** Serwist glob on Windows can emit backslashes — URLs must use forward slashes. */
const normalizePrecacheManifest: ManifestTransform = async (manifest) => ({
    manifest: manifest.map((entry) => ({
        ...entry,
        url: entry.url.replace(/\\/g, "/"),
    })),
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
    webpack: (config) => {
        config.experiments = {
            ...config.experiments,
            asyncWebAssembly: true,
        };
        return config;
    },
};

export default withSerwist(nextConfig);
