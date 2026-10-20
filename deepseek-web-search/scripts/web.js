#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  BASE_URL,
  WebApiError,
  buildSearchBody,
  buildFetchBody,
  validateRequestOptions,
  createClient,
  renderMarkdown,
} = require('./deepseek-web.js');

const HELP = `DeepSeek 网页搜索与抓取（Node.js 22+，无需 npm 依赖）

用法：
  node web.js search --query "搜索词" [选项]
  node web.js search --query-file "./query.txt" [选项]
  node web.js fetch --url "https://example.com" [选项]

搜索选项：
  --query TEXT           1～128 个 Unicode 字符；搜索语法原样发送
  --query-file PATH      UTF-8 搜索词文件，与 --query 二选一
  --count N              1～50 的整数，默认 10
  --ori-question TEXT    用户原始问题，1～128 个 Unicode 字符
  --localization IP      本地化 IP；IPv4/IPv6 或空字符串
  --need-content         在 Search 结果中请求正文，默认 false

抓取选项：
  --url URL              含 host 的 HTTP/HTTPS URL，不含用户名或密码

通用选项：
  --format json|markdown 默认 json；不会根据文件后缀自动切换
  --out PATH             保存为 UTF-8 文件，不覆盖；stdout 仅输出绝对路径
  --timeout-sec N        每次请求及读取响应的超时秒数，默认 60，范围 (0, 3600]
  --max-retries N        408、429、5xx 的最多重试次数，默认 2，范围 0～5
  --dry-run              校验并预览请求，不读取密钥、不联网、不写文件
  --help, -h             显示帮助

配置：仅由脚本内部读取 DEEPSEEK_API_KEY，不加载 .env，不支持命令行传密钥。
API 固定为 https://api.deepseek.com，不接受自定义服务或重定向。
有值的选项支持 --name=value；不支持重复选项。
`;

const SEARCH_OPTIONS = new Set([
  'query', 'query-file', 'count', 'ori-question', 'localization', 'need-content',
]);
const FETCH_OPTIONS = new Set(['url']);
const COMMON_OPTIONS = new Set(['format', 'out', 'timeout-sec', 'max-retries', 'dry-run']);
const FLAGS = new Set(['need-content', 'dry-run']);

function fail(message) {
  throw new WebApiError(message, 2);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, ...args] = argv;
  if (!['search', 'fetch'].includes(command)) fail('子命令必须是 search 或 fetch。');
  const allowed = new Set([
    ...COMMON_OPTIONS,
    ...(command === 'search' ? SEARCH_OPTIONS : FETCH_OPTIONS),
  ]);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const match = args[index].match(/^--([a-z][a-z-]*)(?:=([\s\S]*))?$/);
    if (!match || !allowed.has(match[1])) fail('存在未知参数、位置参数或不适用于此子命令的选项；请使用 --help。');
    const [, name, inlineValue] = match;
    if (Object.hasOwn(values, name)) fail(`--${name} 不得重复指定。`);
    if (FLAGS.has(name)) {
      if (inlineValue !== undefined) fail(`--${name} 是开关，不接受值。`);
      values[name] = true;
    } else {
      let value = inlineValue;
      if (value === undefined) {
        value = args[index + 1];
        if (value === undefined || value.startsWith('--')) {
          fail(`--${name} 缺少值；以 -- 开头的值请使用 --${name}=VALUE。`);
        }
        index += 1;
      }
      values[name] = value;
    }
  }
  return { command, values };
}

function numberOption(value, name, integer = false) {
  if (value === undefined) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
    || !Number.isFinite(Number(value)) || (integer && !Number.isInteger(Number(value)))) {
    fail(`--${name} 必须是${integer ? '非负整数' : '有效数字'}。`);
  }
  return Number(value);
}

async function prepare(parsed) {
  const { command, values } = parsed;
  const format = values.format ?? 'json';
  if (!['json', 'markdown'].includes(format)) fail('--format 仅支持 json 或 markdown。');
  const options = validateRequestOptions({
    timeoutSec: numberOption(values['timeout-sec'], 'timeout-sec'),
    maxRetries: numberOption(values['max-retries'], 'max-retries', true),
  });
  let params;
  if (command === 'search') {
    if (Object.hasOwn(values, 'query') === Object.hasOwn(values, 'query-file')) {
      fail('--query 与 --query-file 必须且只能提供一个。');
    }
    let query = values.query;
    if (values['query-file'] !== undefined) {
      if (!values['query-file']) fail('--query-file 不得为空。');
      try {
        const bytes = await fs.readFile(values['query-file']);
        query = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new WebApiError('无法读取 query-file 或文件不是有效 UTF-8，请检查文件。', 7);
      }
      // Strip a file's BOM, but do not rewrite search operators or whitespace.
      query = query.replace(/^\uFEFF/, '');
    }
    params = buildSearchBody({
      query,
      count: numberOption(values.count, 'count', true),
      ori_question: values['ori-question'],
      localization: values.localization,
      need_content: values['need-content'],
    });
  } else {
    params = buildFetchBody({ url: values.url });
  }
  let out;
  if (values.out !== undefined) {
    if (!values.out.trim()) fail('--out 不得为空白。');
    out = path.resolve(values.out);
    try {
      await fs.lstat(out);
      throw new WebApiError('输出路径已存在；请更换路径，脚本不会覆盖文件。', 8);
    } catch (error) {
      if (error instanceof WebApiError) throw error;
      if (error.code !== 'ENOENT') throw new WebApiError('无法检查输出路径，请检查权限和父目录。', 8);
    }
  }
  return { command, params, options, format, out, dryRun: values['dry-run'] === true };
}

async function saveOutput(out, text) {
  let handle;
  try {
    await fs.mkdir(path.dirname(out), { recursive: true });
    handle = await fs.open(out, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.close();
    handle = undefined;
  } catch {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.unlink(out).catch(() => {});
    }
    throw new WebApiError('API 已成功返回，但输出文件未能保存（路径冲突或写入失败）。不要仅为重新保存而再次调用 API；本次请求可能已计费。', 8);
  }
}

async function runCLI(argv, {
  client,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      stdout.write(HELP);
      return 0;
    }
    const prepared = await prepare(parsed);
    const { command, params, options, format, out, dryRun } = prepared;
    if (dryRun) {
      stdout.write(`${JSON.stringify({
        dryRun: true,
        method: 'POST',
        endpoint: `${BASE_URL}/v1/tools/${command}`,
        body: params,
        ...options,
        format,
        out: out ?? null,
      }, null, 2)}\n`);
      return 0;
    }
    const api = client ?? createClient();
    const data = await api[command](params, options);
    const text = format === 'json'
      ? `${JSON.stringify(data, null, 2)}\n`
      : renderMarkdown(command, data, params);
    if (out) {
      await saveOutput(out, text);
      stdout.write(`${out}\n`);
    } else {
      stdout.write(text);
    }
    return 0;
  } catch (error) {
    if (error instanceof WebApiError) {
      stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    // Never print raw exceptions, headers, response bodies or stack traces.
    stderr.write('内部错误；未输出底层异常或凭据，请检查 Node.js 版本和本机运行环境。\n');
    return 1;
  }
}

if (require.main === module) {
  runCLI(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = { HELP, parseArgs, prepare, saveOutput, runCLI };
