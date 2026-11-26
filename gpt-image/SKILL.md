---
name: gpt-image
description: 使用 OpenAI GPT Image 模型（gpt-image-2.6-flare / gpt-image-2.6-sunburst / gpt-image-2.5-flare / gpt-image-2.5-sunburst / gpt-image-2）生成和编辑图片的零依赖 Node.js 工具。支持文生图、参考图合成、mask 局部重绘、markup 圈注编辑、透明背景、自定义分辨率（最高 4K）、SVG 矢量输出、GIF 动图、批量出图、流式输出，以及 Responses API 多轮对话式改图。只要用户想画图、生成图片/插画/海报/Logo/图标/表情包/产品图/动图、改图、换背景、抠图、P 图、扩图、合成图片、让 AI 出图，或提到 gpt-image、DALL·E、OpenAI 图像生成，都应使用此 skill，即使用户没有明确说"用 OpenAI"。
---

# GPT Image

用 `scripts/gpt-image.mjs`（Node ≥ 24.5，无需 npm install）调用 OpenAI 图像 API。脚本负责代理、参数校验、重试、保存文件，并在 stdout 输出一段 JSON 结果，你只需要决定**用哪个命令、哪个模型、什么参数、什么提示词**。

下文 `$SKILL` 指本 skill 所在目录（SKILL.md 的父目录），命令里请换成实际的绝对路径。

## 前置条件

- API Key：`--api-key` > `config.json` 的 `apiKeyEnv` 所指定的环境变量 > `OPENAI_API_KEY`。`apiKeyEnv` 里填的是**变量名**（如 `"MY_IMAGE_KEY"`），不是 Key 本身，所以分享 skill 时不会泄露密钥。如果设了 `apiKeyEnv` 但对应的变量为空，会直接报错，不会退回 `OPENAI_API_KEY`，防止把 Key 发给错误的服务。`--api-key` 会留在 shell 历史里，只适合临时使用。
- Base URL：`--base-url` > `config.json` 的 `baseUrl` > `OPENAI_BASE_URL` > `https://api.openai.com/v1`。使用第三方兼容服务时，它们未必支持 SVG、GIF、markup、complexity 等功能，遇到本地校验拦截时可以加 `--no-validate`，或者在 `config.json` 的 `models` 里登记该服务实际支持的能力。
- 代理：脚本按 `--proxy` > `GPT_IMAGE_PROXY` > `config.json` 的 `proxy` > `HTTPS_PROXY` 的顺序选择；`--proxy none` 表示直连。网络报错时先检查代理是否在运行。
- `config.json` 里还有默认模型、输出目录（默认是当前工作目录下的 `./output`）、SVG 作者模型等配置。

## 工作流程

1. **判断任务类型并选命令**

   | 需求 | 命令 |
   | --- | --- |
   | 从文字生成新图（含 SVG、GIF） | `generate` |
   | 修改已有图片、参考图合成、局部重绘、圈注编辑 | `edit` |
   | 对同一张图连续多轮改（"再亮一点""换成冬天"），或希望由主模型自动改写提示词 | `respond` |

   用户手上有图要改时用 `edit`；只是"在上一张基础上继续改"时，`edit -i <上一张输出>` 和 `respond --continue` 都行：`edit` 更可控，`respond` 能带上对话上下文。

2. **选模型**（用户没指定就用默认的 `gpt-image-2.6-flare`）

   | 模型 | 适用 |
   | --- | --- |
   | `gpt-image-2.6-flare` | 默认。速度快，日常出图、快速迭代 |
   | `gpt-image-2.6-sunburst` | 细节、密集文字、复杂排版、精确编辑 |
   | `gpt-image-2.5-flare` / `-sunburst` | 用户指定或需要复现 2.5 的效果；没有 complexity/SVG/GIF |
   | `gpt-image-2` | 已弃用，只在用户明确要求时使用；不支持透明背景、xhigh/max |

   完整能力矩阵和实测说明见 `references/models.md`。

3. **定参数**：尺寸、质量、格式等见下面的速查；不确定时用默认值，不要随意加参数。完整参数见 `references/api-params.md`。

4. **写提示词**：把用户需求扩展成清晰、具体的英文或中文描述（主体、构图、风格、光线、需要出现的原文文字、需要保留的内容）。技巧见 `references/prompting.md`，图里要有文字、做编辑、用多张参考图时一定要看。
   - 提示词很长、包含中文或引号时，先写到一个临时 `.txt` 文件里再用 `--prompt-file` 传入，避免 PowerShell/bash 的转义问题。

5. **执行**：
   ```bash
   node "$SKILL/scripts/gpt-image.mjs" generate --prompt-file prompt.txt -s 1536x1024 -q high
   ```
   拿不准参数是否合法时先加 `--dry-run` 看请求体（不会产生费用）。

6. **检查结果**：读取 stdout 的 JSON：`files` 是保存的图片路径，同名 `.json` 是元数据（请求参数、usage、revised_prompt）。用读图工具打开生成的图片，按需求逐项检查（文字是否正确、编辑是否只改了要求的部分、透明背景是否真的透明）。有问题就调整提示词或参数后再来一次，一次只改一个变量。

7. **汇报**：告诉用户文件路径、使用的模型和关键参数、耗时；如果做了多次尝试，简要说明每次改了什么。

## 参数速查

