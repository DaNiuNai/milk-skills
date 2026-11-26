#!/usr/bin/env node
// Build a mask or markup PNG that matches an input image's dimensions.
//
//   mask   (for --mask):   opaque black everywhere, TRANSPARENT inside the shapes = region the model may change
//   markup (for --markup): transparent everywhere, shapes drawn as colored outlines = annotations the model reads
//
// Coordinates are pixels or percentages of the image size, e.g. --rect 60%,0,40%,100%
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { encodePng, imageSize } from "./lib/png.mjs";

const HELP = `Usage: node mask.mjs (--like <image> | --size WxH) [shapes] [options] --out <file.png>

Shapes (repeatable)
  --rect x,y,w,h        Rectangle (top-left corner + size)
  --ellipse cx,cy,rx,ry Ellipse (center + radii); --circle cx,cy,r also works

Options
  --mode mask|markup    mask (default): transparent holes on opaque black; markup: outlines on transparent
  --invert              mask mode only: make the shapes the protected area instead of the editable area
  --color #rrggbb       markup outline color (default #ff0000)
  --stroke <px>         markup outline width (default 1% of the short edge, min 4)
  --fill                markup: fill shapes instead of outlining them
`;

const { values: o } = parseArgs({
  options: {
    like: { type: "string" },
    size: { type: "string" },
    rect: { type: "string", multiple: true },
    ellipse: { type: "string", multiple: true },
    circle: { type: "string", multiple: true },
    mode: { type: "string", default: "mask" },
    invert: { type: "boolean" },
    color: { type: "string", default: "#ff0000" },
    stroke: { type: "string" },
    fill: { type: "boolean" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function fail(msg) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { kind: "usage", message: msg } }, null, 2)}\n`);
  process.exit(1);
}

if (o.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!o.out) fail("--out is required");
if (!["mask", "markup"].includes(o.mode)) fail("--mode must be mask or markup");

let width, height;
if (o.like) ({ width, height } = imageSize(path.resolve(o.like)));
else if (/^\d+x\d+$/.test(o.size ?? "")) [width, height] = o.size.split("x").map(Number);
else fail("Provide --like <image> or --size WxH");

const num = (v, axis) => (v.endsWith("%") ? (Number.parseFloat(v) / 100) * axis : Number.parseFloat(v));
const nums = (spec, axes) => {
  const parts = spec.split(",").map((s) => s.trim());
  if (parts.length !== axes.length || parts.some((p) => Number.isNaN(Number.parseFloat(p)))) fail(`Bad shape spec "${spec}"`);
  return parts.map((p, i) => num(p, axes[i]));
};

const shortEdge = Math.min(width, height);
const shapes = [
  ...(o.rect ?? []).map((s) => {
    const [x, y, w, h] = nums(s, [width, height, width, height]);
    return { type: "rect", x, y, w, h };
  }),
  ...(o.ellipse ?? []).map((s) => {
    const [cx, cy, rx, ry] = nums(s, [width, height, width, height]);
    return { type: "ellipse", cx, cy, rx, ry };
  }),
  ...(o.circle ?? []).map((s) => {
    const [cx, cy, r] = nums(s, [width, height, shortEdge]);
    return { type: "ellipse", cx, cy, rx: r, ry: r };
  }),
];
if (!shapes.length) fail("Add at least one --rect, --ellipse or --circle");

const stroke = o.stroke ? Number(o.stroke) : Math.max(4, Math.round(shortEdge * 0.01));

// Signed "inside" distance approximations: >= 0 inside, magnitude ~ pixels from the edge.
function depth(s, x, y) {
  if (s.type === "rect") return Math.min(x - s.x, s.x + s.w - x, y - s.y, s.y + s.h - y);
  const d = Math.hypot((x - s.cx) / s.rx, (y - s.cy) / s.ry);
  return (1 - d) * Math.min(s.rx, s.ry);
}

const hex = /^#?([0-9a-f]{6})$/i.exec(o.color);
if (!hex) fail("--color must be #rrggbb");
const rgb = [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16));

const rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(...shapes.map((s) => depth(s, x + 0.5, y + 0.5)));
    if (o.mode === "mask") {
      const inside = d >= 0;
      rgba[i + 3] = inside !== Boolean(o.invert) ? 0 : 255;
    } else if (o.fill ? d >= 0 : d >= 0 && d < stroke) {
      rgba.set([...rgb, 255], i);
    }
  }
}

const out = path.resolve(o.out);
writeFileSync(out, encodePng(width, height, rgba));
process.stdout.write(`${JSON.stringify({ ok: true, file: out, mode: o.mode, width, height, shapes: shapes.length }, null, 2)}\n`);
