import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BASE_URL, createClient, prepareRequest, validateRequest, saveJson, readJson,
  uploadMetadata, GenerationError,
} from '../scripts/client.mjs';
import { runCLI } from '../scripts/generate.mjs';

const FAKE_KEY = 'offline-fake-key';
const MODEL = {
  id: 'configured-image', outputKind: 'image', profileKey: 'test/profile', defaultModeKey: 'default',
  defaultParameters: { size: 'auto', quality: 'medium' },
  modes: [{ key: 'default', promptRequired: true, promptMaxLength: 100,
    defaultParameters: { quality: 'high' }, inputGroups: [{ key: 'reference', minCount: 0, maxCount: 2 }] }],
};
const request = () => prepareRequest({ models: { items: [MODEL] }, modelId: MODEL.id, prompt: '湖边日出' }).request;
const task = (status = 'queued', extra = {}) => ({ task: {
  id: 'task-1', status, outputAssets: [], auxiliaryAssets: [], warnings: [], failure: null,
  billing: { charged: '90071992547409931234', refunded: '0' }, ...extra,
}, creditBalance: '-90071992547409931233' });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const code = (exitCode) => (error) => error instanceof GenerationError && error.exitCode === exitCode;

function mock(responses, overrides = {}) {
  const calls = [];
  const waits = [];
  let clock = 0;
  const client = createClient({
    readApiKey: () => FAKE_KEY, now: () => clock,
    sleepImpl: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const response = responses.shift();
      assert.ok(response, `意外请求 ${url}`);
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, init) : response;
    },
    ...overrides,
  });
  return { client, calls, waits };
}

async function temporary(t) {
  // Windows 宿主沙箱的系统临时目录不支持 rename 覆盖；工作区 outputs 支持正常文件语义。
  const root = path.resolve('outputs');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'ifuture-generation-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function invoke(args, client) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCLI(args, {
    client, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
  });
  return { exitCode, stdout, stderr };
}

test('模型和模式使用查询契约，参数按优先级合并并保留提示与文件顺序', () => {
  const inputs = [{ assetId: 'b', groupKey: 'reference' }, { assetId: 'a', groupKey: 'reference' }];
  const prepared = prepareRequest({ models: { items: [MODEL] }, modelId: MODEL.id,
    prompt: '中文\n"保留原文"\n', parameters: { size: '1024x1024' }, inputs });
  assert.equal(prepared.kind, 'image');
  assert.deepEqual(prepared.request.input.parameters, { size: '1024x1024', quality: 'high' });
  assert.deepEqual(prepared.request.input.inputs, inputs);
  assert.equal(prepared.request.input.prompt, '中文\n"保留原文"\n');
  assert.match(prepared.request.clientRequestId, /^[0-9a-f-]{14}4/);
  assert.notEqual(prepared.request.clientRequestId, request().clientRequestId);
  assert.throws(() => prepareRequest({ models: { items: [MODEL] }, modelId: '供应商模型名', prompt: 'x' }), code(2));
});

test('只使用所选模式的文件分组约束，验证提示长度与必填', () => {
  const model = { ...MODEL, maxInputCount: 64, modes: [{ ...MODEL.modes[0],
    inputGroups: [{ key: 'reference', minCount: 1, maxCount: 1 }] }] };
  for (const inputs of [[], [{ assetId: 'a', groupKey: 'wrong' }],
    [{ assetId: 'a', groupKey: 'reference' }, { assetId: 'b', groupKey: 'reference' }]]) {
    assert.throws(() => prepareRequest({ models: { items: [model] }, modelId: model.id, prompt: 'x', inputs }), code(2));
  }
  for (const prompt of ['', 'x'.repeat(101)]) {
    assert.throws(() => prepareRequest({ models: { items: [MODEL] }, modelId: MODEL.id, prompt }), code(2));
  }
});

test('图层拆分和样片转正式不继承普通模式默认参数', () => {
  for (const modeKey of ['layer-decomposition', 'finalize-draft']) {
    const model = { ...MODEL, modes: [{ key: modeKey, promptRequired: false, inputGroups: [], defaultParameters: { forbidden: true } }] };
    const prepared = prepareRequest({ models: { items: [model] }, modelId: model.id, modeKey,
      parameters: { sourceTaskId: 'source-task' } });
    assert.deepEqual(prepared.request.input.parameters, { sourceTaskId: 'source-task' });
    assert.equal(prepared.request.input.prompt, '');
  }
});

