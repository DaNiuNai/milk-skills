const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-2.5";
const MAX_IMAGE_BYTES = 50_000_000;
const EXTENSIONS = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};
const MIME_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class ImageApiError extends Error {
  constructor(message, exitCode, details = {}) {
    super(message);
    this.name = "ImageApiError";
    this.exitCode = exitCode;
    Object.assign(this, details);
  }
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ImageApiError("base URL 无效，请提供完整的 API 根地址。", 3);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ImageApiError("base URL 不得包含凭据、查询参数或片段。", 3);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new ImageApiError(
      "API 必须使用 HTTPS；仅回环地址的本地服务允许 HTTP。",
      3,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function resolveConfig(options = {}, environment = process.env) {
  const baseUrl = parseBaseUrl(
    options.baseUrl ?? (environment.OPENAI_BASE_URL || DEFAULT_BASE_URL),
  );
  const model =
    options.model ?? (environment.OPENAI_IMAGE_MODEL || DEFAULT_MODEL);
  if (typeof model !== "string" || !model.trim()) {
    throw new ImageApiError("模型名称不能为空。", 2);
  }
  const apiKey = environment.OPENAI_API_KEY;
  if (
    apiKey &&
    (typeof apiKey !== "string" || /[\s\x00-\x1f\x7f]/.test(apiKey))
  ) {
    throw new ImageApiError(
      "OPENAI_API_KEY 含有空白或控制字符，请在本机检查配置。",
      3,
    );
  }
  return { baseUrl, model, apiKey: apiKey || "" };
}

function describeConfig(options = {}) {
  const { baseUrl, model, apiKey } = resolveConfig(options);
  return { baseUrl, model, apiKeyConfigured: Boolean(apiKey) };
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    return "png";
  if (
    buffer.length >= 3 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255
  )
    return "jpeg";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

function validateImage(buffer, exitCode = 7) {
  const type = detectImageType(buffer);
  let valid = false;
  if (type === "png") {
    let offset = 8;
    let hasHeader = false;
    let hasData = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const chunk = buffer.toString("ascii", offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (end > buffer.length) break;
      if (offset === 8) {
        hasHeader =
          chunk === "IHDR" &&
          length === 13 &&
          buffer.readUInt32BE(offset + 8) > 0 &&
          buffer.readUInt32BE(offset + 12) > 0;
        if (!hasHeader) break;
      }
      if (chunk === "IDAT" && length > 0) hasData = true;
      if (chunk === "IEND") {
        valid = hasHeader && hasData && length === 0 && end === buffer.length;
        break;
      }
      offset = end;
    }
  } else if (type === "jpeg") {
    valid =
      buffer.length > 4 &&
      buffer[buffer.length - 2] === 255 &&
      buffer[buffer.length - 1] === 217;
  } else if (type === "webp") {
    valid =
      buffer.length >= 20 &&
      buffer.readUInt32LE(4) + 8 === buffer.length &&
      ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16));
  }
  if (!valid) {
    throw new ImageApiError(
      "图片不是受支持的 PNG/JPEG/WebP，或文件结构不完整。",
      exitCode,
    );
  }
  return type;
}

async function requireUnusedPath(filePath) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new ImageApiError("无法检查输出路径，请检查目录权限。", 8);
  }
  throw new ImageApiError("输出路径已存在；不会覆盖，请选择新文件名。", 8);
}

