import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const rel of ["out/sw.js", "public/sw.js"]) {
    const path = join(root, rel);
    const source = readFileSync(path, "utf8");
    const fixed = source.replace(/\/icons\\\\/g, "/icons/");
    if (fixed !== source) {
        writeFileSync(path, fixed);
        console.log(`Normalized icon paths in ${rel}`);
    }
}
