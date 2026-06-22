import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const width = 4;
const height = 2;
const canvas = createCanvas(width, height);
const context = canvas.getContext("2d");

context.fillStyle = "#ff0000";
context.fillRect(0, 0, 2, 1);
context.fillStyle = "#00ff00";
context.fillRect(2, 0, 2, 1);
context.fillStyle = "#0000ff";
context.fillRect(0, 1, 2, 1);
context.fillStyle = "#ffff00";
context.fillRect(2, 1, 2, 1);

const dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(
    join(dir, "../src/lib/__tests__/fixtures/quadrant-4x2.png"),
    canvas.toBuffer("image/png"),
);

console.log("Wrote quadrant-4x2.png");
