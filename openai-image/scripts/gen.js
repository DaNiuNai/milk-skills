#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  generateImage,
  ImageApiError,
  describeConfig,
  previewRequest,
} = require("./image-gen");

function usage() {
  return `通过 OpenAI Images API 或兼容接口生成/编辑一张图片（Node.js 22+，无额外依赖）。

用法：
  node scripts/gen.js --check-config
  node scripts/gen.js --prompt "<原始提示>" --out <图片.png> [--ref <参考图>]...
  node scripts/gen.js --prompt-file <UTF-8文件> --out <图片.png> [选项]

选项：
  --model <名称>           覆盖 OPENAI_IMAGE_MODEL；默认 gpt-image-2.5，原样传递
  --base-url <API根地址>   覆盖 OPENAI_BASE_URL；默认 https://api.openai.com/v1
  --size <WIDTHxHEIGHT>    或 auto；由服务端校验模型支持的尺寸
  --quality <质量标识>     例如 low、medium、high、auto；由服务端校验
  --output-format <格式>   png、jpeg、webp；默认根据 --out 扩展名确定
  --background <类型>     auto、opaque、transparent
  --timeout-sec <秒>      默认 300，最多 3600；包括图片下载，不自动重试
  --dry-run               校验文件和参数，输出请求预览；不联网、不写文件
  --check-config          只输出 API 根地址、模型和密钥是否存在；不联网
  -h, --help              帮助

API Key 仅从 OPENAI_API_KEY 读取；不加载 .env，也不支持命令行密钥。
--prompt 与 --prompt-file 二选一；--out 省略时使用当前目录的唯一 PNG 文件名。
--ref 可重复使用，最多 16 张；不支持 mask、流式输出或批量生成。
已有文件绝不覆盖。服务实际返回格式不同时，自动更正扩展名并输出最终路径。
除已获授权的本地 HTTP 回环服务外，只支持 HTTPS。真实调用可能产生费用。

退出码：0 成功；1 内部错误；2 参数；3 配置；4 参考图/提示文件；
        5 API HTTP 错误；6 网络/超时/下载；7 响应/图片格式；8 输出文件。`;
}

function parseArgs(argv) {
  const options = { refs: [] };
  const values = {
    "--prompt": "prompt",
    "--prompt-file": "promptFile",
    "--out": "out",
    "--ref": "refs",
    "--model": "model",
    "--base-url": "baseUrl",
    "--size": "size",
    "--quality": "quality",
    "--output-format": "outputFormat",
    "--background": "background",
    "--timeout-sec": "timeoutSec",
  };
  const booleans = { "--check-config": "checkConfig", "--dry-run": "dryRun" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    const key = booleans[flag] || values[flag];
    if (!key || !Object.hasOwn({ ...booleans, ...values }, flag)) {
      throw new ImageApiError("未知参数；使用 --help 查看支持的选项。", 2);
    }
    if (key !== "refs" && Object.hasOwn(options, key)) {
      throw new ImageApiError("非 ref 参数不能重复指定。", 2);
    }
    if (Object.hasOwn(booleans, flag)) {
      options[key] = true;
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ImageApiError(
          "参数缺少值；复杂提示建议使用 --prompt-file。",
          2,
        );
      }
      index += 1;
      if (key === "refs") options.refs.push(value);
      else options[key] = key === "timeoutSec" ? Number(value) : value;
    }
  }
  if (options.checkConfig) {
    if (
      Object.keys(options).some(
        (key) => !["refs", "checkConfig", "baseUrl", "model"].includes(key),
      ) ||
      options.refs.length
    ) {
      throw new ImageApiError(
        "--check-config 只能与 --base-url、--model 一起使用。",
        2,
      );
    }
    return options;
  }
  if ((options.prompt !== undefined) === (options.promptFile !== undefined)) {
    throw new ImageApiError("请且仅请提供 --prompt 或 --prompt-file 之一。", 2);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.checkConfig) {
    console.log(JSON.stringify(describeConfig(options), null, 2));
    return;
  }
  if (options.promptFile !== undefined) {
    try {
      const bytes = await fs.readFile(options.promptFile);
      options.prompt = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ImageApiError("无法读取 UTF-8 提示文件，请检查路径和权限。", 4);
    }
  }
  options.out ??= path.resolve(
    `openai-image-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`,
  );
  if (options.dryRun) {
    console.log(JSON.stringify(await previewRequest(options), null, 2));
    return;
  }
  console.log(await generateImage(options));
}

main().catch((error) => {
  if (error instanceof ImageApiError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    console.error(
      "内部错误；未输出可能含敏感信息的底层异常，请先排查本地参数与运行时。 ",
    );
    process.exitCode = 1;
  }
});
