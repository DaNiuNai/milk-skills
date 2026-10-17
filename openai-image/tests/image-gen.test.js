const assert = require("node:assert/strict");
const { test, before, after, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  generateImage,
  ImageApiError,
  resolveConfig,
} = require("../scripts/image-gen");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const FAKE_KEY = "offline-fake-key-never-a-real-credential";
const cli = path.resolve(__dirname, "../scripts/gen.js");
const execFileAsync = promisify(execFile);
let root;
let server;
let baseUrl;
let origin;
let handler;
let requests;
let sequence = 0;

function out(extension = "png") {
  sequence += 1;
  return path.join(root, `output-${sequence}.${extension}`);
}

function reply(
  res,
  body = { data: [{ b64_json: PNG.toString("base64") }] },
  status = 200,
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function runCli(args, overrides = {}) {
  // 子进程完全使用虚构 API 配置，不复制宿主环境或其他变量。
  const env = {
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_BASE_URL: baseUrl,
    ...overrides,
  };
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openai-image-test-"));
  server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });
      await handler(req, res, body);
    } catch {
      if (!res.destroyed)
        reply(res, { error: "offline test handler failed" }, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  baseUrl = `${origin}/v1`;
});

beforeEach(() => {
  requests = [];
  handler = (_req, res) => reply(res);
  // node --test 在独立进程中运行此文件；所有真实配置在任何请求前均被覆盖。
  process.env.OPENAI_API_KEY = FAKE_KEY;
  process.env.OPENAI_BASE_URL = baseUrl;
  delete process.env.OPENAI_IMAGE_MODEL;
});

afterEach(() => server.closeAllConnections());

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test("配置采用 CLI/库参数 > OPENAI_* > 默认值，默认模型不被映射", () => {
  assert.deepEqual(resolveConfig({}, {}), {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5",
    apiKey: "",
  });
  const env = {
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_BASE_URL: `${origin}/gateway/v1///`,
    OPENAI_IMAGE_MODEL: "gateway-model",
  };
  assert.equal(resolveConfig({}, env).baseUrl, `${origin}/gateway/v1`);
  assert.equal(resolveConfig({}, env).model, "gateway-model");
  const config = resolveConfig({ baseUrl, model: "explicit-model" }, env);
  assert.equal(config.baseUrl, baseUrl);
  assert.equal(config.model, "explicit-model");
});

test("拒绝危险 base URL 和含控制字符的密钥，不回显输入", () => {
  for (const base of [
    "not-a-url",
    "http://example.com/v1",
    "file:///secret",
    "https://name:secret@example.com",
    "https://example.com/v1?key=secret",
    "https://example.com/#secret",
  ]) {
    assert.throws(
      () => resolveConfig({ baseUrl: base }, {}),
      (error) => error.exitCode === 3 && !error.message.includes("secret"),
    );
  }
  assert.throws(
    () => resolveConfig({}, { OPENAI_API_KEY: "secret\nvalue" }),
    (error) => error.exitCode === 3 && !error.message.includes("secret"),
  );
});

test("文生图发送正确 JSON 和认证，默认一张 PNG 且不混入不兼容字段", async () => {
  const target = out();
  const prompt = "原始提示：雨后街头，保留换行\n不要自动翻译。";
  assert.equal(await generateImage({ prompt, out: target }), target);
  assert.deepEqual(await fs.readFile(target), PNG);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "/v1/images/generations");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(request.body), {
    model: "gpt-image-2.5",
    prompt,
    n: 1,
    output_format: "png",
  });
});

test("显式覆盖模型和 API 根路径，不重复追加 /v1", async () => {
  process.env.OPENAI_IMAGE_MODEL = "environment-model";
  await generateImage({
    prompt: "test",
    out: out(),
    baseUrl: `${origin}/custom/api/`,
    model: "custom-image-2026",
  });
  assert.equal(requests[0].url, "/custom/api/images/generations");
  assert.equal(JSON.parse(requests[0].body).model, "custom-image-2026");
});

test("仅传递用户指定的可选参数，不限制未知模型的合法尺寸与质量名称", async () => {
  await generateImage({
    prompt: "test",
    out: out(),
    size: "2048x1024",
    quality: "max",
    background: "transparent",
  });
  const body = JSON.parse(requests[0].body);
  assert.equal(body.size, "2048x1024");
  assert.equal(body.quality, "max");
  assert.equal(body.background, "transparent");
  assert.ok(!Object.hasOwn(body, "response_format"));
  assert.ok(!Object.hasOwn(body, "input_fidelity"));
  assert.ok(!Object.hasOwn(body, "stream"));
});

