'use strict';

const { isIP } = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');

const BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 60_000;

class WebApiError extends Error {
  constructor(message, exitCode, details = {}) {
    super(message);
    this.name = 'WebApiError';
    this.exitCode = exitCode;
    Object.assign(this, details);
  }
}

function invalid(message) {
  throw new WebApiError(message, 2);
}

function unicodeLength(value) {
  return Array.from(value).length;
}

function validateText(value, name, { allowNull = false } = {}) {
  if (allowNull && value === null) return;
  if (typeof value !== 'string' || !value.trim()) {
    invalid(`${name} 必须是非空白字符串。`);
  }
  if (unicodeLength(value) > 128) {
    invalid(`${name} 不得超过 128 个 Unicode 字符。`);
  }
}

function validateUrl(value) {
  if (typeof value !== 'string' || !value || unicodeLength(value) > 8192) {
    invalid('url 必须是长度不超过 8192 的 HTTP/HTTPS URL。');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid('url 必须是含 host 的完整 HTTP/HTTPS URL。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    invalid('url 必须是含 host 的完整 HTTP/HTTPS URL。');
  }
  // Reject userinfo even when it is empty (https://@example.com).
  const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (parsed.username || parsed.password || authority?.includes('@')) {
    invalid('url 不得携带用户名或密码。');
  }
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    invalid('url 不得包含空白、控制字符或反斜杠；请先进行 URL 编码。');
  }
  if (authority === undefined || !authority) {
    invalid('url 必须使用 http:// 或 https:// 并包含 host。');
  }
  return value;
}

function buildSearchBody(params = {}) {
  validateText(params.query, 'query');
  const body = { query: params.query, count: params.count === undefined ? 10 : params.count };
  if (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) {
    invalid('count 必须是 1～50 的整数。');
  }
  if (params.ori_question !== undefined) {
    validateText(params.ori_question, 'ori_question', { allowNull: true });
    if (params.ori_question !== null) body.ori_question = params.ori_question;
  }
  if (params.localization !== undefined) {
    if (typeof params.localization !== 'string'
      || (params.localization !== '' && !isIP(params.localization))) {
      invalid('localization 必须为空字符串或有效的 IPv4/IPv6 地址。');
    }
    body.localization = params.localization;
  }
  body.need_content = params.need_content === undefined ? false : params.need_content;
  if (typeof body.need_content !== 'boolean') {
    invalid('need_content 必须是布尔值。');
  }
  return body;
}

function buildFetchBody(params = {}) {
  return { url: validateUrl(params.url) };
}

function validateRequestOptions(options = {}) {
  const timeoutSec = options.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : options.timeoutSec;
  const maxRetries = options.maxRetries === undefined ? DEFAULT_MAX_RETRIES : options.maxRetries;
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec)
    || timeoutSec <= 0 || timeoutSec > 3600) {
    invalid('timeout-sec 必须大于 0 且不超过 3600。');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    invalid('max-retries 必须是 0～5 的整数。');
  }
  return { timeoutSec, maxRetries };
}

function protocolError(message) {
  return new WebApiError(message, 6);
}

function validateResponse(operation, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw protocolError('API 响应不是预期的 JSON 对象。');
  }
  if (operation === 'fetch') {
    if (typeof data.title !== 'string' || typeof data.content !== 'string') {
      throw protocolError('Fetch 响应缺少字符串 title/content。');
    }
    if (!data.content.trim()) {
      throw protocolError('Fetch 未返回可用正文；不要将其作为抓取成功交付。');
    }
    return data;
  }
  if (!Array.isArray(data.results)) {
    throw protocolError('Search 响应缺少 results 数组。');
  }
  for (const result of data.results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw protocolError('Search 结果项不是对象。');
    }
    for (const key of ['title', 'url', 'snippet', 'summary', 'content']) {
      if (typeof result[key] !== 'string') {
        throw protocolError(`Search 结果缺少字符串字段 ${key}。`);
      }
    }
    for (const key of ['site_name', 'site_icon', 'date']) {
      if (result[key] !== null && typeof result[key] !== 'string') {
        throw protocolError(`Search 结果的 ${key} 应为字符串或 null。`);
      }
    }
    if (!Number.isFinite(result.rerank_score)
      || result.rerank_score < 0 || result.rerank_score > 3
      || !Number.isInteger(result.authority)
      || result.authority < -1 || result.authority > 4) {
      throw protocolError('Search 结果的 rerank_score/authority 不符合文档范围。');
    }
  }
  // Keep the API's full JSON, including additional fields; do not truncate content.
  return data;
}

