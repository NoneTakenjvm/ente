import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Self-host the ONNX Runtime files Transformers.js would otherwise load from
// a CDN at runtime (see `configureOrt` in clip-embedding.worker.ts).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/@huggingface/transformers/dist");
const target = join(root, "public/ort");

mkdirSync(target, { recursive: true });
for (const name of [
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
]) {
    copyFileSync(join(source, name), join(target, name));
}
console.log("Copied ONNX Runtime assets to public/ort");