test("多参考图采用 multipart image[]，保留顺序和原始提示", async () => {
  const refs = [
    path.join(root, "参考图 一.png"),
    path.join(root, "reference-two.png"),
  ];
  await Promise.all(refs.map((ref) => fs.writeFile(ref, PNG)));
  await generateImage({
    prompt: "只替换背景，不要修改主体。",
    refs,
    out: out(),
    quality: "high",
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "/v1/images/edits");
  assert.match(
    request.headers["content-type"],
    /^multipart\/form-data; boundary=/,
  );
  const form = await new Response(request.body, {
    headers: { "Content-Type": request.headers["content-type"] },
  }).formData();
  assert.equal(form.get("model"), "gpt-image-2.5");
  assert.equal(form.get("prompt"), "只替换背景，不要修改主体。");
  assert.equal(form.get("n"), "1");
  assert.equal(form.get("quality"), "high");
  const images = form.getAll("image[]");
  assert.equal(images.length, 2);
  assert.equal(images[0].name, path.basename(refs[0]));
  assert.equal(images[1].name, path.basename(refs[1]));
  assert.equal(images[0].type, "image/png");
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), PNG);
});

test("缺密钥、参考图缺失或伪造图片时，在联网前失败", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(generateImage({ prompt: "test", out: out() }), {
    exitCode: 3,
  });
  process.env.OPENAI_API_KEY = FAKE_KEY;
  await assert.rejects(
    generateImage({
      prompt: "test",
      refs: [path.join(root, "missing.png")],
      out: out(),
    }),
    { exitCode: 4 },
  );
  const fakeImage = path.join(root, "fake.png");
  await fs.writeFile(fakeImage, "not an image");
  await assert.rejects(
    generateImage({ prompt: "test", refs: [fakeImage], out: out() }),
    { exitCode: 4 },
  );
  assert.equal(requests.length, 0);
});

test("参数错误均在 API 调用前发现", async () => {
  for (const options of [
    { prompt: "  " },
    { out: "bad.exe" },
    { model: "" },
    { size: "0x1024" },
    { quality: "" },
    { background: "invalid" },
    { timeoutSec: 0 },
    { timeoutSec: Infinity },
    { timeoutSec: 3601 },
    { refs: new Array(17).fill("a.png") },
    { refs: "a.png" },
    { outputFormat: "invalid" },
    { outputFormat: "webp" },
    { background: "transparent", out: out("jpg") },
  ]) {
    await assert.rejects(
      generateImage({ prompt: "test", out: out(), ...options }),
      (error) => error instanceof ImageApiError && error.exitCode === 2,
    );
  }
  assert.equal(requests.length, 0);
});

test("CLI 支持 UTF-8 提示文件和 BOM，不改写内容", async () => {
  const prompt = '中文多行提示\n引号："雨"，反引号：`，保持原样。';
  const promptFile = path.join(root, "提示.txt");
  await fs.writeFile(
    promptFile,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(prompt)]),
  );
  const result = await runCli(["--prompt-file", promptFile, "--out", out()]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(requests[0].body).prompt, prompt);
});

test("CLI 检查配置不联网，密钥只显示布尔值", async () => {
  const result = await runCli(["--check-config"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    baseUrl,
    model: "gpt-image-2.5",
    apiKeyConfigured: true,
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_KEY));
  assert.equal(requests.length, 0);
  const missing = await runCli(["--check-config"], { OPENAI_API_KEY: "" });
  assert.equal(JSON.parse(missing.stdout).apiKeyConfigured, false);
});