const HTTP_MESSAGES = {
  400: '请求参数或请求头不合法，请修改后再试。',
  401: '鉴权失败，请在本机检查 DEEPSEEK_API_KEY；不要发送密钥到聊天。',
  402: '账号余额不足，请充值后再试。',
  403: '请求被安全策略拒绝；不要尝试绕过访问限制。',
  404: '未获取到可用网页内容，可能是 URL、站点访问策略或内容类型问题。',
  408: '服务端读取请求体超时。',
  413: '请求体超过大小限制，请缩短请求。',
  429: '触发账号或目标域名限速，请降低频率后再试。',
  500: '服务器内部错误。',
  504: '下游请求超时。',
};

function isRetryable(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMs(value, nowMs) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - nowMs);
}

/** Dependencies are injectable for offline tests. Production always uses the official host. */
function createClient({
  fetchImpl = globalThis.fetch,
  readApiKey = () => process.env.DEEPSEEK_API_KEY,
  sleepImpl = sleep,
  random = Math.random,
  now = Date.now,
} = {}) {
  async function request(operation, params, options = {}) {
    const body = operation === 'search' ? buildSearchBody(params) : buildFetchBody(params);
    const { timeoutSec, maxRetries } = validateRequestOptions(options);
    const apiKey = readApiKey();
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new WebApiError('当前进程未获取到 DEEPSEEK_API_KEY。若已配置，请完全退出并重新启动承载 Agent 的终端、编辑器或应用；仅重开会话可能不会刷新继承的环境。', 3);
    }
    if (apiKey !== apiKey.trim() || /[\u0000-\u0020\u007f]/u.test(apiKey)) {
      throw new WebApiError('DEEPSEEK_API_KEY 含空白或控制字符，请在本机检查配置。', 3);
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
      let waitMs;
      try {
        const response = await fetchImpl(`${BASE_URL}/v1/tools/${operation}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.status !== 200) {
          const status = response.status;
          const error = new WebApiError(
            `HTTP ${status}：${HTTP_MESSAGES[status] || 'API 请求失败。'}`,
            4,
            { status, attempts: attempt + 1 },
          );
          waitMs = Math.max(
            1000 * (2 ** attempt) + Math.floor(random() * 250),
            retryAfterMs(response.headers.get('retry-after'), now()),
          );
          // Never expose upstream error bodies; they may echo credentials or user input.
          await response.body?.cancel();
          if (!isRetryable(status) || attempt >= maxRetries) throw error;
          if (waitMs > MAX_RETRY_WAIT_MS) {
            error.message += ' 服务端建议等待超过 60 秒，已停止自动重试，请稍后手动重试。';
            throw error;
          }
        } else {
          let data;
          try {
            data = await response.json();
          } catch (error) {
            if (controller.signal.aborted || error?.name === 'AbortError') throw error;
            throw protocolError('API 返回了无法解析的 JSON；未保存响应正文。');
          }
          return validateResponse(operation, data);
        }
      } catch (error) {
        if (error instanceof WebApiError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new WebApiError('请求或响应读取超时；客户端超时不自动重试，服务端可能已处理并计费。', 5);
        }
        throw new WebApiError('网络连接、TLS 或重定向失败；未自动重试，请检查网络后再试。', 5);
      } finally {
        clearTimeout(timer);
      }
      await sleepImpl(waitMs);
    }
  }

  return {
    search: (params, options) => request('search', params, options),
    fetch: (params, options) => request('fetch', params, options),
  };
}

function inlineText(value) {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&');
}

function markdownUrl(value) {
  try {
    validateUrl(value);
    return `<${value.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  } catch {
    return '（无可用 HTTP/HTTPS 链接）';
  }
}

function renderMarkdown(operation, data, params) {
  if (operation === 'fetch') {
    return `# ${inlineText(data.title || '网页正文')}\n\n来源：${markdownUrl(params.url)}\n\n${data.content}\n`;
  }
  const lines = [`# 搜索：${inlineText(params.query)}`, ''];
  if (data.results.length === 0) return `${lines.join('\n')}无匹配结果。\n`;
  for (const [index, result] of data.results.entries()) {
    lines.push(
      `## ${index + 1}. ${inlineText(result.title || '无标题')}`,
      '',
      `来源：${markdownUrl(result.url)}`,
      '',
      `站点：${inlineText(result.site_name || '未知')} | 发布时间：${inlineText(result.date || '未知')} | 排序分数：${result.rerank_score} | 权威性：${result.authority}`,
      '',
      result.summary || result.snippet || '（无摘要）',
      '',
    );
    if (result.content) lines.push('### 正文', '', result.content, '');
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  BASE_URL,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_RETRIES,
  WebApiError,
  buildSearchBody,
  buildFetchBody,
  validateRequestOptions,
  validateResponse,
  createClient,
  renderMarkdown,
};
