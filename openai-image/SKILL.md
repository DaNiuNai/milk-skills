---
name: openai-image
description: >
  当任务适合使用 AI 创建的位图视觉素材时，生成或编辑栅格图像，例如照片、插画、纹理、精灵图、效果图或透明背景抠图。当需要创建全新图像、变换现有图像，或根据参考图衍生视觉变体，且输出应为位图素材而非仓库原生代码或矢量图时使用。如果任务更适合通过编辑现有 SVG、矢量或代码原生素材、扩展已有图标或标志系统，或直接使用 HTML/CSS/canvas 构建视觉内容来完成，则不要使用。
---

# OpenAI Image API

调用用户自己的图像 API，生成或编辑一张图片并保存为本地文件。这个 skill 不复用 ChatGPT 订阅；API 服务可能按请求计费。默认模型 `gpt-image-2.5` 是可配置的服务端标识，不代表所有服务都提供该模型。

## 工作流程

### 1. 确定任务与授权

- 区分文生图与参考图编辑；有参考图时使用编辑接口，按用户给出的顺序传入图片。
- 原样传递用户提示。除非用户要求，不翻译、润色或增加风格；复杂、多行或含 shell 特殊字符的提示使用 UTF-8 文件。
- 明确输出路径。默认 PNG；如用户要求 JPEG/WebP，使用相应扩展名。选择未使用的文件名，不覆盖已有资产。
- 遵守宿主环境的工具与安全要求。用户指定 API 路线时，不静默切换到 Codex、订阅登录、内置图像工具或其他服务。
- API 环境变量存在不等于用户已授权向该地址上传。首次使用非官方服务时，告知目标地址会接收提示和参考图；没有当前任务的发送/计费授权时先确认。已确认同一服务和本次任务范围后不必重复询问。
- 用户只要接入代码、提示词或接口解释时，不实际生成图片。

### 2. 检查配置，不查看密钥

先找到本 skill 的绝对路径。下文 `<skill目录>` 是安装后的 `openai-image` 目录，不是用户项目的工作目录；调用脚本时使用绝对路径。

```bash
node "<skill目录>/scripts/gen.js" --check-config
```

此命令不联网，只输出 API 根地址、模型名和 `apiKeyConfigured` 布尔值。由脚本内部读取以下已知变量；不要运行环境变量列表、打印真实密钥或加载 `.env` / `.env.local`。

| 配置       | 优先级                                                         |
| ---------- | -------------------------------------------------------------- |
| API Key    | `OPENAI_API_KEY`；不支持命令行传密钥                           |
| API 根地址 | `--base-url` → `OPENAI_BASE_URL` → `https://api.openai.com/v1` |
| 模型       | `--model` → `OPENAI_IMAGE_MODEL` → `gpt-image-2.5`             |

用户在本机自行配置凭据，不要让用户把 Key 粘贴到聊天、提示文件或命令行中。新设系统环境变量后，可能需要重新启动宿主应用才对脚本生效。缺少 Key 时停止并说明缺少哪个变量；不要寻找其他配置文件或凭据。

base URL 是 **API 根地址**：官方为 `https://api.openai.com/v1`，兼容服务可能为 `https://example.com/v1` 或其他路径。脚本在根地址后追加 `/images/generations` 或 `/images/edits`，不会自动添加 `/v1`。仅本地回环服务允许 HTTP。

### 3. 调用脚本

**文生图：**

```bash
node "<skill目录>/scripts/gen.js" --prompt "一只坐在窗边看雨的橘猫，水彩风格。" --out "./rain-cat.png"
```

**单张参考图编辑：**

```bash
node "<skill目录>/scripts/gen.js" --prompt "保留主体和构图，只把背景改成雪山。" --ref "./reference.png" --out "./edited.png"
```

**多参考图：**

```bash
node "<skill目录>/scripts/gen.js" --prompt "使用第一张图的主体与第二张图的场景，统一光照和透视。" --ref "./subject.png" --ref "./scene.png" --out "./combined.png"
```

**明确指定模型及输出参数：**

```bash
node "<skill目录>/scripts/gen.js" --prompt-file "./prompt.txt" --model "gpt-image-2.5" --size "1536x1024" --quality "high" --out "./landscape.webp"
```

模型名原样发送；服务不支持时报告错误，不静默更换模型、服务或认证方式。仅当用户明确指定时传入 size、quality 和 background；不同模型和兼容服务的支持范围可能不同。

