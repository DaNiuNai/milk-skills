import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXT = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", svg: "svg" };

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function createWriter({ outDir, name, prompt, model }) {
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const base = name ?? [timestamp(), slug(prompt) || model].join("-");
  const files = [];

  function unique(file) {
    if (!existsSync(file)) return file;
    const { dir: d, name: n, ext } = path.parse(file);
    for (let i = 2; ; i++) {
      const candidate = path.join(d, `${n}-${i}${ext}`);
      if (!existsSync(candidate)) return candidate;
    }
  }

  return {
    dir,
    base,
    files,
    save(b64, format, suffix = "") {
      const file = unique(path.join(dir, `${base}${suffix}.${EXT[format] ?? format ?? "png"}`));
      writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    },
    saveFinal(b64, format, index, total) {
      const file = this.save(b64, format, total > 1 ? `-${index + 1}` : "");
      files.push(file);
      return file;
    },
    writeMeta(meta) {
      const file = unique(path.join(dir, `${base}.json`));
      writeFileSync(file, JSON.stringify(meta, null, 2));
      return file;
    },
  };
}

// Replace base64 payloads so request bodies can be logged or saved safely.
export function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "string" && v.startsWith("data:") && v.length > 200 ? `${v.slice(0, v.indexOf(",") + 1)}<${v.length} chars>` : v,
    ),
  );
}
