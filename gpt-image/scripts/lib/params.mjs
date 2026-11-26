// Maps CLI options to API fields and validates them against the model's capabilities.
// Validation exists to fail fast with a clear message instead of paying for a round trip;
// it can be skipped with --no-validate when the API gains features before the registry does.

const int = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));

export function commonFields(opts) {
  return {
    n: int(opts.n),
    size: opts.size,
    quality: opts.quality,
    background: opts.background,
    output_format: opts.format,
    output_compression: int(opts.compression),
    moderation: opts.moderation,
    partial_images: int(opts["partial-images"]),
  };
}

export function imagesFields(opts) {
  const svg =
    opts["svg-model"] || opts["svg-effort"]
      ? { model: opts["svg-model"], reasoning: opts["svg-effort"] ? { effort: opts["svg-effort"] } : undefined }
      : undefined;
  return {
    ...commonFields(opts),
    complexity: opts.complexity,
    frame_count: int(opts.frames),
    frame_duration_ms: int(opts["frame-duration"]),
    input_fidelity: opts["input-fidelity"],
    svg,
    safety_identifier: opts["safety-id"],
  };
}

// --param key=value (value parsed as JSON when possible). Dotted keys set nested fields.
export function applyRawParams(target, pairs = []) {
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 1) throw new Error(`--param expects key=value, got "${pair}"`);
    const keys = pair.slice(0, i).split(".");
    let value = pair.slice(i + 1);
    try {
      value = JSON.parse(value);
    } catch {}
    let node = target;
    for (const k of keys.slice(0, -1)) node = node[k] ??= {};
    node[keys.at(-1)] = value;
  }
  return target;
}

// Drop undefined values, empty objects and empty arrays (recursively) so requests only carry set fields.
export function prune(obj) {
  if (Array.isArray(obj)) return obj.map(prune);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const p = prune(v);
      const empty = p && typeof p === "object" && !Object.keys(p).length;
      if (p !== undefined && !empty) out[k] = p;
    }
    return out;
  }
  return obj;
}