| 选项 | 说明 |
| --- | --- |
| `-s, --size` | `auto`（默认）、`1024x1024`、`1536x1024`（横）、`1024x1536`（竖）、`2048x2048`、`2048x1152`、`3840x2160`、`2160x3840`，或任意 `宽x高`：两边都是 16 的倍数，长宽比 ≤ 3:1，最长边 ≤ 3840，总像素 655,360–8,294,400。2.5 系列超过 2560x1440 属实验性 |
| `-q, --quality` | `auto`（默认）/ `low` / `medium` / `high`；2.5、2.6 另有 `xhigh` / `max`。草稿用 `low`，定稿再提高 |
| `--complexity` | 仅 2.6：`low` / `medium` / `high`（默认 high）。局部小改用 `low`，复杂排版或密集文字保持 `high` |
| `-f, --format` | `png`（默认）/ `jpeg` / `webp`；2.6 支持 `svg`（仅 generate/respond）和 `gif` |
| `--background` | `auto` / `opaque` / `transparent`（需要 png 或 webp；gpt-image-2 不支持） |
| `--compression` | 0–100，仅 jpeg/webp |
| `-n` | 1–10 张（SVG 只能 1 张） |
| `--moderation` | `auto`（默认）/ `low` |
| `-o, --out-dir` / `--name` | 输出目录 / 文件基础名 |

## 常见任务

**透明背景素材**（产品抠图、贴纸、图标）：
```bash
node "$SKILL/scripts/gpt-image.mjs" generate -p "..." --background transparent -f png
```
提示词里也写明 "transparent background, no shadow on the ground"。

**SVG 矢量图**（Logo、图标）：`-f svg`，仅 2.6，`n=1`，不能流式。耗时通常 1 分钟以上（要先出参考图再由 `config.svgModel` 指定的模型写 SVG），提前告诉用户。

**GIF 动图**：`-f gif --frames 9 --frame-duration 200 -s 512x512`。提示词描述主体、动作，并要求回到起始姿态、镜头不动、平滑循环。想基于参考图做动画就用 `edit -i ref.png -f gif`。

**参考图合成**：`edit -i a.png -i b.png ...`（最多 16 张），提示词里按编号说明每张图的作用，如 "Edit the first image: add the lamp from the second image on the desk"。

**局部重绘（mask）**：mask 的**透明区域**是允许修改的区域，尺寸必须与第一张输入图一致。用自带工具生成：
```bash
node "$SKILL/scripts/mask.mjs" --like input.png --rect 60%,0,40%,100% --out mask.png
node "$SKILL/scripts/gpt-image.mjs" edit -i input.png --mask mask.png -p "Add a green pear on the right side"
```
mask 只是引导，模型不保证严格按边界修改。

**圈注编辑（markup，2.5 / 2.6）**：在透明图层上画圈或框标出位置，提示词说明要做什么，并要求去掉圈注：
```bash
node "$SKILL/scripts/mask.mjs" --like room.png --mode markup --circle 30%,40%,8% --out markup.png
node "$SKILL/scripts/gpt-image.mjs" edit -i room.png --markup markup.png -p "Replace the object inside the red circle with a potted plant. Remove the red circle."
```
markup 和 mask 不能同时使用。

**多轮对话改图（Responses API）**：
```bash
node "$SKILL/scripts/gpt-image.mjs" respond -p "Draw a cozy cabin in a snowy forest"
node "$SKILL/scripts/gpt-image.mjs" respond --continue -p "Make it night with warm lights in the windows"
```
`--continue` 读取输出目录里的 `.last-response.json`；也可以用 `--previous <response_id>` 指定。`-i` 可以带参考图，`--action edit|generate` 强制编辑或新建。主模型会改写提示词（结果里有 `revised_prompts`），默认主模型是 `gpt-5.5`（`--main-model` 可改）。

## 结果与错误处理

- 成功：`{"ok": true, "files": [...], "usage": {...}, "elapsed_seconds": ..., "meta": "...json"}`。
- 失败：`{"ok": false, "error": {...}, "hint": "..."}`，退出码 1。
  - `kind: "usage"`：参数不合法，按报错修改（这是本地校验，没有花钱）。
  - `code: "moderation_blocked"` 或 `type: "image_generation_user_error"`：需要修改提示词或输入，**不要原样重试**。向用户简短说明，并给出改写建议。
  - 429 / 5xx / 网络错误：脚本已自动重试 2 次；仍失败时报告给用户。
- `stream` / `--partial-images` 可用，但实测目前各模型基本只返回最终图，不要指望一定能拿到预览图。

## 费用与耗时

按 token 计费，质量越高、尺寸越大越贵越慢。通常几秒到几十秒；复杂提示词、`xhigh`/`max`、4K 尺寸、SVG 可能要 1–2 分钟。批量（`-n` 较大）或高质量大图之前，如果用户没有明确要求，先用 `low` 出一版确认方向。

## 扩展

- 新模型：在 `config.json` 的 `models` 里添加，例如 `"gpt-image-3": { "extends": "gpt-image-2.6-sunburst", "summary": "..." }`，只覆盖不同的能力字段（字段定义见 `scripts/lib/models.mjs`）。也可以直接改 `models.mjs` 的 `MODELS` / `FAMILIES`。
- 新参数：`--param key=value`（Images API 请求体，支持 JSON 值和 `a.b` 嵌套）、`--tool-param key=value`（Responses 的 image_generation 工具）。
- 本地校验落后于 API 时：加 `--no-validate` 直接发送，由 API 判断。
