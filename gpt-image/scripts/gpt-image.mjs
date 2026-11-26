#!/usr/bin/env node
// Zero-dependency CLI for OpenAI GPT Image models (Images API + Responses image_generation tool).
// Run `node gpt-image.mjs help` for usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ApiError, createClient, setupProxy } from "./lib/client.mjs";
import { readPrompt, resolveImageRef } from "./lib/inputs.mjs";
import { buildRegistry } from "./lib/models.mjs";
import { createWriter, redact } from "./lib/output.mjs";
import { applyRawParams, imagesFields, prune, validate } from "./lib/params.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Usage: node gpt-image.mjs <command> [options]

Commands
  generate   Text -> image(s)                      POST /v1/images/generations
  edit       Image(s) [+ mask | markup] -> image   POST /v1/images/edits
  respond    Conversational / multi-turn editing   POST /v1/responses (image_generation tool)
  models     List registered models and capabilities (--json for full detail)

Prompt
  -p, --prompt <text>          Prompt text
      --prompt-file <path>     Read the prompt from a UTF-8 file (best for long or non-ASCII prompts)

Common options
  -m, --model <id>             Image model (default from config.json)
  -n, --n <1-10>               Number of images (generate/edit)
  -s, --size <WxH|auto>        e.g. 1024x1024, 1536x1024, 1024x1536, 2048x1152, 3840x2160
  -q, --quality <q>            auto | low | medium | high | xhigh | max (xhigh/max: 2.5 & 2.6 only)
      --background <b>         auto | opaque | transparent (needs png/webp)
  -f, --format <fmt>           png | jpeg | webp | svg | gif (svg/gif: 2.6 only; svg not on edit)
      --compression <0-100>    jpeg/webp compression
      --complexity <c>         low | medium | high (2.6 only; default high)
      --moderation <m>         auto | low
      --frames <2-16>          GIF frame count (default 9)
      --frame-duration <ms>    GIF per-frame delay 20-2000 (default 200)
      --svg-model <id>         SVG author model (default config.json "svgModel"; generate only)
      --svg-effort <e>         SVG author reasoning effort: none|minimal|low|medium|high|xhigh|max
      --stream                 Stream; save partial images if the API sends any
      --partial-images <0-3>   Partial previews when streaming (implies --stream; not for svg/gif)
      --safety-id <id>         Hashed end-user id (safety_identifier)
      --param key=value        Extra raw request field (JSON value ok, dotted keys nest). Repeatable

Edit options
  -i, --image <ref>            Input image: local path, https URL, or file-xxx id. Repeatable (max 16)
      --mask <ref>             PNG with alpha; transparent area = region to change (applies to first image)
      --markup <ref>           Transparent PNG annotation layer, same size as first image (2.5 / 2.6)
      --input-fidelity <f>     Only for models that support it (not 2 / 2.5 / 2.6)

Respond options (Responses API)
      --main-model <id>        Mainline model (default from config.json)
  -i, --image <ref>            Input/reference images for the turn. Repeatable
      --mask <ref>             input_image_mask for the tool
      --action <a>             auto | generate | edit
      --previous <resp_id>     Continue from a previous response id
      --continue               Continue from the last response saved in the output dir
      --no-force-tool          Let the model decide whether to call the image tool
      --tool-param key=value   Extra raw field for the image_generation tool. Repeatable

Output / runtime
  -o, --out-dir <dir>          Output directory (default ./output relative to cwd)
      --name <base>            Base file name (default <timestamp>-<prompt-slug>)
      --proxy <url|none>       Proxy (default: GPT_IMAGE_PROXY, config.json, HTTPS_PROXY)
      --base-url <url>         API base URL (default: config.json "baseUrl", OPENAI_BASE_URL, api.openai.com/v1)
      --api-key <key>          API key (default: env named by config.json "apiKeyEnv", OPENAI_API_KEY)
      --no-validate            Skip local capability checks (for new API features)
      --dry-run                Print the request body without sending it