test('拒绝所有权字段、错误 UUID、外部 URL 或额外参考文件字段', () => {
  for (const patch of [{ context: {} }, { userId: 'someone' }, { ownerUserId: 'someone' }, { clientRequestId: 'not-uuid' }]) {
    assert.throws(() => validateRequest({ ...request(), ...patch }), code(2));
  }
  const data = request();
  data.input.inputs = [{ url: 'https://example.test/ref.png', groupKey: 'reference' }];
  assert.throws(() => validateRequest(data), code(2));
});

test('请求文件不覆盖、写完可重读，兼容 BOM，拒绝无效 UTF-8', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'request.json');
  const value = request();
  await saveJson(file, value);
  await assert.rejects(saveJson(file, request()), code(8));
  assert.deepEqual((await readJson(file)).value, value);
  await fs.writeFile(file, '\uFEFF' + JSON.stringify(value));
  assert.deepEqual((await readJson(file)).value, value);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readJson(file), code(7));
});

test('报价不发送 UUID 或 context，积分全程保持字符串', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'request.json');
  await saveJson(file, request());
  const { client, calls } = mock([json({ cost: '90071992547409931234', creditBalance: '1' })]);
  const result = await invoke(['quote', '--kind', 'image', '--request', file], client);
  assert.equal(result.exitCode, 0);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'modelConfigId']);
  assert.equal(JSON.parse(result.stdout).cost, '90071992547409931234');
  assert.equal(calls[0].url, BASE_URL + '/image/quote');
});

test('创建请求网络中断和 503 后重试保持持久化文件的原始内容，保存 taskId', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'request.json');
  const out = path.join(directory, 'accepted.json');
  const raw = '\uFEFF' + JSON.stringify(request(), null, 4) + '\n';
  await fs.writeFile(file, raw);
  const { client, calls, waits } = mock([new TypeError('offline'), json('busy', 503), json(task(), 202)]);
  const result = await invoke(['create', '--kind', 'image', '--request', file, '--out', out], client);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.init.body === raw.slice(1)));
  assert.ok(calls.every((c) => c.init.headers['x-api-key'] === FAKE_KEY && c.init.redirect === 'error'));
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal((await readJson(out)).value.task.id, 'task-1');
  assert.match(result.stderr, /taskId=task-1/);
});

test('创建前检查已有输出，避免因输出路径冲突再次发送', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'request.json');
  const out = path.join(directory, 'accepted.json');
  await saveJson(file, request());
  await saveJson(out, {});
  const { client, calls } = mock([]);
  const result = await invoke(['create', '--kind', 'image', '--request', file, '--out', out], client);
  assert.equal(result.exitCode, 8);
  assert.equal(calls.length, 0);
});

test('覆盖 image、video、audio 创建端点，不修改请求参数', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'request.json');
  await saveJson(file, request());
  for (const outputKind of ['image', 'video', 'audio']) {
    const { client, calls } = mock([json(task(), 202)]);
    const result = await invoke(['create', '--kind', outputKind, '--request', file, '--out', path.join(directory, outputKind + '.json')], client);
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0].url, BASE_URL + '/' + outputKind);
  }
});