function checkSize(size, caps, format, errors, warnings) {
  if (!size || size === "auto") return;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return errors.push(`size must be "auto" or WIDTHxHEIGHT, got "${size}"`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  const s = caps.size;
  if (s.mode === "fixed") {
    if (!s.presets.includes(size)) errors.push(`size ${size} not supported; use one of ${s.presets.join(", ")}`);
    return;
  }
  if (w % s.multiple || h % s.multiple) errors.push(`size ${size}: width and height must be multiples of ${s.multiple}`);
  if (format === "gif") return; // GIF frames have their own limits, enforced by the API's pixel budget.
  if (Math.max(w, h) > s.maxEdge) errors.push(`size ${size}: longest edge must be <= ${s.maxEdge}`);
  if (Math.max(w, h) / Math.min(w, h) > s.maxRatio) errors.push(`size ${size}: aspect ratio must be within 1:${s.maxRatio}..${s.maxRatio}:1`);
  const px = w * h;
  if (px < s.minPixels || px > s.maxPixels)
    errors.push(`size ${size}: total pixels ${px} must be between ${s.minPixels} and ${s.maxPixels}`);
  if (s.experimentalAbovePixels && px > s.experimentalAbovePixels)
    warnings.push(`size ${size} is above 2560x1440 and is experimental for ${caps.id}`);
}

function oneOf(name, value, allowed, model, errors) {
  if (value !== undefined && !allowed.includes(value))
    errors.push(`${name}="${value}" is not supported by ${model}; allowed: ${allowed.join(", ")}`);
}

// kind: "generate" | "edit" | "respond"
export function validate(kind, fields, caps, ctx = {}) {
  const errors = [];
  const warnings = [];
  const model = caps.id;
  const format = fields.output_format ?? "png";
  const endpoint = kind === "respond" ? "responsesTool" : kind;
  const isGif = format === "gif";
  const isSvg = format === "svg";

  if (!caps.endpoints[endpoint]) errors.push(`${model} does not support ${kind}`);
  if (caps.deprecated) warnings.push(`${model} is deprecated; prefer gpt-image-2.6-flare or gpt-image-2.6-sunburst`);

  oneOf("quality", fields.quality, caps.qualities, model, errors);
  oneOf("background", fields.background, caps.backgrounds, model, errors);
  oneOf("moderation", fields.moderation, ["auto", "low"], model, errors);
  oneOf("output_format", fields.output_format, caps.formats[kind], model, errors);

  if (fields.n !== undefined && (fields.n < 1 || fields.n > caps.maxN)) errors.push(`n must be 1..${caps.maxN}`);
  if (fields.output_compression !== undefined) {
    if (!["jpeg", "webp"].includes(format)) errors.push("compression only applies to jpeg or webp output");
    if (fields.output_compression < 0 || fields.output_compression > 100) errors.push("compression must be 0..100");
  }
  if (fields.background === "transparent") {
    if (!["png", "webp", "svg"].includes(format)) errors.push(`transparent background requires png or webp output (got ${format})`);
  }
  if (fields.partial_images !== undefined && (fields.partial_images < 0 || fields.partial_images > caps.maxPartialImages))
    errors.push(`partial-images must be 0..${caps.maxPartialImages}`);

  if (fields.complexity !== undefined) {
    if (!caps.complexity) errors.push(`complexity is not supported by ${model} (GPT-Image-2.6 models only)`);
    else oneOf("complexity", fields.complexity, caps.complexity, model, errors);
  }

  const gifOnly = fields.frame_count !== undefined || fields.frame_duration_ms !== undefined;
  if (gifOnly && !isGif) errors.push("frames / frame-duration require --format gif");
  if (isGif && caps.gif) {
    const [fMin, fMax] = caps.gif.frameCount;
    const [dMin, dMax] = caps.gif.frameDurationMs;
    if (fields.frame_count !== undefined && (fields.frame_count < fMin || fields.frame_count > fMax)) errors.push(`frames must be ${fMin}..${fMax}`);
    if (fields.frame_duration_ms !== undefined && (fields.frame_duration_ms < dMin || fields.frame_duration_ms > dMax))
      errors.push(`frame-duration must be ${dMin}..${dMax} ms`);
    if (ctx.mask) errors.push("GIF output cannot be combined with a mask");
  }
  if (fields.svg && !isSvg) errors.push("svg-model / svg-effort require --format svg");
  if (isSvg && fields.n !== undefined && fields.n !== 1) errors.push("SVG output requires n=1");
  if ((isSvg || isGif) && (ctx.stream || fields.partial_images)) errors.push(`${format.toUpperCase()} output does not support streaming or partial images`);
  if ((isSvg || isGif) && fields.output_compression !== undefined) errors.push(`${format.toUpperCase()} output does not support compression`);

  if (fields.input_fidelity !== undefined) {
    if (kind !== "edit") errors.push("input-fidelity only applies to edits");
    else if (!caps.inputFidelity) errors.push(`input-fidelity is not supported by ${model}; omit it (inputs are always high fidelity)`);
    else oneOf("input_fidelity", fields.input_fidelity, caps.inputFidelity, model, errors);
  }
  if (ctx.mask && !caps.mask) errors.push(`${model} does not support masks`);
  if (ctx.markup && !caps.markup) errors.push(`${model} does not support markup-guided edits`);
  if (ctx.markup && caps.markup === "undocumented")
    warnings.push(`markup is not documented for ${model} (accepted by the API in testing); prefer a 2.5 / 2.6 model`);
  if (ctx.mask && ctx.markup) errors.push("mask and markup cannot be combined");
  if (ctx.imageCount !== undefined && ctx.imageCount > caps.maxInputImages) errors.push(`at most ${caps.maxInputImages} input images`);

  checkSize(fields.size, caps, format, errors, warnings);
  return { errors, warnings };
}
