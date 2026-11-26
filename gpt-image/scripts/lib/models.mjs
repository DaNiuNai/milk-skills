// Model registry. Each family describes what the API accepts; each model points at a family.
// To add a model: add an entry to MODELS (or to config.json "models") with `extends: "<family or model>"`
// and override only the capabilities that differ.

const BASE_QUALITIES = ["auto", "low", "medium", "high"];
const EXTENDED_QUALITIES = [...BASE_QUALITIES, "xhigh", "max"];
const RASTER_FORMATS = ["png", "jpeg", "webp"];

const FLEX_SIZE = {
  mode: "flex",
  presets: ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"],
  multiple: 16,
  maxEdge: 3840,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  experimentalAbovePixels: null,
};

// Capability values: true/false, an allowed-values array, or "undocumented"
// (the API accepted it in testing but the docs don't list it -> allowed with a warning).
// Verified against the live API on 2026-11-26; see references/models.md for the test notes.
export const FAMILIES = {
  "family/gpt-image-2": {
    endpoints: { generate: true, edit: true, responsesTool: true },
    qualities: BASE_QUALITIES,
    formats: { generate: RASTER_FORMATS, edit: RASTER_FORMATS, respond: RASTER_FORMATS },
    backgrounds: ["auto", "opaque"],
    size: FLEX_SIZE,
    complexity: false,
    mask: true,
    markup: "undocumented",
    inputFidelity: false,
    maxInputImages: 16,
    maxN: 10,
    stream: true,
    maxPartialImages: 3,
    gif: null,
    svg: false,
  },
  "family/gpt-image-2.5": {
    extends: "family/gpt-image-2",
    qualities: EXTENDED_QUALITIES,
    backgrounds: ["auto", "opaque", "transparent"],
    size: { ...FLEX_SIZE, experimentalAbovePixels: 3_686_400 },
    markup: true,
  },
  "family/gpt-image-2.6": {
    extends: "family/gpt-image-2.5",
    formats: {
      generate: [...RASTER_FORMATS, "svg", "gif"],
      edit: [...RASTER_FORMATS, "gif"],
      respond: [...RASTER_FORMATS, "svg", "gif"],
    },
    complexity: ["low", "medium", "high"],
    gif: { frameCount: [2, 16], frameDurationMs: [20, 2000] },
    svg: true,
  },
};

export const MODELS = {
  "gpt-image-2.6-flare": {
    extends: "family/gpt-image-2.6",
    summary: "GPT-Image-2.6 小模型，速度最快，适合日常生成与快速迭代",
  },
  "gpt-image-2.6-sunburst": {
    extends: "family/gpt-image-2.6",
    summary: "GPT-Image-2.6 基础模型，细节、排版与编辑精度最好",
  },
  "gpt-image-2.5-flare": {
    extends: "family/gpt-image-2.5",
    summary: "GPT-Image-2.5 小模型，速度优先，画质约等于 gpt-image-2",
    snapshots: ["gpt-image-2.5-flare-2026-09-08"],
  },
  "gpt-image-2.5-sunburst": {
    extends: "family/gpt-image-2.5",
    summary: "GPT-Image-2.5 基础模型，画质优先，编辑精度高",
    snapshots: ["gpt-image-2.5-sunburst-2026-09-08"],
  },
  "gpt-image-2": {
    extends: "family/gpt-image-2",
    summary: "上一代模型（已标记 deprecated），仅维护旧工作流时使用",
    deprecated: true,
    snapshots: ["gpt-image-2-2026-04-21"],
  },
};

function resolve(name, table, seen = new Set()) {
  const entry = table[name];
  if (!entry) return null;
  if (seen.has(name)) throw new Error(`Circular "extends" in model registry: ${name}`);
  seen.add(name);
  const { extends: parent, ...own } = entry;
  const base = parent ? resolve(parent, table, seen) : {};
  if (parent && !base) throw new Error(`Model "${name}" extends unknown "${parent}"`);
  return { ...base, ...own };
}

export function buildRegistry(extraModels = {}) {
  const table = { ...FAMILIES, ...MODELS, ...extraModels };
  const registry = {};
  for (const name of [...Object.keys(MODELS), ...Object.keys(extraModels)]) {
    const caps = resolve(name, table);
    registry[name] = { id: name, ...caps };
    for (const snap of caps.snapshots ?? []) registry[snap] ??= { id: snap, ...caps, snapshotOf: name };
  }
  return registry;
}