`;

const OPTIONS = {
  prompt: { type: "string", short: "p" },
  "prompt-file": { type: "string" },
  model: { type: "string", short: "m" },
  n: { type: "string", short: "n" },
  size: { type: "string", short: "s" },
  quality: { type: "string", short: "q" },
  background: { type: "string" },
  format: { type: "string", short: "f" },
  compression: { type: "string" },
  complexity: { type: "string" },
  moderation: { type: "string" },
  frames: { type: "string" },
  "frame-duration": { type: "string" },
  "svg-model": { type: "string" },
  "svg-effort": { type: "string" },
  stream: { type: "boolean" },
  "partial-images": { type: "string" },
  "safety-id": { type: "string" },
  param: { type: "string", multiple: true },
  image: { type: "string", short: "i", multiple: true },
  mask: { type: "string" },
  markup: { type: "string" },
  "input-fidelity": { type: "string" },
  "main-model": { type: "string" },
  action: { type: "string" },
  previous: { type: "string" },
  continue: { type: "boolean" },
  "force-tool": { type: "boolean", default: true },
  "tool-param": { type: "string", multiple: true },
  "out-dir": { type: "string", short: "o" },
  name: { type: "string" },
  proxy: { type: "string" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  validate: { type: "boolean", default: true },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const log = (msg) => process.stderr.write(`[gpt-image] ${msg}\n`);
const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

class UsageError extends Error {}

function loadConfig() {
  const file = path.join(SKILL_DIR, "config.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function context(opts) {
  const config = loadConfig();
  const registry = buildRegistry(config.models);
  const proxy = opts.proxy ?? process.env.GPT_IMAGE_PROXY ?? (config.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);
  const outDir = opts["out-dir"] ?? config.outDir ?? "output";
  const baseUrl = opts["base-url"] || config.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  return { config, registry, proxy, outDir, baseUrl };
}

// API key: --api-key > env var named by config.apiKeyEnv > OPENAI_API_KEY.
// When apiKeyEnv is set but empty we fail instead of falling back, so a key is never sent to the wrong service.
function resolveApiKey(config, opts) {
  if (opts["api-key"]) return opts["api-key"];
  if (config.apiKeyEnv) {
    const key = process.env[config.apiKeyEnv];
    if (!key) throw new UsageError(`config.json "apiKeyEnv" is "${config.apiKeyEnv}", but that environment variable is not set.`);
    return key;
  }
  if (!process.env.OPENAI_API_KEY) throw new UsageError("No API key: set OPENAI_API_KEY, config.json \"apiKeyEnv\", or pass --api-key.");
  return process.env.OPENAI_API_KEY;
}

function lookupModel(registry, model, opts) {
  const caps = registry[model];
  if (!caps) {
    if (opts.validate) throw new UsageError(`Unknown model "${model}". Register it in config.json "models", or pass --no-validate to send it anyway.`);
    log(`Model "${model}" is not registered; sending without capability checks.`);
  }
  return caps;
}

function check(kind, fields, caps, opts, ctx) {
  if (!caps || !opts.validate) return [];
  const { errors, warnings } = validate(kind, fields, caps, ctx);
  if (errors.length) throw new UsageError(`Invalid request for ${caps.id}:\n  - ${errors.join("\n  - ")}`);
  for (const w of warnings) log(`warning: ${w}`);
  return warnings;
}

function makeClient({ config, proxy, baseUrl }, opts) {
  const apiKey = resolveApiKey(config, opts);
  setupProxy(proxy);
  return createClient({
    apiKey,
    baseUrl,
    timeoutMs: config.timeoutMs ?? 600_000,
    maxRetries: config.maxRetries ?? 2,
    log,
  });
}

function streamError(data) {
  const error = data.error ?? data.response?.error ?? data;
  return new ApiError({ status: 400, error, requestId: data.request_id });
}

// ---------- Images API: generate / edit ----------

async function runImages(kind, opts) {
  const ctx = context(opts);
  const { config, registry, outDir } = ctx;
  const prompt = readPrompt(opts);
  if (!prompt) throw new UsageError("A prompt is required (--prompt or --prompt-file).");
  const model = opts.model ?? config.defaultModel ?? "gpt-image-2.6-flare";
  const caps = lookupModel(registry, model, opts);
  const images = opts.image ?? [];
  if (kind === "edit" && !images.length) throw new UsageError("edit requires at least one --image.");
  if (kind === "generate" && (images.length || opts.mask || opts.markup))
    throw new UsageError("--image / --mask / --markup belong to the edit command.");

  const fields = imagesFields(opts);
  // Projects with SVG model selection must name the SVG author model; config.svgModel supplies a default.
  if (fields.output_format === "svg" && !fields.svg?.model && config.svgModel) fields.svg = { ...fields.svg, model: config.svgModel };
  const stream = Boolean(opts.stream || fields.partial_images > 0);
  const warnings = check(kind, fields, caps, opts, { stream, mask: !!opts.mask, markup: !!opts.markup, imageCount: images.length });

  const dryRun = opts["dry-run"];
  const client = dryRun ? null : makeClient(ctx, opts);
  const refs = { client, dryRun };
  const body = prune({
    model,
    prompt,
    ...(kind === "edit" && {
      images: await Promise.all(images.map((r) => resolveImageRef(r, refs))),
      mask: opts.mask && (await resolveImageRef(opts.mask, refs)),
      markup: opts.markup && (await resolveImageRef(opts.markup, refs)),
    }),
    ...fields,
    stream: stream || undefined,
  });
  applyRawParams(body, opts.param);
  if (dryRun) return print({ ok: true, dry_run: true, base_url: ctx.baseUrl, endpoint: `/images/${kind === "edit" ? "edits" : "generations"}`, body: redact(body), warnings });

  const endpoint = kind === "edit" ? "/images/edits" : "/images/generations";
  const writer = createWriter({ outDir, name: opts.name, prompt, model });
  const format = body.output_format ?? "png";
  const started = Date.now();
  log(`${kind} with ${model} (${[body.size, body.quality, format].filter(Boolean).join(", ")}) ...`);

  const result = { revised_prompts: [], partials: [] };
  if (stream) {
    let index = 0;
    const total = body.n ?? 1;
    for await (const { event, data } of client.sse(endpoint, { body })) {
      if (event.endsWith(".partial_image")) {
        const file = writer.save(data.b64_json, data.output_format ?? format, `-partial-${index}-${data.partial_image_index}`);
        result.partials.push(file);
        log(`partial ${data.partial_image_index} -> ${file}`);
      } else if (event.endsWith(".completed")) {
        writer.saveFinal(data.b64_json, data.output_format ?? format, index++, total);
        if (data.revised_prompt) result.revised_prompts.push(data.revised_prompt);
        result.usage = data.usage;
        Object.assign(result, pick(data, ["size", "quality", "background", "output_format"]));
      } else if (event === "error" || data.type === "error") throw streamError(data);
    }
  } else {
    const { data, requestId } = await client.json(endpoint, { body });
    const items = data.data ?? [];
    items.forEach((item, i) => writer.saveFinal(item.b64_json, data.output_format ?? format, i, items.length));
    result.revised_prompts = items.map((d) => d.revised_prompt).filter(Boolean);
    Object.assign(result, pick(data, ["size", "quality", "background", "output_format", "usage", "svg_usage"]), { request_id: requestId });
  }
  if (!writer.files.length) throw new Error("The API returned no image data.");

  const summary = {
    ok: true,
    command: kind,
    model,
    files: writer.files,
    ...prune(result),
    elapsed_seconds: Math.round((Date.now() - started) / 100) / 10,
    warnings,
  };
  summary.meta = writer.writeMeta({ ...summary, request: redact(body), created_at: new Date().toISOString() });
  print(summary);
}

// ---------- Responses API: respond ----------

async function runRespond(opts) {
  const ctx = context(opts);
  const { config, registry, outDir } = ctx;
  const prompt = readPrompt(opts);
  if (!prompt) throw new UsageError("A prompt is required (--prompt or --prompt-file).");
  const model = opts.model ?? config.responsesToolModel ?? config.defaultModel ?? "gpt-image-2.6-flare";
  const mainModel = opts["main-model"] ?? config.responsesMainModel ?? "gpt-5.5";
  const caps = lookupModel(registry, model, opts);
  const images = opts.image ?? [];
  for (const flag of ["n", "svg-model", "svg-effort", "markup", "input-fidelity"])
    if (opts[flag] !== undefined && opts.validate) throw new UsageError(`--${flag} is not available in respond; use generate/edit (or --tool-param with --no-validate).`);
  if (opts.action && !["auto", "generate", "edit"].includes(opts.action)) throw new UsageError("--action must be auto, generate or edit");

  const lastFile = path.resolve(outDir, ".last-response.json");
  let previous = opts.previous;
  if (opts.continue) {
    if (!existsSync(lastFile)) throw new UsageError(`--continue: no previous response found at ${lastFile}`);
    previous = JSON.parse(readFileSync(lastFile, "utf8")).id;
  }

  const { n, svg, input_fidelity, safety_identifier, ...fields } = imagesFields(opts);
  const stream = Boolean(opts.stream || fields.partial_images > 0);
  const warnings = check("respond", fields, caps, opts, { stream, mask: !!opts.mask, imageCount: images.length });

  const dryRun = opts["dry-run"];
  const client = dryRun ? null : makeClient(ctx, opts);
  const refs = { client, dryRun };
  const imageParts = await Promise.all(images.map(async (r) => ({ type: "input_image", detail: "auto", ...(await resolveImageRef(r, refs)) })));
  const tool = prune({
    type: "image_generation",
    model,
    ...fields,
    action: opts.action,
    input_image_mask: opts.mask && (await resolveImageRef(opts.mask, refs)),
  });
  applyRawParams(tool, opts["tool-param"]);
  const body = prune({
    model: mainModel,
    input: imageParts.length ? [{ role: "user", content: [{ type: "input_text", text: prompt }, ...imageParts] }] : prompt,
    tools: [tool],
    tool_choice: opts["force-tool"] ? { type: "image_generation" } : undefined,
    previous_response_id: previous,
    safety_identifier: opts["safety-id"],
    stream: stream || undefined,
  });
  applyRawParams(body, opts.param);
  if (dryRun) return print({ ok: true, dry_run: true, base_url: ctx.baseUrl, endpoint: "/responses", body: redact(body), warnings });

  const writer = createWriter({ outDir, name: opts.name, prompt, model });
  const format = tool.output_format ?? "png";
  const started = Date.now();
  log(`respond with ${mainModel} + ${model}${previous ? ` (continuing ${previous})` : ""} ...`);

  let response;
  const partials = [];
  if (stream) {
    for await (const { event, data } of client.sse("/responses", { body })) {
      if (event === "response.image_generation_call.partial_image") {
        const file = writer.save(data.partial_image_b64, format, `-partial-${data.partial_image_index}`);
        partials.push(file);
        log(`partial ${data.partial_image_index} -> ${file}`);
      } else if (event === "response.completed") response = data.response;
      else if (event === "response.failed" || event === "error") throw streamError(data);
    }
    if (!response) throw new Error("Stream ended without response.completed");
  } else {
    response = (await client.json("/responses", { body })).data;
  }

  const calls = (response.output ?? []).filter((o) => o.type === "image_generation_call");
  const withImage = calls.filter((c) => c.result);
  withImage.forEach((c, i) => writer.saveFinal(c.result, c.output_format ?? format, i, withImage.length));
  const text = (response.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n");

  writeFileSync(lastFile, JSON.stringify({ id: response.id, main_model: mainModel, image_model: model, image_call_ids: calls.map((c) => c.id), saved_at: new Date().toISOString() }, null, 2));

  const summary = prune({
    ok: withImage.length > 0,
    command: "respond",
    model,
    main_model: mainModel,
    response_id: response.id,
    previous_response_id: previous,
    files: writer.files,
    partials,
    image_call_ids: calls.map((c) => c.id),
    revised_prompts: calls.map((c) => c.revised_prompt).filter(Boolean),
    output_text: text || undefined,
    usage: response.usage,
    elapsed_seconds: Math.round((Date.now() - started) / 100) / 10,
    warnings,
    note: withImage.length ? undefined : "The model replied without generating an image; see output_text.",
  });
  summary.meta = writer.writeMeta({ ...summary, request: redact(body), created_at: new Date().toISOString() });
  print(summary);
  if (!withImage.length) process.exitCode = 1;
}

// ---------- models ----------

function runModels(opts) {
  const { registry } = context(opts);
  if (opts.json) return print(registry);
  const rows = Object.values(registry)
    .filter((c) => !c.snapshotOf)
    .map((c) => ({
      model: c.id,
      summary: c.summary,
      quality: c.qualities.join("/"),
      formats: [...new Set([...c.formats.generate, ...c.formats.edit])].join("/"),
      complexity: !!c.complexity,
      markup: c.markup,
      mask: c.mask,
      responses_tool: c.endpoints.responsesTool,
      deprecated: !!c.deprecated,
      snapshots: c.snapshots,
    }));
  print(rows);
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}

function hintFor(err) {
  if (err.code === "moderation_blocked")
    return `Blocked by moderation (${err.moderationDetails?.moderation_stage ?? "unknown"} stage${err.moderationDetails?.categories?.length ? `: ${err.moderationDetails.categories.join(", ")}` : ""}). Rephrase the prompt or change inputs; do not retry unchanged.`;
  if (err.type === "image_generation_user_error") return "The request needs to change (prompt, inputs or parameters); do not retry unchanged.";
  if (err.status === 401) return "Invalid API key for this base URL: check --api-key / config.json \"apiKeyEnv\" / OPENAI_API_KEY.";
  if (err.status === 403) return "The organization may need verification or access to this model/feature.";
  if (err.status === 429) return err.code === "insufficient_quota" ? "Quota exhausted; check billing." : "Rate limited; wait and retry.";
  if (err.status === undefined) return "Network failure: confirm the proxy (config.json \"proxy\", --proxy, or GPT_IMAGE_PROXY) is running.";
  return undefined;
}

async function main() {
  const { values: opts, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  const command = positionals[0];
  if (opts.help || !command || command === "help") return process.stdout.write(HELP);
  if (command === "generate" || command === "edit") return runImages(command, opts);
  if (command === "respond") return runRespond(opts);
  if (command === "models") return runModels(opts);
  throw new UsageError(`Unknown command "${command}". Run with --help.`);
}

main().catch((err) => {
  const error =
    err instanceof ApiError
      ? prune({ kind: "api", status: err.status, type: err.type, code: err.code, param: err.param, message: err.message, request_id: err.requestId, moderation_details: err.moderationDetails })
      : { kind: err instanceof UsageError || err.code?.startsWith?.("ERR_PARSE_ARGS") ? "usage" : "runtime", message: err.message };
  print(prune({ ok: false, error, hint: err instanceof ApiError ? hintFor(err) : undefined }));
  process.exitCode = 1;
});
