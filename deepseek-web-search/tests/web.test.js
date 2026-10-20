'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  BASE_URL,
  WebApiError,
  buildSearchBody,
  buildFetchBody,
  validateRequestOptions,
  createClient,
  renderMarkdown,
} = require('../scripts/deepseek-web.js');
const { runCLI, parseArgs, saveOutput } = require('../scripts/web.js');

const FAKE_KEY = 'fake-offline-key-not-a-real-secret';
const CLI_PATH = path.resolve(__dirname, '../scripts/web.js');
const execFileAsync = promisify(execFile);

function result(overrides = {}) {
  return {
    rerank_score: 2.4,
    title: 'Node.js 测试运行器',
    url: 'https://nodejs.org/api/test.html',
    snippet: '短摘要',
    summary: '这是供模型阅读的长摘要。',
    content: '',
    site_name: 'Node.js',
    site_icon: null,
    date: null,
    authority: 3,
    ...overrides,
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mockClient(responses, deps = {}) {
  const calls = [];
  const waits = [];
  const client = createClient({
    readApiKey: () => FAKE_KEY,
    random: () => 0,
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(url, init);
      assert.ok(response, 'unexpected extra HTTP attempt');
      return response;
    },
    ...deps,
  });
  return { client, calls, waits };
}

async function invoke(args, client) {
  let stdout = '';
  let stderr = '';
  const code = await runCLI(args, {
    client,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-web-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function hasExitCode(code) {
  return (error) => error instanceof WebApiError && error.exitCode === code;
}

test('Search defaults and all documented request fields', () => {
  assert.deepEqual(buildSearchBody({ query: 'Node.js' }), {
    query: 'Node.js', count: 10, need_content: false,
  });
  const params = {
    query: 'DeepSeek site:github.com OR site:huggingface.co lang:zh,en after:2025 before:2026-06-01 -广告 -"release notes" "精确短语"',
    count: 50,
    ori_question: '原始问题',
    localization: '2001:db8::1',
    need_content: true,
    ignored: 'not sent',
  };
  const body = buildSearchBody(params);
  assert.equal(body.query, params.query);
  assert.equal(body.count, 50);
  assert.equal(body.ori_question, params.ori_question);
  assert.equal(body.localization, params.localization);
  assert.equal(body.need_content, true);
  assert.equal(body.ignored, undefined);
  assert.deepEqual(buildSearchBody({ query: 'q', ori_question: null }), {
    query: 'q', count: 10, need_content: false,
  });
  assert.equal(buildSearchBody({ query: 'q', localization: '' }).localization, '');
  assert.equal(buildSearchBody({ query: 'q', localization: '203.0.113.1' }).localization, '203.0.113.1');
});

test('Unicode length counts code points rather than UTF-16 units', () => {
  assert.equal(buildSearchBody({ query: '😀'.repeat(128) }).query.length, 256);
  assert.throws(() => buildSearchBody({ query: '😀'.repeat(129) }), hasExitCode(2));
  assert.equal(buildSearchBody({ query: 'q', ori_question: '中'.repeat(128) }).ori_question.length, 128);
  assert.throws(() => buildSearchBody({ query: 'q', ori_question: '中'.repeat(129) }), hasExitCode(2));
});

test('Reject invalid Search fields, without silently coercing null, numbers or strings', () => {
  for (const query of ['', ' \n\t', null, 123, undefined]) {
    assert.throws(() => buildSearchBody({ query }), hasExitCode(2));
  }
  for (const count of [0, 51, 2.5, '3', null, NaN]) {
    assert.throws(() => buildSearchBody({ query: 'q', count }), hasExitCode(2));
  }
  for (const ori_question of ['', '   ', 12]) {
    assert.throws(() => buildSearchBody({ query: 'q', ori_question }), hasExitCode(2));
  }
  for (const need_content of [1, 'true', null]) {
    assert.throws(() => buildSearchBody({ query: 'q', need_content }), hasExitCode(2));
  }
  for (const localization of ['China', '999.1.1.1', null, 1]) {
    assert.throws(() => buildSearchBody({ query: 'q', localization }), hasExitCode(2));
  }
});

test('Fetch accepts HTTP(S), Unicode, query parameters and fragments without rewriting', () => {
  for (const url of [
    'https://example.com/a?b=1#section',
    'http://example.com/',
    'https://例子.测试/文档',
    'https://example.com/?next=user@example.com',
    'https://[2001:db8::1]/',
  ]) {
    assert.deepEqual(buildFetchBody({ url }), { url });
  }
  const base = 'https://example.com/';
  assert.equal(buildFetchBody({ url: base + 'a'.repeat(8192 - base.length) }).url.length, 8192);
  assert.throws(() => buildFetchBody({ url: base + 'a'.repeat(8193 - base.length) }), hasExitCode(2));
});

test('Reject invalid schemes, hostless URLs, userinfo and ambiguous whitespace URLs', () => {
  for (const url of [
    '', null, 'example.com', 'file:///C:/secret', 'javascript:alert(1)',
    'https://', 'https:example.com', 'https:///example.com',
    'https://u:p@example.com/', 'https://u@example.com', 'https://@example.com',
    ' https://example.com', 'https://example.com/a b', 'https://exa\nmple.com',
    'https://example.com\\@other.example/',
  ]) {
    assert.throws(() => buildFetchBody({ url }), hasExitCode(2));
  }
});

test('Validate timeout and retry bounds', () => {
  assert.deepEqual(validateRequestOptions(), { timeoutSec: 60, maxRetries: 2 });
  assert.deepEqual(validateRequestOptions({ timeoutSec: 0.01, maxRetries: 0 }), { timeoutSec: 0.01, maxRetries: 0 });
  for (const timeoutSec of [0, -1, 3601, Infinity, '1', null]) {
    assert.throws(() => validateRequestOptions({ timeoutSec }), hasExitCode(2));
  }
  for (const maxRetries of [-1, 6, 1.5, '2', null]) {
    assert.throws(() => validateRequestOptions({ maxRetries }), hasExitCode(2));
  }
});

test('Invalid input fails before reading credentials or making requests', async () => {
  const client = createClient({
    readApiKey: () => { assert.fail('must not read credentials'); },
    fetchImpl: () => { assert.fail('must not request'); },
  });
  await assert.rejects(client.search({ query: 'x'.repeat(129) }), hasExitCode(2));
  await assert.rejects(client.fetch({ url: 'https://u:p@example.com' }), hasExitCode(2));
});

test('Missing and malformed credentials fail safely without network requests', async () => {
  for (const key of [undefined, '', ' ', 'secret\nvalue', ' leading-secret']) {
    const client = createClient({
      readApiKey: () => key,
      fetchImpl: () => { assert.fail('must not request'); },
    });
    await assert.rejects(client.search({ query: 'q' }), (error) => {
      assert.equal(error.exitCode, 3);
      assert.ok(!error.message.includes('secret'));
      if (key === undefined || !key.trim()) {
        assert.ok(error.message.includes('当前进程未获取到'));
        assert.ok(error.message.includes('仅重开会话'));
      }
      return true;
    });
  }
});

test('Official POST request, Bearer authentication, redirect refusal and exact Search JSON', async () => {
  const data = { results: [result({ content: '正文' })], extra_metadata: { kept: true } };
  const { client, calls } = mockClient([jsonResponse(data)]);
  assert.deepEqual(await client.search({ query: '中文 😀 "短语" -广告', count: 3, need_content: true }), data);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${BASE_URL}/v1/tools/search`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(init.body), { query: '中文 😀 "短语" -广告', count: 3, need_content: true });
});

test('Fetch uses the dedicated raw API, and empty title is allowed', async () => {
  const data = { title: '', content: '# 正文\n\n内容' };
  const { client, calls } = mockClient([jsonResponse(data)]);
  assert.deepEqual(await client.fetch({ url: 'https://example.com/a' }), data);
  assert.equal(calls[0].url, `${BASE_URL}/v1/tools/fetch`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://example.com/a' });
});

test('Search empty array is successful and never retried', async () => {
  const { client, calls } = mockClient([jsonResponse({ results: [] })]);
  assert.deepEqual(await client.search({ query: 'no matches' }), { results: [] });
  assert.equal(calls.length, 1);
});

for (const status of [408, 429, 500, 502, 503, 504, 599]) {
  test(`HTTP ${status} is retried with exponential backoff`, async () => {
    const { client, calls, waits } = mockClient([
      jsonResponse({ error: { message: FAKE_KEY } }, status),
      jsonResponse({}, status),
      jsonResponse({ results: [] }),
    ]);
    assert.deepEqual(await client.search({ query: 'q' }), { results: [] });
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [1000, 2000]);
  });
}

for (const status of [400, 401, 402, 403, 404, 413, 422]) {
  test(`HTTP ${status} is not retried and sensitive upstream errors are not exposed`, async () => {
    const { client, calls, waits } = mockClient([
      jsonResponse({ error: { message: `leaked ${FAKE_KEY}`, type: FAKE_KEY, code: FAKE_KEY } }, status),
    ]);
    await assert.rejects(client.fetch({ url: 'https://example.com' }), (error) => {
      assert.equal(error.exitCode, 4);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(FAKE_KEY));
      return true;
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });
}

test('Retry exhaustion is bounded, and maxRetries=0 disables retries', async () => {
  const { client, calls } = mockClient([jsonResponse({}, 429), jsonResponse({}, 429), jsonResponse({}, 429)]);
  await assert.rejects(client.search({ query: 'q' }), (error) => {
    assert.equal(error.attempts, 3);
    return error.exitCode === 4;
  });
  assert.equal(calls.length, 3);
  const disabled = mockClient([jsonResponse({}, 503)]);
  await assert.rejects(disabled.client.search({ query: 'q' }, { maxRetries: 0 }), hasExitCode(4));
  assert.equal(disabled.calls.length, 1);
});

test('Retry-After seconds and HTTP dates are honored; jitter is applied', async () => {
  const now = Date.UTC(2026, 0, 1);
  const { client, waits } = mockClient([
    jsonResponse({}, 429, { 'retry-after': '3' }),
    jsonResponse({}, 503, { 'retry-after': new Date(now + 5000).toUTCString() }),
    jsonResponse({ results: [] }),
  ], { now: () => now });
  await client.search({ query: 'q' });
  assert.deepEqual(waits, [3000, 5000]);
  const jitter = mockClient([jsonResponse({}, 500), jsonResponse({ results: [] })], { random: () => 0.5 });
  await jitter.client.search({ query: 'q' });
  assert.deepEqual(jitter.waits, [1125]);
});

test('Do not retry earlier than a Retry-After exceeding the wait budget', async () => {
  const { client, calls, waits } = mockClient([jsonResponse({}, 429, { 'retry-after': '61' })]);
  await assert.rejects(client.search({ query: 'q' }), /超过 60 秒/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('Network errors and redirects are not retried and raw exception text is hidden', async () => {
  const { client, calls } = mockClient([new TypeError(`network error containing ${FAKE_KEY}`)]);
  await assert.rejects(client.search({ query: 'q' }), (error) => {
    assert.equal(error.exitCode, 5);
    assert.ok(!error.message.includes(FAKE_KEY));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('Client deadline aborts without automatic retries', async () => {
  const { client, calls } = mockClient([
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Abort', 'AbortError')), { once: true });
    }),
  ]);
  await assert.rejects(client.search({ query: 'q' }, { timeoutSec: 0.01 }), hasExitCode(5));
  assert.equal(calls.length, 1);
});

test('Real local HTTP mock covers POST transport and response-body read timeout', async (t) => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw), method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/tools/fetch') {
      res.write('{"title":"slow","content":"');
      const timer = setTimeout(() => res.end('body"}'), 500);
      res.on('close', () => clearTimeout(timer));
    } else {
      res.end(JSON.stringify({ results: [result()] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const localBase = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({
    readApiKey: () => FAKE_KEY,
    fetchImpl: (url, init) => {
      assert.ok(url.startsWith(`${BASE_URL}/`));
      return fetch(localBase + new URL(url).pathname, init);
    },
  });
  assert.equal((await client.search({ query: '本地测试' })).results.length, 1);
  assert.deepEqual(received[0], {
    path: '/v1/tools/search', auth: `Bearer ${FAKE_KEY}`,
    body: { query: '本地测试', count: 10, need_content: false }, method: 'POST',
  });
  await assert.rejects(client.fetch({ url: 'https://example.com' }, { timeoutSec: 0.05 }), hasExitCode(5));
  assert.equal(received.filter((r) => r.path === '/v1/tools/fetch').length, 1);
});

test('Invalid JSON, malformed response shapes, scores and empty Fetch bodies fail safely', async () => {
  const responses = [
    new Response(`not JSON ${FAKE_KEY}`, { status: 200 }),
    jsonResponse(null),
    jsonResponse([]),
    jsonResponse({}),
    jsonResponse({ results: [null] }),
    jsonResponse({ results: [result({ summary: null })] }),
    jsonResponse({ results: [result({ site_name: 123 })] }),
    jsonResponse({ results: [result({ rerank_score: 4 })] }),
    jsonResponse({ results: [result({ authority: -2 })] }),
  ];
  for (const response of responses) {
    const { client, calls } = mockClient([response]);
    await assert.rejects(client.search({ query: 'q' }), (error) => {
      assert.equal(error.exitCode, 6);
      assert.ok(!error.message.includes(FAKE_KEY));
      return true;
    });
    assert.equal(calls.length, 1);
  }
  for (const data of [{ title: '', content: '' }, { title: '', content: ' \n' }, { content: '正文' }]) {
    const { client } = mockClient([jsonResponse(data)]);
    await assert.rejects(client.fetch({ url: 'https://example.com' }), hasExitCode(6));
  }
});

test('Search Markdown distinguishes unknown dates, summaries, scores and full content', () => {
  const md = renderMarkdown('search', { results: [result({ content: '# 原文\n\n完整内容' })] }, { query: '中文 😀' });
  assert.ok(md.includes('https://nodejs.org/api/test.html'));
  assert.ok(md.includes('发布时间：未知'));
  assert.ok(md.includes('排序分数：2.4'));
  assert.ok(md.includes('权威性：3'));
  assert.ok(md.includes('这是供模型阅读的长摘要。'));
  assert.ok(md.includes('# 原文\n\n完整内容'));
  assert.ok(renderMarkdown('search', { results: [] }, { query: 'q' }).includes('无匹配结果'));
});

test('Fetch Markdown preserves content and adds title/source, without rendering unsafe source links', () => {
  const content = '# 原文\n\n[链接](https://example.com)\n';
  const md = renderMarkdown('fetch', { title: '标题\n[注入](x)', content }, { url: 'https://example.com/a' });
  assert.ok(md.includes('来源：<https://example.com/a>'));
  assert.ok(md.includes(content));
  assert.ok(md.includes('标题 \\[注入\\]'));
  const search = renderMarkdown('search', { results: [result({ url: 'javascript:alert(1)' })] }, { query: 'q' });
  assert.ok(!search.includes('javascript:'));
});

test('CLI rejects unknown, repeated, cross-command and conflicting options', async () => {
  for (const args of [
    ['oops'], ['search', '--url', 'https://example.com'], ['fetch', '--query', 'q'],
    ['search', '--query', 'q', '--query', 'q'], ['search', '--query'],
    ['search', '--query', 'q', '--query-file', 'q.txt'], ['search'],
    ['search', '--query', 'q', '--api-key', FAKE_KEY],
    ['search', '--query', 'q', '--need-content=false'],
    ['search', '--query', 'q', '--count', '3.5'],
    ['search', '--query', 'q', '--count', '1e1'],
    ['search', '--query', 'q', '--format', 'html'],
    ['search', '--query', 'q', '--timeout-sec', '0'],
    ['search', '--query', 'q', '--max-retries', '6'],
  ]) {
    const invocation = await invoke(args, { search: () => assert.fail('must not request') });
    assert.equal(invocation.code, 2, JSON.stringify(args));
    assert.equal(invocation.stdout, '');
    assert.ok(!invocation.stderr.includes(FAKE_KEY));
  }
  assert.equal(parseArgs(['search', '--query=--literal']).values.query, '--literal');
});

test('CLI dry-run preserves Unicode/operators and never reads credentials or calls the client', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'not-created', 'out.json');
  const query = '中文 😀 "精确短语" -"release notes" site:example.com OR site:nodejs.org lang:zh,en after:2025';
  const invocation = await invoke([
    'search', `--query=${query}`, '--need-content', '--count=3',
    '--ori-question', '原始问题', '--localization=', '--out', out, '--dry-run',
  ], new Proxy({}, { get: () => assert.fail('must not use client') }));
  assert.equal(invocation.code, 0);
  const preview = JSON.parse(invocation.stdout);
  assert.equal(preview.body.query, query);
  assert.equal(preview.body.count, 3);
  assert.equal(preview.body.need_content, true);
  assert.equal(preview.body.ori_question, '原始问题');
  assert.equal(preview.body.localization, '');
  assert.equal(preview.endpoint, `${BASE_URL}/v1/tools/search`);
  assert.equal(preview.out, out);
  assert.ok(!invocation.stdout.includes('Authorization'));
  await assert.rejects(fs.stat(path.dirname(out)), { code: 'ENOENT' });
});

test('CLI query-file is strict UTF-8, strips BOM, and preserves quotes and line endings', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'query.txt');
  const query = '中文 "精确短语"\r\nsite:example.com\n';
  await fs.writeFile(file, `\uFEFF${query}`, 'utf8');
  let invocation = await invoke(['search', '--query-file', file, '--dry-run']);
  assert.equal(invocation.code, 0);
  assert.equal(JSON.parse(invocation.stdout).body.query, query);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  invocation = await invoke(['search', '--query-file', file, '--dry-run']);
  assert.equal(invocation.code, 7);
  invocation = await invoke(['search', '--query-file', path.join(dir, 'missing'), '--dry-run']);
  assert.equal(invocation.code, 7);
});

test('CLI JSON output stays parseable; file output creates directories and prints only the absolute path', async (t) => {
  const dir = await tempDir(t);
  const data = { results: [result()] };
  let calls = 0;
  const client = { search: async (body) => { calls += 1; assert.equal(body.count, 3); return data; } };
  let invocation = await invoke(['search', '--query', 'q', '--count', '3'], client);
  assert.equal(invocation.code, 0);
  assert.deepEqual(JSON.parse(invocation.stdout), data);
  assert.equal(invocation.stderr, '');
  const out = path.join(dir, 'nested', '结果.json');
  invocation = await invoke(['search', '--query', 'q', '--count', '3', '--out', out], client);
  assert.equal(invocation.code, 0);
  assert.equal(invocation.stdout, `${out}\n`);
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), data);
  assert.equal(calls, 2);
  invocation = await invoke(['search', '--query', 'q', '--count', '3', '--out', out], client);
  assert.equal(invocation.code, 8);
  assert.equal(calls, 2, 'existing file must be detected before an API call');
  assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), data);
});

test('CLI Fetch Markdown is based on the same single response', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'article.md');
  let calls = 0;
  const client = {
    fetch: async ({ url }) => {
      calls += 1;
      assert.equal(url, 'https://example.com/article');
      return { title: 'Article', content: '# 原文\n\n正文' };
    },
  };
  const invocation = await invoke(['fetch', '--url', 'https://example.com/article', '--format', 'markdown', '--out', out], client);
  assert.equal(invocation.code, 0);
  assert.equal(calls, 1);
  assert.ok((await fs.readFile(out, 'utf8')).includes('来源：<https://example.com/article>'));
});

test('Exclusive writes protect against a race after the API response, without triggering another request', async (t) => {
  const dir = await tempDir(t);
  const out = path.join(dir, 'race.json');
  let calls = 0;
  const client = { search: async () => {
    calls += 1;
    await fs.writeFile(out, 'another writer');
    return { results: [] };
  } };
  const invocation = await invoke(['search', '--query', 'q', '--out', out], client);
  assert.equal(invocation.code, 8);
  assert.ok(invocation.stderr.includes('API 已成功返回'));
  assert.equal(await fs.readFile(out, 'utf8'), 'another writer');
  assert.equal(calls, 1);
  await assert.rejects(saveOutput(out, 'overwrite'), hasExitCode(8));
});

test('CLI hides unexpected raw exceptions and API response error bodies', async () => {
  let invocation = await invoke(['search', '--query', 'q'], {
    search: async () => { throw new Error(`unsafe ${FAKE_KEY}`); },
  });
  assert.equal(invocation.code, 1);
  assert.ok(!invocation.stderr.includes(FAKE_KEY));
  const { client } = mockClient([jsonResponse({ error: { message: FAKE_KEY } }, 401)]);
  invocation = await invoke(['search', '--query', 'q'], client);
  assert.equal(invocation.code, 4);
  assert.equal(invocation.stdout, '');
  assert.ok(!invocation.stderr.includes(FAKE_KEY));
});

test('Executable CLI --help and --dry-run work without network or credential access', async () => {
  const help = await execFileAsync(process.execPath, [CLI_PATH, '--help']);
  assert.ok(help.stdout.includes('search'));
  assert.equal(help.stderr, '');
  const preview = await execFileAsync(process.execPath, [CLI_PATH, 'fetch', '--url', 'https://example.com', '--dry-run']);
  assert.equal(JSON.parse(preview.stdout).endpoint, `${BASE_URL}/v1/tools/fetch`);
  assert.equal(preview.stderr, '');
});
