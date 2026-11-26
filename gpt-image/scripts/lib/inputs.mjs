import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_DATA_URL = 20_971_520;

// Accepts a local path, an http(s) URL, or an uploaded File API id (file-...).
// Returns the `{ image_url }` / `{ file_id }` object used by both the Images and Responses APIs.
export async function resolveImageRef(ref, { client, dryRun }) {
  if (/^https?:\/\//i.test(ref)) return { image_url: ref };
  if (/^file-[\w-]+$/.test(ref) && !existsSync(ref)) return { file_id: ref };

  const file = path.resolve(ref);
  if (!existsSync(file)) throw new Error(`Input image not found: ${ref}`);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`Unsupported input image type "${path.extname(file)}" (use png, jpg, webp): ${ref}`);
  const size = statSync(file).size;
  const estimatedLength = Math.ceil(size / 3) * 4 + mime.length + 13;

  if (dryRun) return { image_url: `<data:${mime};base64 of ${path.basename(file)}, ${size} bytes>` };
  if (estimatedLength <= MAX_DATA_URL) return { image_url: `data:${mime};base64,${readFileSync(file).toString("base64")}` };

  const form = new FormData();
  form.append("purpose", "vision");
  form.append("file", new Blob([readFileSync(file)], { type: mime }), path.basename(file));
  const { data } = await client.json("/files", { form });
  return { file_id: data.id };
}

export function readPrompt({ prompt, "prompt-file": promptFile }) {
  if (promptFile) return readFileSync(path.resolve(promptFile), "utf8").trim();
  return prompt?.trim();
}