**调用前预览，不联网、不写图片：**

```bash
node "<skill目录>/scripts/gen.js" --prompt-file "./prompt.txt" --out "./result.png" --dry-run
```

`--dry-run` 会校验提示、参考图和输出路径，展示目标接口与参数，但不会展示 Key。它不能证明凭据、模型或额度有效。

### 4. 检查并交付实际图片

成功时 stdout 只有最终图片的绝对路径。以该路径为准：如果服务返回格式与请求不一致，脚本按实际文件签名更正扩展名，不做格式转换。

- 打开实际文件做视觉检查；不能仅靠“请求成功”判断内容正确。
- 交付可打开的图片/文件链接，并简述保存位置和配置使用的模型。没有视觉检查能力时明确说明未做画面验收。
- 不把模拟测试图片、预览、HTML 或流式中间图当作真实生成结果。
- 一次调用固定生成一张。用户要多张独立成品时，分别调用，并确认整体数量和费用范围；不要未经同意增加调用次数。
- 不自动重试收费请求。尤其遇到超时、下载或保存失败，服务端可能已经完成生成并计费；先说明失败层级再决定下一步。

## 参数

| 参数                         | 说明                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `--prompt` / `--prompt-file` | 二选一；文件使用 UTF-8，去掉开头 BOM，其他内容原样发送                      |
| `--out`                      | `.png` / `.jpg` / `.jpeg` / `.webp`；省略时在当前目录生成唯一 PNG 文件名    |
| `--ref`                      | 可重复，最多 16 张；支持实际内容为 PNG/JPEG/WebP 的本地文件，每张小于 50 MB |
| `--model`                    | 覆盖模型环境变量与默认值；不探测或映射模型                                  |
| `--base-url`                 | 覆盖 API 根地址；不允许 URL 内嵌用户名、密码、查询参数或片段                |
| `--size`                     | `auto` 或 `WIDTHxHEIGHT`；具体范围由服务端校验                              |
| `--quality`                  | 例如 `auto` / `low` / `medium` / `high`；原样发送服务端质量标识             |
| `--output-format`            | `png` / `jpeg` / `webp`；默认根据输出扩展名确定，明确指定时应与扩展名一致   |
| `--background`               | `auto` / `opaque` / `transparent`；透明背景仅适用于 PNG/WebP                |
| `--timeout-sec`              | 默认 300，范围大于 0 且不超过 3600；覆盖生成及后续下载                      |
| `--check-config`             | 离线配置检查；仅能与 `--base-url`、`--model` 组合                           |
| `--dry-run`                  | 离线预检，仍需提供提示并校验本地参考图                                      |

本次不支持 mask、流式预览、变体接口、Responses API、批量生成、DALL·E 专用参数或任意额外请求字段。需要协议细节或排障时再读 [API 说明](references/api-notes.md)。

## 失败处理

| 退出码 | 层级                                                    |
| ------ | ------------------------------------------------------- |
| 0      | 成功；或完成 help / check-config / dry-run              |
| 1      | 未预期的内部错误                                        |
| 2      | 参数不合法                                              |
| 3      | 缺少或无效的 API 配置                                   |
| 4      | 参考图或提示文件无法读取/格式不支持                     |
| 5      | API HTTP 错误：参数、认证、权限、模型、限流或服务端错误 |
| 6      | 网络、重定向、超时或图片下载失败                        |
| 7      | 空响应、错误 JSON/base64、非最终图片或文件结构不完整    |
| 8      | 输出冲突或写入失败                                      |

给出简短、可执行的说明。401/403 引导用户在本机检查凭据/权限；404 检查模型和 API 根路径；429 检查额度/限流。不要把完整响应体、请求头或底层异常打印给用户，也不承诺所有 429 都是额度问题。

## 作为 JS 库复用

仍由 `OPENAI_API_KEY` 提供凭据，不向库参数传 Key：

```js
const {
  generateImage,
  ImageApiError,
} = require("<skill目录>/scripts/image-gen.js");

async function main() {
  const outputPath = await generateImage({
    prompt: "保留角色外观，只把背景改为海边。",
    refs: ["./character.png"],
    out: "./seaside.png",
    model: "gpt-image-2.5",
    timeoutSec: 300,
  });
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof ImageApiError ? error.message : "内部错误");
  process.exitCode = error.exitCode || 1;
});
```

库返回最终写入路径；不保存密钥、原始响应或模型使用记录，不加载额外配置。