async function prepareRequest(options) {
  const config = resolveConfig(options);
  if (typeof options.prompt !== "string" || !options.prompt.trim()) {
    throw new ImageApiError("请提供非空 prompt。", 2);
  }
  if (typeof options.out !== "string" || !options.out.trim()) {
    throw new ImageApiError("请提供输出文件路径。", 2);
  }
  const out = path.resolve(options.out);
  const extension = path.extname(out).toLowerCase();
  if (!Object.hasOwn(EXTENSIONS, extension)) {
    throw new ImageApiError(
      "输出路径必须以 .png、.jpg、.jpeg 或 .webp 结尾。",
      2,
    );
  }
  const format = options.outputFormat ?? EXTENSIONS[extension];
  if (
    !Object.values(EXTENSIONS).includes(format) ||
    format !== EXTENSIONS[extension]
  ) {
    throw new ImageApiError(
      "output-format 必须为 png/jpeg/webp，并与输出扩展名一致。",
      2,
    );
  }
  const timeoutSec = options.timeoutSec ?? 300;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 3600) {
    throw new ImageApiError("timeout-sec 必须大于 0 且不超过 3600 秒。", 2);
  }
  const refs = options.refs ?? [];
  if (
    !Array.isArray(refs) ||
    refs.length > 16 ||
    refs.some((ref) => typeof ref !== "string" || !ref.trim())
  ) {
    throw new ImageApiError("ref 必须为本地文件路径，最多 16 张参考图。", 2);
  }
  const parameters = { output_format: format };
  if (options.size !== undefined) {
    if (
      typeof options.size !== "string" ||
      !/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/.test(options.size)
    ) {
      throw new ImageApiError(
        "size 应为 auto 或 WIDTHxHEIGHT；具体尺寸限制由模型决定。",
        2,
      );
    }
    parameters.size = options.size;
  }
  if (options.quality !== undefined) {
    if (
      typeof options.quality !== "string" ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(options.quality)
    ) {
      throw new ImageApiError(
        "quality 应为非空质量标识，例如 low、medium、high 或 auto。",
        2,
      );
    }
    parameters.quality = options.quality;
  }
  if (options.background !== undefined) {
    if (!["auto", "opaque", "transparent"].includes(options.background)) {
      throw new ImageApiError(
        "background 必须为 auto、opaque 或 transparent。",
        2,
      );
    }
    if (options.background === "transparent" && format === "jpeg") {
      throw new ImageApiError("透明背景需要 PNG 或 WebP，不能使用 JPEG。", 2);
    }
    parameters.background = options.background;
  }
  await requireUnusedPath(out);
  const images = [];
  for (const ref of refs) {
    const filePath = path.resolve(ref);
    let buffer;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size >= MAX_IMAGE_BYTES) {
        throw new ImageApiError("参考图必须是小于 50 MB 的普通图片文件。", 4);
      }
      buffer = await fs.readFile(filePath);
    } catch (error) {
      if (error instanceof ImageApiError) throw error;
      throw new ImageApiError("无法读取参考图，请检查文件路径与权限。", 4);
    }
    if (buffer.length >= MAX_IMAGE_BYTES)
      throw new ImageApiError("参考图必须小于 50 MB。", 4);
    const type = validateImage(buffer, 4);
    images.push({ filePath, buffer, type });
  }
  const operation = images.length ? "edits" : "generations";
  return {
    config,
    out,
    timeoutSec,
    parameters,
    images,
    endpoint: `${config.baseUrl}/images/${operation}`,
    prompt: options.prompt,
  };
}

async function previewRequest(options) {
  const request = await prepareRequest(options);
  return {
    ...describeConfig(options),
    endpoint: request.endpoint,
    prompt: request.prompt,
    refs: request.images.map((image) => image.filePath),
    out: request.out,
    parameters: { n: 1, ...request.parameters },
    timeoutSec: request.timeoutSec,
  };
}

async function readLimited(response, limit) {
  if (!response.body) throw new ImageApiError("服务返回空响应。", 7);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit)
      throw new ImageApiError("服务返回的数据超过单图大小上限。", 7);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new ImageApiError("API 返回的 b64_json 不是有效的标准 base64。", 7);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length > MAX_IMAGE_BYTES || buffer.toString("base64") !== value) {
    throw new ImageApiError("API 返回的图片编码无效或超过 50 MB。", 7);
  }
  return buffer;
}