test('401/402/403/404/409 不自动重试，纯文本与 JSON 错误均可处理并隐藏密钥', async () => {
  for (const status of [400, 401, 402, 403, 404, 409]) {
    const { client, calls } = mock([new Response(`服务错误 ${FAKE_KEY}`, { status })]);
    await assert.rejects(client.api('/models'), (error) => {
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(FAKE_KEY));
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const { client } = mock([json({ success: false, error: { issues: [{ path: ['input'], message: '无效参数' }] } }, 400)]);
  await assert.rejects(client.api('/models'), /无效参数/);
});

test('有限重试遵守 Retry-After，超过一分钟停止', async () => {
  const retried = mock([json({}, 429, { 'retry-after': '4' }), json({ items: [] })]);
  await retried.client.api('/models');
  assert.deepEqual(retried.waits, [4000]);
  const stopped = mock([json({}, 503, { 'retry-after': '61' })]);
  await assert.rejects(stopped.client.api('/models'), code(4));
  assert.equal(stopped.calls.length, 1);
  const exhausted = mock([new TypeError('network'), new TypeError('network'), new TypeError('network')]);
  await assert.rejects(exhausted.client.api('/models'), code(5));
  assert.equal(exhausted.calls.length, 3);
});

test('响应头成功但读取响应体时断网仍有限重试，成功的非法 JSON 不盲目重试', async () => {
  const broken = new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('body disconnected')); },
  }));
  const recovered = mock([broken, json({ items: [] })]);
  assert.deepEqual(await recovered.client.api('/models'), { items: [] });
  assert.equal(recovered.calls.length, 2);
  const invalid = mock([new Response('not json')]);
  await assert.rejects(invalid.client.api('/models'), code(6));
  assert.equal(invalid.calls.length, 1);
});

test('轮询成功保留多个结果、警告、账单，failed/cancelled 是 HTTP 200 终态', async () => {
  const success = task('succeeded', { outputAssets: [{ id: 'a' }, { id: 'b' }], warnings: [{ code: 'partial', message: '警告' }] });
  const polling = mock([json(task()), json(task('running')), json(success)]);
  assert.deepEqual(await polling.client.waitTask('task-1'), success);
  assert.deepEqual(polling.waits, [3000, 3000]);
  for (const status of ['failed', 'cancelled']) {
    const state = task(status, { failure: { code: 'FAILED', message: '失败', source: 'provider' } });
    const { client, calls } = mock([json(state)]);
    const result = await invoke(['wait', '--id', 'task-1'], client);
    assert.equal(result.exitCode, 9);
    assert.deepEqual(JSON.parse(result.stdout), state);
    assert.equal(calls.length, 1);
  }
});

test('轮询临时错误退避，客户端等待超时不调用 cancel 且保存最新状态', async (t) => {
  const directory = await temporary(t);
  const out = path.join(directory, 'latest.json');
  const { client, calls, waits } = mock([json({}, 503), json(task('running'))]);
  const result = await invoke(['wait', '--id', 'task-1', '--max-wait-sec', '3', '--out', out], client);
  assert.equal(result.exitCode, 10, result.stderr);
  assert.deepEqual(waits, [1000]);
  assert.ok(calls.every((c) => c.init.method === 'GET' && !c.url.endsWith('/cancel')));
  assert.equal((await readJson(out)).value.task.status, 'running');
});

test('取消任务与上传确认/取消使用无请求体 POST，并编码资源 ID', async () => {
  const cases = [
    [['cancel-task', '--id', 'a/b'], '/tasks/a%2Fb/cancel', task('running')],
    [['finalize-upload', '--object-id', 'upload-object'], '/file-uploads/upload-object/finalize', { id: 'asset-id' }],
    [['cancel-upload', '--object-id', 'upload-object'], '/file-uploads/upload-object/cancel', { cancelled: false }],
  ];
  for (const [args, endpoint, response] of cases) {
    const { client, calls } = mock([json(response)]);
    const result = await invoke(args, client);
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0].url, BASE_URL + endpoint);
    assert.equal(calls[0].init.method, 'POST');
    assert.ok(!Object.hasOwn(calls[0].init, 'body'));
    assert.ok(!Object.hasOwn(calls[0].init.headers, 'Content-Type'));
  }
});