test("dry-run 不联网、不写文件，并展示明确参数", async () => {
  const target = out();
  const result = await runCli([
    "--prompt",
    "preview",
    "--out",
    target,
    "--dry-run",
    "--model",
    "explicit",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.model, "explicit");
  assert.equal(preview.endpoint, `${baseUrl}/images/generations`);
  assert.equal(preview.out, target);
  assert.ok(!result.stdout.includes(FAKE_KEY));
  await assert.rejects(fs.access(target));
  assert.equal(requests.length, 0);
});

test("CLI 缺少密钥时正确退出且不请求 API", async () => {
  const result = await runCli(["--prompt", "test", "--out", out()], {
    OPENAI_API_KEY: "",
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /OPENAI_API_KEY/);
  assert.equal(requests.length, 0);
});

test("CLI 拒绝重复参数、冲突提示、未知参数、漏值和原型属性名", async () => {
  for (const args of [
    [],
    ["--prompt", "a", "--prompt", "b"],
    ["--prompt", "a", "--prompt-file", "a.txt"],
    ["--prompt"],
    ["--unknown"],
    ["__proto__"],
    ["--check-config", "--dry-run"],
    ["--prompt", "test", "--timeout-sec", "NaN"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, JSON.stringify({ args, result }));
  }
  assert.equal(requests.length, 0);
});

test("CLI 帮助无需密钥，生成未指定 out 时使用唯一 PNG 路径", async () => {
  const help = await runCli(["--help"], { OPENAI_API_KEY: "" });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--prompt-file/);
  const result = await runCli(["--prompt", "default output"]);
  assert.equal(result.code, 0, result.stderr);
  const target = result.stdout.trim();
  assert.equal(path.dirname(target), root);
  assert.match(path.basename(target), /^openai-image-.*\.png$/);
  assert.deepEqual(await fs.readFile(target), PNG);
});

test("拒绝空响应、错误 base64、损坏图片和多图响应，不写成品", async () => {
  for (const body of [
    null,
    {},
    { data: [] },
    { data: [null] },
    { data: [{ partial_image_b64: PNG.toString("base64") }] },
    { data: [{ b64_json: "not base64" }] },
    { data: [{ b64_json: "AAAA" }] },
    { data: [{ b64_json: PNG.subarray(0, -12).toString("base64") }] },
    {
      data: [
        { b64_json: PNG.toString("base64") },
        { b64_json: PNG.toString("base64") },
      ],
    },
  ]) {
    handler = (_req, res) => reply(res, body);
    const target = out();
    await assert.rejects(generateImage({ prompt: "test", out: target }), {
      exitCode: 7,
    });
    await assert.rejects(fs.access(target));
  }
});

test("HTTP 错误分层、不回显远端的密钥、不自动重试或换模型", async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const count = requests.length;
    handler = (_req, res) =>
      reply(res, { error: { message: `remote echoed ${FAKE_KEY}` } }, status);
    const result = await runCli(["--prompt", "test", "--out", out()]);
    assert.equal(result.code, 5);
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_KEY));
    assert.equal(requests.length, count + 1);
    assert.equal(
      JSON.parse(requests[requests.length - 1].body).model,
      "gpt-image-2.5",
    );
  }
});

test("HTML 和 SSE 响应不当作最终图片，也不回显原始内容", async () => {
  handler = (_req, res) =>
    res.end(`data: {"partial_image_b64":"${FAKE_KEY}"}\n\n`);
  const result = await runCli(["--prompt", "test", "--out", out()]);
  assert.equal(result.code, 7);
  assert.ok(!result.stderr.includes(FAKE_KEY));
});

test("URL 响应下载不携带 API Key，不将签名 URL 写入日志", async () => {
  handler = (req, res) => {
    if (req.url.startsWith("/download")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
    } else
      reply(res, {
        data: [{ url: `${origin}/download?signature=signed-secret` }],
      });
  };
  const target = out();
  const result = await runCli(["--prompt", "test", "--out", target]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await fs.readFile(target), PNG);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].headers.authorization, undefined);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("signed-secret"));
});

test("主 API 重定向不会被跟随，不向其他地址转发密钥", async () => {
  handler = (_req, res) => {
    res.writeHead(307, { Location: `${origin}/credential-leak` });
    res.end();
  };
  await assert.rejects(generateImage({ prompt: "test", out: out() }), {
    exitCode: 6,
  });
  assert.equal(requests.length, 1);
});

test("图片 URL 重定向不跟随，外部明文 URL 和凭据 URL 被拒绝", async () => {
  handler = (req, res) => {
    if (req.url === "/download") {
      res.writeHead(302, { Location: `${origin}/redirected` });
      res.end();
    } else reply(res, { data: [{ url: `${origin}/download` }] });
  };
  await assert.rejects(generateImage({ prompt: "test", out: out() }), {
    exitCode: 6,
  });
  assert.equal(requests.length, 2);
  for (const url of [
    "http://example.com/image.png",
    "file:///private.png",
    "https://user:secret@example.com/a.png",
  ]) {
    handler = (_req, res) => reply(res, { data: [{ url }] });
    const count = requests.length;
    await assert.rejects(generateImage({ prompt: "test", out: out() }), {
      exitCode: 7,
    });
    assert.equal(requests.length, count + 1);
  }
});

