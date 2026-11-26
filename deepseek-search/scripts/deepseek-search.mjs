#!/usr/bin/env node
// DeepSeek Search / Fetch API 命令行工具（零依赖，Node >= 18）
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const HELP = `用法:
  node deepseek-search.mjs search <query...> [选项]
  node deepseek-search.mjs fetch <url...> [选项]

search 选项:
  -n, --count <1-50>        返回条数（默认 10）
  -c, --content             同时返回网页正文（content 字段）
  -q, --ori-question <text> 用户原始问题，帮助理解搜索意图（≤128 字符）
      --localization <ip>   优先返回该 IP 所在地区的本地化结果
      --brief               只输出 snippet 短摘要（默认输出 summary 长摘要）
      --min-score <n>       过滤 rerank_score 低于该值的结果

fetch 选项（可一次传多个 URL，并行抓取）:
      --max-chars <n>       每个页面最多输出多少字符（默认 20000，0 = 不截断）
  -o, --out <path>          把完整正文写入文件（多个 URL 时为目录）

通用选项:
      --json                输出原始 JSON
      --api-key <key>       覆盖 DEEPSEEK_API_KEY 环境变量
      --base-url <url>      覆盖 DEEPSEEK_BASE_URL（默认 https://api.deepseek.com）
      --retries <n>         408/429/5xx 时的重试次数（默认 3）
  -h, --help`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: "string", short: "n" },
    content: { type: "boolean", short: "c" },
    "ori-question": { type: "string", short: "q" },
    localization: { type: "string" },
    brief: { type: "boolean" },
    "min-score": { type: "string" },
    "max-chars": { type: "string" },
    out: { type: "string", short: "o" },
    json: { type: "boolean" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    retries: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
if (opt.help || !cmd) {
  console.log(HELP);
  process.exit(opt.help ? 0 : 1);
}

const fail = (msg) => {
  console.error(`错误: ${msg}`);
  process.exit(1);
};

const apiKey = opt["api-key"] || process.env.DEEPSEEK_API_KEY;
if (!apiKey) fail("未找到 API Key，请设置环境变量 DEEPSEEK_API_KEY 或使用 --api-key");
const baseUrl = (opt["base-url"] || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const retries = Number(opt.retries ?? 3);

async function call(path, body) {
  for (let attempt = 0; ; attempt++) {
    let status, data;
    try {
      const res = await fetch(`${baseUrl}/v1/tools/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (res.ok) return data;
    } catch (e) {
      status = 0;
      data = { error: { message: e.message } };
    }
    const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    if (!retryable || attempt >= retries) {
      const msg = data?.error?.message || data?.raw || "未知错误";
      const err = new Error(`HTTP ${status || "网络错误"}: ${msg}`);
      err.status = status;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function search() {
  const query = args.join(" ").trim();
  if (!query) fail("缺少搜索词");
  const body = { query, count: opt.count ? Number(opt.count) : 10, need_content: !!opt.content };
  if (opt["ori-question"]) body.ori_question = opt["ori-question"];
  if (opt.localization) body.localization = opt.localization;

  const data = await call("search", body);
  let results = data.results || [];
  if (opt["min-score"]) results = results.filter((r) => r.rerank_score >= Number(opt["min-score"]));
  if (opt.json) return console.log(JSON.stringify({ query, results }, null, 2));
  if (!results.length) return console.log(`未找到与「${query}」相关的结果。`);

  const out = [`# 搜索: ${query}  （${results.length} 条结果）`, ""];
  results.forEach((r, i) => {
    const meta = [
      `score ${r.rerank_score?.toFixed(2)}`,
      `authority ${r.authority}`,
      r.date && r.date.slice(0, 10),
      r.site_name,
    ].filter(Boolean).join(" · ");
    out.push(`## [${i + 1}] ${r.title}`, `URL: ${r.url}`, `(${meta})`, "");
    out.push((opt.brief ? r.snippet : r.summary || r.snippet || "").trim());
    if (opt.content && r.content) out.push("", "### 正文", r.content.trim());
    out.push("");
  });
  console.log(out.join("\n"));
}

async function fetchPages() {
  if (!args.length) fail("缺少 URL");
  const maxChars = Number(opt["max-chars"] ?? 20000);
  const pages = await Promise.all(
    args.map((url) =>
      call("fetch", { url })
        .then((d) => ({ url, title: d.title || "", content: d.content || "" }))
        .catch((e) => ({ url, error: e.message })),
    ),
  );

  if (opt.out) {
    const many = pages.length > 1;
    if (many) mkdirSync(opt.out, { recursive: true });
    pages.forEach((p, i) => {
      if (p.error) return;
      const file = many
        ? resolve(opt.out, `${String(i + 1).padStart(2, "0")}-${p.url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 80)}.md`)
        : resolve(opt.out);
      if (!many) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `# ${p.title}\n\nSource: ${p.url}\n\n${p.content}`, "utf8");
      p.file = file;
    });
  }

  if (opt.json) return console.log(JSON.stringify(pages.length === 1 ? pages[0] : pages, null, 2));
  const out = pages.map((p) => {
    if (p.error) return `# 抓取失败: ${p.url}\n${p.error}`;
    let body = p.content;
    let note = "";
    if (maxChars > 0 && body.length > maxChars) {
      body = body.slice(0, maxChars);
      note = `\n\n…（已截断：共 ${p.content.length} 字符，仅显示前 ${maxChars}。用 --max-chars 0 或 --out 获取全文）`;
    }
    const saved = p.file ? `\n已保存: ${p.file}` : "";
    return `# ${p.title || "(无标题)"}\nURL: ${p.url}${saved}\n\n${body}${note}`;
  });
  console.log(out.join("\n\n---\n\n"));
  if (pages.every((p) => p.error)) process.exit(1);
}

try {
  if (cmd === "search") await search();
  else if (cmd === "fetch") await fetchPages();
  else fail(`未知命令 "${cmd}"，可用: search, fetch`);
} catch (e) {
  fail(e.message);
}
