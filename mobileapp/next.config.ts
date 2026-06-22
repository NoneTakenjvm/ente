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
    output: "export",
    outputFileTracingRoot: path.join(__dirname, ".."),
    transpilePackages: ["ente-base", "ente-media", "ente-utils"],
};

export default withSerwist(nextConfig);