test('上传先持久化 objectId，OSS 全部字段原样且 file 最后，不携带 API Key 或手设 boundary', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, '参考.png');
  const stateFile = path.join(directory, 'upload.json');
  await fs.writeFile(file, Buffer.from([137, 80, 78, 71]));
  const reservation = { objectId: 'upload-object', upload: {
    url: 'https://oss.example.test/upload', fields: { key: 'object-key', 'Content-Type': 'image/png', policy: 'test-policy', extra: 'unchanged' },
  } };
  const asset = { id: 'final-asset-id', kind: 'image' };
  const { client, calls } = mock([
    json(reservation),
    async (_url, init) => {
      assert.equal((await readJson(stateFile)).value.reservation.objectId, 'upload-object');
      assert.equal(init.headers, undefined);
      assert.ok(init.body instanceof FormData);
      assert.deepEqual([...init.body.keys()], ['key', 'Content-Type', 'policy', 'extra', 'file']);
      assert.equal(init.body.get('extra'), 'unchanged');
      assert.equal(init.body.get('file').size, 4);
      assert.equal(init.body.get('file').name, '参考.png');
      return new Response(null, { status: 204 });
    },
    json(asset),
  ]);
  const result = await invoke(['upload', '--file', file, '--state', stateFile], client);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), asset);
  assert.equal(calls[2].url, BASE_URL + '/file-uploads/upload-object/finalize');
  const state = (await readJson(stateFile)).value;
  assert.equal(state.asset.id, 'final-asset-id');
  assert.equal(state.status, 'finalized');
  assert.equal(state.reservation, undefined);
});

test('上传申请网络不确定不自动重试，不自动取消；OSS 失败保留 objectId', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'x.png');
  await fs.writeFile(file, 'x');
  const first = mock([new TypeError('network')]);
  const failed = await invoke(['upload', '--file', file, '--state', path.join(directory, 'a.json')], first.client);
  assert.equal(failed.exitCode, 5);
  assert.equal(first.calls.length, 1);
  const reservation = { objectId: 'object-to-recover', upload: { url: 'https://oss.example.test/', fields: {} } };
  const second = mock([json(reservation), new Response('no', { status: 500 })]);
  const state = path.join(directory, 'b.json');
  const transferFailed = await invoke(['upload', '--file', file, '--state', state], second.client);
  assert.equal(transferFailed.exitCode, 5);
  assert.equal(second.calls.length, 2);
  assert.equal((await readJson(state)).value.reservation.objectId, 'object-to-recover');
});

test('上传按实际字节数与扩展名匹配 MIME，拒绝空文件和超限文件', async (t) => {
  const directory = await temporary(t);
  for (const [extension, expectedKind, contentType, maxMiB] of [
    ['png', 'image', 'image/png', 30], ['wav', 'audio', 'audio/wav', 50], ['mov', 'video', 'video/quicktime', 500],
  ]) {
    const file = path.join(directory, 'file.' + extension);
    await fs.writeFile(file, '');
    await assert.rejects(uploadMetadata(file), code(2));
    await fs.writeFile(file, '123');
    const metadata = await uploadMetadata(file);
    assert.equal(metadata.fileSizeBytes, 3);
    assert.equal(metadata.kind, expectedKind);
    assert.equal(metadata.contentType, contentType);
    await fs.truncate(file, maxMiB * 1048576 + 1);
    await assert.rejects(uploadMetadata(file), code(2));
  }
});

test('下载刷新 URL，二进制完整落盘，无 Key、不跟随重定向、不覆盖', async (t) => {
  const directory = await temporary(t);
  const out = path.join(directory, 'result.bin');
  const bytes = Buffer.from([0, 255, 1, 2, 128]);
  const { client, calls } = mock([json({ downloadUrl: 'https://download.example.test/file?signature=fake' }), new Response(bytes)]);
  const saved = await client.downloadAsset('asset-1', out);
  assert.equal(saved, out);
  assert.deepEqual(await fs.readFile(out), bytes);
  assert.equal(calls[0].url, BASE_URL + '/files/asset-1/download-url');
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[1].init.redirect, 'error');
  await assert.rejects(client.downloadAsset('asset-1', out), code(8));
  assert.equal(calls.length, 2);
});

test('下载失败清理半成品、保留已有文件，拒绝不安全签名地址', async (t) => {
  const directory = await temporary(t);
  const out = path.join(directory, 'broken.bin');
  for (const url of ['http://example.test/file', 'https://user:password@example.test/file']) {
    const { client, calls } = mock([json({ downloadUrl: url })]);
    await assert.rejects(client.downloadAsset('asset-id', out), code(6));
    await assert.rejects(fs.access(out));
    assert.equal(calls.length, 1);
  }
  const { client } = mock([json({ downloadUrl: 'https://example.test/file' }), new Response('expired', { status: 403 })]);
  await assert.rejects(client.downloadAsset('asset-id', out), code(5));
  await assert.rejects(fs.access(out));
});

