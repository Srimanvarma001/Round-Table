// Mask table images into a vertical "stadium"/capsule shape:
//  - straight vertical left & right edges
//  - top edge = full semicircle arc (radius = half the width)
//  - bottom edge = mirrored full semicircle
//  - transparent background outside the shape
// Output is portrait (tall) to read as a long round table from above.

import sharp from "sharp";
import { readdirSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve("Table_images");
const OUT_DIR = path.join(SRC_DIR, "stadium");

// Portrait capsule dimensions (tall: 1:2 like a long conference table)
const W = 720;
const H = 1440;
const R = W / 2; // full semicircle cap radius -> straight vertical sides

// Capsule mask: rounded rect with rx = W/2 gives semicircular caps top & bottom
const mask = Buffer.from(
  `<svg width="${W}" height="${H}">
     <rect x="0" y="0" width="${W}" height="${H}" rx="${R}" ry="${R}" fill="white"/>
   </svg>`
);

await import("node:fs").then((fs) => fs.mkdirSync(OUT_DIR, { recursive: true }));

for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith(".png"))) {
  const out = path.join(OUT_DIR, file);
  await sharp(path.join(SRC_DIR, file))
    .resize(W, H, { fit: "cover", position: "centre" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toFile(out);
  console.log("wrote", out);
}

// Table-surface variant: same capsule shape but 3:4 (720x960) to match the
// app's table bounding box (seats hug the rim at 31%/69% columns).
const SW = 720;
const SH = 960;
const surfaceMask = Buffer.from(
  `<svg width="${SW}" height="${SH}">
     <rect x="0" y="0" width="${SW}" height="${SH}" rx="${SW / 2}" ry="${SW / 2}" fill="white"/>
   </svg>`
);

await sharp(path.join(SRC_DIR, "5.png"))
  .resize(SW, SH, { fit: "cover", position: "centre" })
  .composite([{ input: surfaceMask, blend: "dest-in" }])
  .png()
  .toFile("public/table/surface.png");
console.log("wrote public/table/surface.png");
