import { openAsBlob } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BASE_URL = 'https://api.i-future.net/v1/ai/generation';
export const KINDS = ['image', 'video', 'audio'];
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const SPECIAL_MODES = ['layer-decomposition', 'finalize-draft'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GenerationError extends Error {
  constructor(message, exitCode = 2, status) {
    super(message);
    this.name = 'GenerationError';
    this.exitCode = exitCode;
    this.status = status;
  }
}

export function ensure(condition, message, exitCode = 2) {
  if (!condition) throw new GenerationError(message, exitCode);
}

function object(value, name) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), `${name} 必须是对象`);
}

function text(value, name, max = Infinity, allowEmpty = false) {
  ensure(typeof value === 'string' && (allowEmpty || value.trim().length > 0)
    && value.length <= max, `${name} 必须是${allowEmpty ? '允许空串的' : '非空'}字符串，长度上限 ${max}`);
}

function keys(value, allowed, name) {
  object(value, name);
  ensure(Object.keys(value).every((key) => allowed.includes(key)), `${name} 存在未知字段`);
}

export function kind(value) {
  ensure(KINDS.includes(value), 'kind 必须是 image、video 或 audio');
  return value;
}

export function idPath(value) {
  text(value, 'ID', 128);
  return encodeURIComponent(value);
}

export function validateRequest(request) {
  keys(request, ['modelConfigId', 'clientRequestId', 'input'], '请求');
  text(request.modelConfigId, 'modelConfigId', 128);
  ensure(typeof request.clientRequestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.clientRequestId),
  'clientRequestId 必须是已持久化的 UUID');
  const input = request.input;
  keys(input, ['profileKey', 'modeKey', 'prompt', 'parameters', 'inputs'], 'input');
  text(input.profileKey, 'profileKey');
  text(input.modeKey, 'modeKey', 100);
  if (input.prompt !== undefined) text(input.prompt, 'prompt', 100000, true);
  object(input.parameters, 'parameters');
  const inputs = input.inputs ?? [];
  ensure(Array.isArray(inputs) && inputs.length <= 64, 'inputs 必须是最多 64 项的数组');
  for (const item of inputs) {
    keys(item, ['assetId', 'groupKey'], 'inputs 项');
    text(item.assetId, 'assetId', 128);
    text(item.groupKey, 'groupKey', 100);
  }
  return request;
}

export function prepareRequest({ models, modelId, modeKey, prompt = '', parameters = {}, inputs = [] }) {
  ensure(Array.isArray(models?.items), '模型文件必须包含 items 数组');
  const model = models.items.find((item) => item.id === modelId);
  ensure(model, 'modelConfigId 不在模型查询结果中；不得使用供应商模型名代替');
  kind(model.outputKind);
  const mode = model.modes?.find((item) => item.key === (modeKey ?? model.defaultModeKey));
  ensure(mode, '模型未返回所选模式');
  object(parameters, '用户参数');
  ensure(Array.isArray(inputs), 'inputs 必须是数组');
  text(prompt, 'prompt', Math.min(100000, mode.promptMaxLength ?? 100000), !mode.promptRequired);
  const request = validateRequest({
    modelConfigId: model.id,
    clientRequestId: randomUUID(),
    input: {
      profileKey: model.profileKey,
      modeKey: mode.key,
      prompt,
      parameters: SPECIAL_MODES.includes(mode.key) ? { ...parameters }
        : { ...model.defaultParameters, ...mode.defaultParameters, ...parameters },
      inputs,
    },
  });
  const groups = mode.inputGroups ?? [];
  for (const item of inputs) ensure(groups.some((g) => g.key === item.groupKey), '参考文件 groupKey 不属于所选模式');
  for (const group of groups) {
    const count = inputs.filter((item) => item.groupKey === group.key).length;
    ensure(count >= (group.minCount ?? 0) && count <= (group.maxCount ?? 64), `参考文件组 ${group.key} 数量不符合模式约束`);
  }
  return { kind: model.outputKind, request };
}

