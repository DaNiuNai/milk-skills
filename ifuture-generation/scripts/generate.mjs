#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BASE_URL, GenerationError, ensure, kind, idPath, prepareRequest, validateRequest,
  readText, readJson, saveJson, createClient, taskOf, taskExitCode, uploadMetadata,
} from './client.mjs';

const COMMANDS = {
  'check-config': [],
  models: ['kind', 'out'],
  files: ['kind', 'query', 'limit', 'cursor', 'out'],
  prepare: ['models', 'model', 'mode', 'prompt', 'prompt-file', 'parameters', 'inputs', 'out'],
  quote: ['kind', 'request', 'out'],
  create: ['kind', 'request', 'out'],
  task: ['id', 'out'],
  wait: ['id', 'interval-sec', 'max-wait-sec', 'out'],
  'cancel-task': ['id', 'out'],
  upload: ['file', 'state', 'out'],
  'finalize-upload': ['object-id', 'out'],
  'cancel-upload': ['object-id', 'out'],
  'download-url': ['asset-id', 'attachment', 'out'],
  download: ['asset-id', 'out'],
  'download-task': ['id', 'out-dir', 'include-auxiliary'],
};
const BOOLEANS = ['help', 'dry-run', 'attachment', 'include-auxiliary'];
const COMMON = ['help', 'dry-run', 'timeout-sec', 'max-retries'];
const HELP = `无限画布文件生成（Node.js 24，无 npm 依赖）
环境变量：IFUTURE_API_KEY；接口固定 ${BASE_URL}

node generate.mjs <命令> [选项]
  check-config                            离线检查凭据是否配置，不回显值
  models [--kind image|video|audio]        查询模型、模式及参数契约
  files [--kind ...] [--query ...] [--limit 1..50] [--cursor ...]
  prepare --models models.json --model ID --out request.json
          [--mode KEY] [--prompt 文本 | --prompt-file prompt.txt]
          [--parameters params.json] [--inputs inputs.json]
  quote --kind ... --request request.json  不扣费报价，自动移除 UUID
  create --kind ... --request request.json --out accepted.json
  task --id TASK_ID                       查询一次任务
  wait --id TASK_ID [--interval-sec 3] [--max-wait-sec 1800] [--out task.json]
  cancel-task --id TASK_ID                主动取消不自动退款
  upload --file reference.png --state upload-state.json
  finalize-upload --object-id OBJECT_ID   确认结果 id 才是 assetId
  cancel-upload --object-id OBJECT_ID
  download-url --asset-id ASSET_ID [--attachment]
  download --asset-id ASSET_ID --out ./result.png
  download-task --id TASK_ID --out-dir ./results [--include-auxiliary]

通用：--help；--dry-run 离线预览，不读取 Key、不联网、不写文件
网络：--timeout-sec 60（每次尝试，含读响应）；--max-retries 2（0..5）
JSON 输出命令支持 --out；不覆盖已有文件。create 必须指定 --out。
prepare 仅写请求文件，不发送。create 始终读取已有请求文件，重试保持原 UUID 与内容。
upload 的申请不自动重试；先持久化申请结果，再进行无 Key 的 OSS 直传。
wait 退出码：0 成功，9 失败或取消，10 客户端等待超时（不会取消任务）。
`;

function parse(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help') return { command: 'help', values: {} };
  ensure(Object.hasOwn(COMMANDS, command), '未知命令；使用 --help 查看');
  const options = Object.fromEntries([...COMMON, ...COMMANDS[command]].map((name) => [name, { type: BOOLEANS.includes(name) ? 'boolean' : 'string' }]));
  let values;
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
    // parseArgs 默认允许重复，显式拒绝，防止关键选项被后值覆盖。
    const names = args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]);
    ensure(new Set(names).size === names.length, '不允许重复选项');
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError('命令参数无效；使用命令 --help 查看');
  }
  return { command, values };
}

function required(values, name) {
  ensure(typeof values[name] === 'string' && values[name].trim(), `必须提供 --${name}`);
  return values[name];
}

function number(values, name, fallback) {
  if (values[name] === undefined) return fallback;
  ensure(values[name].trim().length > 0 && Number.isFinite(Number(values[name])), `--${name} 必须是数字`);
  return Number(values[name]);
}

async function newTarget(file) {
  try { await fs.lstat(path.resolve(file)); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new GenerationError('无法检查输出路径', 8);
  }
  throw new GenerationError(`输出已存在：${path.resolve(file)}`, 8);
}