function httpError(status) {
  const reason =
    {
      400: "请求参数或模型不受支持，请核对服务文档与模型名",
      401: "认证失败，请在本机检查 OPENAI_API_KEY",
      403: "没有访问该模型或服务的权限",
      404: "模型或接口不存在，请核对模型名和 API 根地址",
      429: "触发限流或额度不足",
    }[status] || (status >= 500 ? "服务端错误" : "API 请求被拒绝");
  return new ImageApiError(`HTTP ${status}：${reason}；未自动重试。`, 5, {
    status,
  });
}

async function downloadImage(rawUrl, endpoint, signal) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageApiError("API 返回的图片 URL 无效。", 7);
  }
  const apiUrl = new URL(endpoint);
  const localHttp =
    url.protocol === "http:" &&
    isLoopback(url.hostname) &&
    url.origin === apiUrl.origin;
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !localHttp)
  ) {
    throw new ImageApiError(
      "拒绝下载不安全的图片 URL；需要 HTTPS 或同源本地回环服务。",
      7,
    );
  }
  // 图片 URL 可能是带签名的 CDN 地址，不向它发送 API Key，也不跟随重定向。
  const response = await fetch(url, {
    signal,
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok)
    throw new ImageApiError(
      `图片下载失败（HTTP ${response.status}）；未自动重试。`,
      6,
    );
  return readLimited(response, MAX_IMAGE_BYTES);
}

async function generateImage(options = {}) {
  const request = await prepareRequest(options);
  if (!request.config.apiKey) {
    throw new ImageApiError(
      "缺少 OPENAI_API_KEY；请在本机配置，不要把密钥粘贴到对话中。",
      3,
    );
  }
  const fields = {
    model: request.config.model,
    prompt: request.prompt,
    n: 1,
    ...request.parameters,
  };
  const headers = { Authorization: `Bearer ${request.config.apiKey}` };
  let body;
  if (request.images.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields))
      body.append(key, String(value));
    for (const image of request.images) {
      body.append(
        "image[]",
        new Blob([image.buffer], { type: MIME_TYPES[image.type] }),
        path.basename(image.filePath),
      );
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutSec * 1000);
  let buffer;
  try {
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    const bytes = await readLimited(
      response,
      Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1_000_000,
    );
    let result;
    try {
      result = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ImageApiError(
        "API 未返回有效 JSON；不接受 HTML、SSE 或流式预览作为成品。",
        7,
      );
    }
    if (!result || !Array.isArray(result.data) || result.data.length !== 1) {
      throw new ImageApiError("API 未返回恰好一张最终图片（data 数组）。", 7);
    }
    const image = result.data[0];
    if (image && typeof image.b64_json === "string" && image.b64_json) {
      buffer = decodeBase64(image.b64_json);
    } else if (image && typeof image.url === "string" && image.url) {
      buffer = await downloadImage(
        image.url,
        request.endpoint,
        controller.signal,
      );
    } else {
      throw new ImageApiError("API 未返回最终图片的 b64_json 或 URL。", 7);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageApiError(
        "请求或下载超时；服务端可能已生成并计费，请先核对账单，未自动重试。",
        6,
      );
    }
    if (error instanceof ImageApiError) throw error;
    // 不回显远端响应体和底层网络异常，防止兼容服务把密钥回显进日志。
    throw new ImageApiError(
      "网络请求失败；服务端状态和计费状态未知，未自动重试。",
      6,
    );
  } finally {
    clearTimeout(timer);
  }
  const type = validateImage(buffer);
  const extension = path.extname(request.out);
  const finalPath =
    EXTENSIONS[extension.toLowerCase()] === type
      ? request.out
      : `${request.out.slice(0, -extension.length)}.${type === "jpeg" ? "jpg" : type}`;
  await requireUnusedPath(finalPath);
  try {
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, buffer, { flag: "wx" });
  } catch {
    throw new ImageApiError(
      "无法保存图片，可能是文件已存在或目录不可写；API 已完成，请勿盲目再次生成。",
      8,
    );
  }
  return finalPath;
}

module.exports = {
  generateImage,
  ImageApiError,
  resolveConfig,
  describeConfig,
  previewRequest,
};