export async function readText(file) {
  try {
    const bytes = await fs.readFile(file);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new GenerationError(`无法读取 UTF-8 文件：${path.resolve(file)}`, 7);
  }
}

export async function readJson(file) {
  const raw = await readText(file);
  try { return { raw, value: JSON.parse(raw) }; }
  catch { throw new GenerationError(`文件不是有效 JSON：${path.resolve(file)}`, 7); }
}

export async function saveJson(file, value, { replace = false } = {}) {
  const absolute = path.resolve(file);
  let handle;
  let temporary;
  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    temporary = replace ? `${absolute}.${randomUUID()}.tmp` : absolute;
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) await fs.rename(temporary, absolute);
    return absolute;
  } catch {
    if (handle) await handle.close().catch(() => {});
    if (replace && temporary) await fs.unlink(temporary).catch(() => {});
    throw new GenerationError(`保存失败或文件已存在：${absolute}`, 8);
  }
}

export function taskOf(response) {
  ensure(response?.task && typeof response.task.id === 'string'
    && STATUSES.includes(response.task.status), '任务响应结构不合法', 6);
  return response.task;
}

export function taskExitCode(response) {
  return ['failed', 'cancelled'].includes(taskOf(response).status) ? 9 : 0;
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new GenerationError('服务未返回有效文件 URL', 6); }
  ensure(url.protocol === 'https:' && !url.username && !url.password, '文件传输 URL 必须是无内嵌凭据的 HTTPS 地址', 6);
  return url.href;
}

