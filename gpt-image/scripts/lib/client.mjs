import http from "node:http";

export class ApiError extends Error {
  constructor({ status, error, requestId, message }) {
    super(message ?? error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.type = error?.type;
    this.code = error?.code;
    this.param = error?.param;
    this.moderationDetails = error?.moderation_details;
    this.requestId = requestId;
  }

  get retryable() {
    if (this.type === "image_generation_user_error" || this.code === "insufficient_quota") return false;
    return this.status === undefined || [408, 409, 429].includes(this.status) || this.status >= 500;
  }
}

export function setupProxy(proxy) {
  if (!proxy || proxy === "none") return null;
  if (typeof http.setGlobalProxyFromEnv !== "function") {
    throw new Error(
      "This Node.js version cannot configure a proxy in-process. Use Node >= 24.5, or run with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set.",
    );
  }
  http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: process.env.NO_PROXY ?? "localhost,127.0.0.1" });
  return proxy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ apiKey, baseUrl, timeoutMs, maxRetries, log = () => {} }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
  const root = baseUrl.replace(/\/+$/, "");

  async function send(path, { body, form, method = "POST" }) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(`${root}${path}`, {
        method,
        headers,
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err.cause?.code ?? err.name;
      throw new ApiError({ message: `Network error (${cause}): ${err.message}. Check the proxy setting and connectivity.` });
    }
    if (!res.ok) {
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: text.slice(0, 500) } };
      }
      const err = new ApiError({ status: res.status, error: payload.error, requestId: res.headers.get("x-request-id") });
      err.retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw err;
    }
    return res;
  }

  async function request(path, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(path, opts);
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retryable || attempt >= maxRetries) throw err;
        const wait = (err.retryAfter ?? 2 ** (attempt + 1)) * 1000;
        log(`Request failed (${err.status ?? "network"}: ${err.message}); retrying in ${wait / 1000}s...`);
        await sleep(wait);
      }
    }
  }

  return {
    async json(path, opts) {
      const res = await request(path, opts);
      return { data: await res.json(), requestId: res.headers.get("x-request-id") };
    },
    async *sse(path, opts) {
      const res = await request(path, opts);
      let buffer = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk.replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evt = parseEvent(raw);
          if (evt && process.env.GPT_IMAGE_DEBUG) log(`event: ${evt.event}`);
          if (evt) yield evt;
        }
      }
      const tail = parseEvent(buffer);
      if (tail) yield tail;
    },
  };
}

function parseEvent(raw) {
  let event;
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const text = data.join("\n");
  if (text === "[DONE]") return null;
  const payload = JSON.parse(text);
  return { event: event ?? payload.type, data: payload };
}