export async function runCLI(argv, { client, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { command, values: v } = parse(argv);
    if (command === 'help' || v.help) { stdout.write(HELP); return 0; }
    const dry = Boolean(v['dry-run']);
    const report = (data) => stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    const preview = (data) => { report({ dryRun: true, ...data }); return 0; };
    const timeoutSec = number(v, 'timeout-sec', 60);
    const maxRetries = number(v, 'max-retries', 2);
    // dry-run 也校验网络选项，但不会读取环境变量。
    const api = client ?? createClient({ timeoutSec, maxRetries });
    if (command === 'check-config') {
      if (dry) return preview({ baseUrl: BASE_URL });
      report({ baseUrl: BASE_URL, apiKeyConfigured: Boolean(process.env.IFUTURE_API_KEY?.trim()) });
      return 0;
    }
    if (v.out) await newTarget(v.out);
    const emit = async (data) => {
      if (v.out) report({ savedTo: await saveJson(v.out, data) });
      else report(data);
    };

    if (command === 'prepare') {
      const models = (await readJson(required(v, 'models'))).value;
      ensure(!(v.prompt !== undefined && v['prompt-file'] !== undefined), '--prompt 和 --prompt-file 只能选一项');
      const prompt = v['prompt-file'] ? await readText(v['prompt-file']) : v.prompt ?? '';
      const prepared = prepareRequest({
        models, modelId: required(v, 'model'), modeKey: v.mode, prompt,
        parameters: v.parameters ? (await readJson(v.parameters)).value : {},
        inputs: v.inputs ? (await readJson(v.inputs)).value : [],
      });
      required(v, 'out');
      if (dry) return preview(prepared);
      report({ kind: prepared.kind, requestFile: await saveJson(v.out, prepared.request) });
      return 0;
    }

    if (command === 'quote' || command === 'create') {
      const file = required(v, 'request');
      const { value: request, raw } = await readJson(file);
      validateRequest(request);
      const outputKind = kind(required(v, 'kind'));
      const endpoint = `/${outputKind}${command === 'quote' ? '/quote' : ''}`;
      const body = command === 'quote' ? { modelConfigId: request.modelConfigId, input: request.input } : raw;
      if (command === 'create') required(v, 'out');
      if (dry) return preview({ endpoint: BASE_URL + endpoint, requestFile: path.resolve(file), body: command === 'create' ? request : body });
      const response = await api.api(endpoint, { method: 'POST', body, expected: command === 'create' ? 202 : 200 });
      if (command === 'create') stderr.write(`taskId=${taskOf(response).id}；保存响应失败时可用此 ID 续查\n`);
      await emit(response);
      return command === 'create' ? taskExitCode(response) : 0;
    }

    if (command === 'upload') {
      const file = required(v, 'file');
      const state = required(v, 'state');
      const metadata = await uploadMetadata(file);
      await newTarget(state);
      ensure(!v.out || path.resolve(v.out) !== path.resolve(state), '--out 与 --state 不能相同');
      if (dry) return preview({ endpoint: BASE_URL + '/file-uploads', metadata, stateFile: path.resolve(state) });
      await saveJson(state, { file: path.resolve(file), metadata, status: 'requesting' });
      const reservation = await api.api('/file-uploads', { method: 'POST', body: metadata, retry: false });
      idPath(reservation.objectId);
      stderr.write(`objectId=${reservation.objectId}；确认响应的 id 才是 assetId\n`);
      await saveJson(state, { file: path.resolve(file), metadata, reservation, status: 'reserved' }, { replace: true });
      await api.transferUpload(reservation, file, metadata.contentType);
      await saveJson(state, { file: path.resolve(file), metadata, reservation, status: 'uploaded' }, { replace: true });
      const asset = await api.api(`/file-uploads/${idPath(reservation.objectId)}/finalize`, { method: 'POST' });
      idPath(asset.id);
      await saveJson(state, { file: path.resolve(file), metadata, objectId: reservation.objectId, asset, status: 'finalized' }, { replace: true });
      await emit(asset);
      return 0;
    }

    if (command === 'wait') {
      const taskId = required(v, 'id');
      idPath(taskId);
      const intervalSec = number(v, 'interval-sec', 3);
      const maxWaitSec = number(v, 'max-wait-sec', 1800);
      ensure(intervalSec >= 2 && intervalSec <= 5 && maxWaitSec > 0, '轮询间隔必须为 2–5 秒，等待上限必须大于 0');
      if (dry) return preview({ taskId, intervalSec, maxWaitSec });
      if (v.out) await saveJson(v.out, { taskId, status: 'waiting' });
      const response = await api.waitTask(taskId, {
        intervalSec, maxWaitSec,
        onUpdate: async (data) => { if (v.out) await saveJson(v.out, data, { replace: true }); },
      });
      if (v.out) report({ savedTo: path.resolve(v.out), taskId, status: taskOf(response).status });
      else report(response);
      return taskExitCode(response);
    }

    if (command === 'download') {
      const assetId = required(v, 'asset-id');
      idPath(assetId);
      const out = required(v, 'out');
      if (dry) return preview({ assetId, out: path.resolve(out) });
      report({ assetId, savedTo: await api.downloadAsset(assetId, out) });
      return 0;
    }

    if (command === 'download-task') {
      const taskId = required(v, 'id');
      idPath(taskId);
      const directory = path.resolve(required(v, 'out-dir'));
      const manifestFile = path.join(directory, 'task.json');
      await newTarget(manifestFile);
      if (dry) return preview({ taskId, directory, includeAuxiliary: Boolean(v['include-auxiliary']) });
      const response = await api.api(`/tasks/${idPath(taskId)}`);
      const task = taskOf(response);
      ensure(task.status === 'succeeded', '任务尚未成功，请先查询状态、failure 与 billing；不会重新生成', 9);
      ensure(Array.isArray(task.outputAssets) && task.outputAssets.length > 0, '成功任务缺少主结果文件', 6);
      await saveJson(manifestFile, response);
      const results = [];
      const groups = [['output', task.outputAssets], ...(v['include-auxiliary'] ? [['auxiliary', task.auxiliaryAssets ?? []]] : [])];
      for (const [tag, assets] of groups) {
        for (const [index, asset] of assets.entries()) {
          idPath(asset.id);
          const name = String(asset.originalFileName || asset.id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || 'file';
          const file = path.join(directory, `${tag}-${index + 1}-${name}`);
          const savedTo = await api.downloadAsset(asset.id, file);
          results.push({ assetId: asset.id, savedTo });
          stderr.write(`已保存 ${savedTo}\n`);
        }
      }
      report({ taskId, taskFile: manifestFile, results });
      return 0;
    }

    let endpoint;
    let method = 'GET';
    if (command === 'models' || command === 'files') {
      const query = new URLSearchParams();
      if (v.kind !== undefined) query.set('kind', kind(v.kind));
      if (v.query !== undefined) {
        ensure(v.query.trim().length <= 100, 'query 去除首尾空白后最长 100 字符');
        query.set('query', v.query.trim());
      }
      if (v.limit !== undefined) {
        const limit = number(v, 'limit');
        ensure(Number.isInteger(limit) && limit >= 1 && limit <= 50, 'limit 必须是 1–50 的整数');
        query.set('limit', String(limit));
      }
      if (v.cursor !== undefined) query.set('cursor', v.cursor);
      endpoint = `/${command}${query.size ? '?' + query.toString() : ''}`;
    } else if (command === 'task' || command === 'cancel-task') {
      endpoint = `/tasks/${idPath(required(v, 'id'))}${command === 'cancel-task' ? '/cancel' : ''}`;
      if (command === 'cancel-task') method = 'POST';
    } else if (command === 'finalize-upload' || command === 'cancel-upload') {
      endpoint = `/file-uploads/${idPath(required(v, 'object-id'))}/${command === 'finalize-upload' ? 'finalize' : 'cancel'}`;
      method = 'POST';
    } else if (command === 'download-url') {
      endpoint = `/files/${idPath(required(v, 'asset-id'))}/download-url${v.attachment ? '?attachment=1' : ''}`;
    }
    if (dry) return preview({ endpoint: BASE_URL + endpoint, method });
    const response = await api.api(endpoint, { method });
    if (command === 'task' || command === 'cancel-task') taskOf(response);
    await emit(response);
    return command === 'task' || command === 'cancel-task' ? taskExitCode(response) : 0;
  } catch (error) {
    stderr.write(`${error instanceof GenerationError ? error.message : '内部错误；检查本地路径与运行环境'}\n`);
    return error instanceof GenerationError ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCLI(process.argv.slice(2));
}