test('多结果与辅助文件顺序下载，文件名不能逃出输出目录，账单和警告保存在 manifest', async (t) => {
  const directory = await temporary(t);
  const response = task('succeeded', { outputAssets: [{ id: 'main-1', originalFileName: '../../first.png' },
    { id: 'main-2', originalFileName: 'second.png' }], auxiliaryAssets: [{ id: 'last-frame', originalFileName: 'last.png' }],
  warnings: [{ code: 'WARN' }] });
  const { client } = mock([json(response),
    json({ downloadUrl: 'https://example.test/1' }), new Response('one'),
    json({ downloadUrl: 'https://example.test/2' }), new Response('two'),
    json({ downloadUrl: 'https://example.test/3' }), new Response('three')]);
  const result = await invoke(['download-task', '--id', 'task-1', '--out-dir', directory, '--include-auxiliary'], client);
  assert.equal(result.exitCode, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.deepEqual(saved.results.map((r) => r.assetId), ['main-1', 'main-2', 'last-frame']);
  assert.ok(saved.results.every((r) => path.dirname(r.savedTo) === directory));
  assert.deepEqual((await readJson(path.join(directory, 'task.json'))).value, response);
});

test('个人文件库分页参数、下载 attachment=1 按协议编码', async () => {
  const { client, calls } = mock([json({ items: [], nextCursor: null }), json({ downloadUrl: 'https://example.test/' })]);
  const result = await invoke(['files', '--kind', 'video', '--query', ' 湖 面 ', '--limit', '50', '--cursor', 'next+/='], client);
  assert.equal(result.exitCode, 0);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('query'), '湖 面');
  assert.equal(url.searchParams.get('cursor'), 'next+/=');
  assert.equal(JSON.parse(result.stdout).nextCursor, null);
  assert.equal((await invoke(['download-url', '--asset-id', 'a', '--attachment'], client)).exitCode, 0);
  assert.ok(calls[1].url.endsWith('?attachment=1'));
});

test('dry-run 不读取凭据、不联网、不写输出；严格拒绝拼错、重复、跨命令参数', async (t) => {
  const directory = await temporary(t);
  const out = path.join(directory, 'models.json');
  const { client, calls } = mock([], { readApiKey: () => { throw new Error('不得读取'); } });
  const result = await invoke(['models', '--dry-run', '--out', out], client);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(calls.length, 0);
  await assert.rejects(fs.access(out));
  for (const args of [['models', '--knd', 'image'], ['models', '--kind', 'image', '--kind', 'video'],
    ['task', '--id', 'x', '--prompt', 'y'], ['files', '--limit', '0']]) {
    assert.equal((await invoke(args, client)).exitCode, 2);
  }
});

test('prepare CLI 离线读取参数和提示文件，生成可直接提交的请求', async (t) => {
  const directory = await temporary(t);
  const models = path.join(directory, 'models.json');
  const prompt = path.join(directory, 'prompt.txt');
  const out = path.join(directory, 'request.json');
  await saveJson(models, { items: [MODEL] });
  await fs.writeFile(prompt, '\uFEFF日出\n');
  const { client, calls } = mock([]);
  const result = await invoke(['prepare', '--models', models, '--model', MODEL.id, '--prompt-file', prompt, '--out', out], client);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((await readJson(out)).value.input.prompt, '日出\n');
  assert.equal(calls.length, 0);
});

test('真实 CLI 入口可离线运行 help 与 dry-run，无 npm 包依赖', async () => {
  const cli = path.resolve(import.meta.dirname, '../scripts/generate.mjs');
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, [cli, 'models', '--kind', 'audio', '--dry-run'], {
    env: { ...process.env, IFUTURE_API_KEY: '' },
  });
  assert.equal(JSON.parse(stdout).endpoint, BASE_URL + '/models?kind=audio');
  const help = await execute(process.execPath, [cli, '--help']);
  assert.match(help.stdout, /download-task/);
});