test("API 超时只发送一次请求，说明计费可能已发生", async () => {
  handler = () => {};
  await assert.rejects(
    generateImage({ prompt: "test", out: out(), timeoutSec: 0.1 }),
    (error) => error.exitCode === 6 && /计费/.test(error.message),
  );
  assert.equal(requests.length, 1);
});

test("超时覆盖图片下载阶段，不重新生成", async () => {
  handler = (req, res) => {
    if (req.method === "POST")
      reply(res, { data: [{ url: `${origin}/hanging-download` }] });
  };
  await assert.rejects(
    generateImage({ prompt: "test", out: out(), timeoutSec: 0.1 }),
    { exitCode: 6 },
  );
  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    1,
  );
  assert.equal(requests.length, 2);
});

test("服务返回格式与扩展名不同时更正路径，不把 PNG 伪装为 JPEG", async () => {
  const requested = out("jpg");
  const actual = await generateImage({ prompt: "test", out: requested });
  assert.equal(actual, requested.replace(/\.jpg$/, ".png"));
  assert.deepEqual(await fs.readFile(actual), PNG);
  await assert.rejects(fs.access(requested));
  assert.equal(JSON.parse(requests[0].body).output_format, "jpeg");
});

test("已有输出在请求前被保护，格式更正也不覆盖已有文件", async () => {
  const target = out();
  await fs.writeFile(target, "keep this file");
  await assert.rejects(generateImage({ prompt: "test", out: target }), {
    exitCode: 8,
  });
  assert.equal(requests.length, 0);
  assert.equal(await fs.readFile(target, "utf8"), "keep this file");
  const requested = out("jpg");
  const actual = requested.replace(/\.jpg$/, ".png");
  await fs.writeFile(actual, "another existing file");
  await assert.rejects(generateImage({ prompt: "test", out: requested }), {
    exitCode: 8,
  });
  assert.equal(await fs.readFile(actual, "utf8"), "another existing file");
});

test("写入时出现路径冲突也不覆盖", async () => {
  const target = out();
  handler = async (_req, res) => {
    await fs.writeFile(target, "created while generating");
    reply(res);
  };
  await assert.rejects(generateImage({ prompt: "test", out: target }), {
    exitCode: 8,
  });
  assert.equal(await fs.readFile(target, "utf8"), "created while generating");
});

test("无网络连接时使用安全错误，不回显底层异常或重试", async () => {
  const unusedServer = http.createServer();
  await new Promise((resolve) => unusedServer.listen(0, "127.0.0.1", resolve));
  const unusedBase = `http://127.0.0.1:${unusedServer.address().port}/v1`;
  await new Promise((resolve) => unusedServer.close(resolve));
  await assert.rejects(
    generateImage({ prompt: "test", out: out(), baseUrl: unusedBase }),
    (error) => error.exitCode === 6 && !error.message.includes(FAKE_KEY),
  );
  assert.equal(requests.length, 0);
});

test("非 UTF-8 提示文件在联网前被拒绝，不静默替换字符", async () => {
  const promptFile = path.join(root, "invalid-utf8.txt");
  await fs.writeFile(promptFile, Buffer.from([0xff, 0xfe, 0x41]));
  const result = await runCli(["--prompt-file", promptFile, "--out", out()]);
  assert.equal(result.code, 4);
  assert.equal(requests.length, 0);
});

test("大体积 base64 不导致正则栈溢出，非图片内容安全失败", async () => {
  handler = (_req, res) =>
    reply(res, {
      data: [{ b64_json: Buffer.alloc(4_000_000).toString("base64") }],
    });
  await assert.rejects(generateImage({ prompt: "test", out: out() }), {
    exitCode: 7,
  });
  assert.equal(requests.length, 1);
});

test("下载失败不打印签名 URL 或远端敏感响应，也不重新生成", async () => {
  handler = (req, res) => {
    if (req.method === "POST")
      reply(res, {
        data: [{ url: `${origin}/expired?signature=private-signature` }],
      });
    else reply(res, { error: FAKE_KEY }, 403);
  };
  const result = await runCli(["--prompt", "test", "--out", out()]);
  assert.equal(result.code, 6);
  assert.match(result.stderr, /HTTP 403/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("private-signature"));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_KEY));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.authorization, undefined);
});

test("收到响应头后正文停滞也受整体超时约束", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"data":[');
  };
  await assert.rejects(
    generateImage({ prompt: "test", out: out(), timeoutSec: 0.1 }),
    { exitCode: 6 },
  );
  assert.equal(requests.length, 1);
});