export function createClient({ readApiKey = () => process.env.IFUTURE_API_KEY, fetchImpl = globalThis.fetch,
  sleepImpl = sleep, now = Date.now, timeoutSec = 60, maxRetries = 2 } = {}) {
  ensure(Number.isFinite(timeoutSec) && timeoutSec > 0 && timeoutSec <= 3600, 'timeout-sec 范围为 (0, 3600]');
  ensure(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 5, 'max-retries 范围为 0–5');
  const timeoutMs = Math.ceil(timeoutSec * 1000);

  async function api(endpoint, { method = 'GET', body, retry = true, expected = 200, deadline = Infinity } = {}) {
    const apiKey = readApiKey()?.trim();
    ensure(apiKey && !/[\r\n]/.test(apiKey), '当前进程未获取到有效 IFUTURE_API_KEY；请在本机配置并重启宿主应用', 3);
    const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - now();
      ensure(remaining > 0, '客户端等待超时；服务端任务继续运行，请使用原 taskId 续查', 10);
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, remaining))));
      let response;
      let responseText;
      let failure;
      try {
        response = await fetchImpl(`${BASE_URL}${endpoint}`, {
          method, headers: { 'x-api-key': apiKey, ...(raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(raw === undefined ? {} : { body: raw }), redirect: 'error', cache: 'no-store', signal,
        });
        responseText = await response.text();
      } catch {
        failure = new GenerationError('网络或客户端超时；创建请求请保持原文件及 UUID，禁止另建请求号重试', 5);
      }
      if (!failure && response.status === expected) {
        try { return JSON.parse(responseText); }
        catch { throw new GenerationError('API 成功响应不是有效 JSON；创建请求仍应保留原 UUID', 6); }
      }
      if (!failure) {
        let details = responseText;
        try {
          const parsed = JSON.parse(responseText);
          details = parsed.message ?? parsed.error?.message ?? parsed.code
            ?? (parsed.error?.issues ? JSON.stringify(parsed.error.issues) : '请求被拒绝');
        } catch { /* 业务错误可能为纯文本。 */ }
        details = String(details).split(apiKey).join('[已隐藏密钥]').replace(/https?:\/\/\S+/g, '[URL]').slice(0, 800);
        failure = new GenerationError(`HTTP ${response.status}：${details}`, 4, response.status);
      }
      const retryable = failure.exitCode === 5 || response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retry || !retryable || attempt >= maxRetries) throw failure;
      let delay = 1000 * 2 ** attempt;
      const retryAfter = response?.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        delay = Math.max(delay, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now() || 0);
      }
      if (delay > 60000) throw failure;
      ensure(now() + delay < deadline, '客户端等待超时；请使用原 taskId 续查，未取消服务端任务', 10);
      await sleepImpl(delay);
    }
  }

  async function waitTask(taskId, { intervalSec = 3, maxWaitSec = 1800, onUpdate = async () => {} } = {}) {
    ensure(intervalSec >= 2 && intervalSec <= 5, 'interval-sec 范围为 2–5');
    ensure(Number.isFinite(maxWaitSec) && maxWaitSec > 0, 'max-wait-sec 必须大于 0');
    const deadline = now() + maxWaitSec * 1000;
    while (now() < deadline) {
      const response = await api(`/tasks/${idPath(taskId)}`, { deadline });
      const task = taskOf(response);
      await onUpdate(response);
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return response;
      ensure(now() + intervalSec * 1000 < deadline, `客户端等待超时；使用原 taskId ${taskId} 续查，任务未取消`, 10);
      await sleepImpl(intervalSec * 1000);
    }
    throw new GenerationError(`客户端等待超时；使用原 taskId ${taskId} 续查，任务未取消`, 10);
  }

  async function transferUpload(reservation, file, contentType) {
    const form = new FormData();
    object(reservation?.upload?.fields, 'upload.fields');
    for (const [name, value] of Object.entries(reservation.upload.fields)) {
      ensure(typeof value === 'string' && name !== 'file', '无效 OSS 表单字段', 6);
      form.append(name, value);
    }
    form.append('file', await openAsBlob(file, { type: contentType }), path.basename(file));
    try {
      const response = await fetchImpl(safeUrl(reservation.upload.url), {
        method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      const ok = response.ok;
      await response.body?.cancel();
      ensure(ok, `OSS 上传 HTTP ${response.status}；保留 objectId，按状态确认或取消上传`, 5);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('OSS 上传失败或超时；保留 objectId，确认成功前不要将其当作 assetId', 5);
    }
  }

  async function downloadAsset(assetId, out) {
    const absolute = path.resolve(out);
    let handle;
    try {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      handle = await fs.open(absolute, 'wx', 0o600);
    } catch { throw new GenerationError(`下载目标已存在或无法创建：${absolute}`, 8); }
    try {
      // 总是刷新签名，无需因旧 URL 过期重新生成。
      const link = await api(`/files/${idPath(assetId)}/download-url`);
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(safeUrl(link.downloadUrl), { redirect: 'error', signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new GenerationError(`文件下载 HTTP ${response.status}`, 5);
      }
      await pipeline(Readable.fromWeb(response.body), handle.createWriteStream(), { signal });
      return absolute;
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(absolute).catch(() => {});
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('下载或保存失败；使用原 assetId 重试下载，不要重新生成', 5);
    }
  }

  return { api, waitTask, transferUpload, downloadAsset };
}

const TYPES = {
  jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], png: ['image', 'image/png'],
  webp: ['image', 'image/webp'], gif: ['image', 'image/gif'], bmp: ['image', 'image/bmp'],
  tif: ['image', 'image/tiff'], tiff: ['image', 'image/tiff'], heic: ['image', 'image/heic'], heif: ['image', 'image/heif'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], m4a: ['audio', 'audio/mp4'], ogg: ['audio', 'audio/ogg'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'],
};

export async function uploadMetadata(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  const type = TYPES[extension];
  ensure(type, '不支持该上传扩展名；查看 references/api.md 的上传约束');
  let stat;
  try { stat = await fs.stat(file); }
  catch { throw new GenerationError('无法读取待上传文件', 7); }
  const [fileKind, contentType] = type;
  const maxBytes = { image: 30, audio: 50, video: 500 }[fileKind] * 1048576;
  ensure(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, `${fileKind} 文件为空、不是普通文件或超过大小上限`);
  const originalFileName = path.basename(file).trim();
  text(originalFileName, 'originalFileName', 255);
  return { kind: fileKind, originalFileName, contentType, extension, fileSizeBytes: stat.size };
}
