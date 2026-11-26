# CLI 选项 ↔ API 字段

## generate → `POST /v1/images/generations`（JSON）

| CLI | API 字段 | 说明 |
| --- | --- | --- |
| `-m` | `model` | |
| `-p` / `--prompt-file` | `prompt` | ≤ 32000 字符 |
| `-n` | `n` | 1–10 |
| `-s` | `size` | `auto` 或 `宽x高` |
| `-q` | `quality` | |
| `--background` | `background` | |
| `-f` | `output_format` | png/jpeg/webp/svg/gif |
| `--compression` | `output_compression` | 0–100，仅 jpeg/webp |
| `--complexity` | `complexity` | 仅 2.6 |
| `--moderation` | `moderation` | auto/low |
| `--frames` | `frame_count` | GIF，2–16，默认 9 |
| `--frame-duration` | `frame_duration_ms` | GIF，20–2000，默认 200，按 10ms 取整 |
| `--svg-model` | `svg.model` | SVG 作者模型；不传时使用 `config.svgModel` |
| `--svg-effort` | `svg.reasoning.effort` | none/minimal/low/medium/high/xhigh/max |
| `--stream` | `stream` | SSE：`image_generation.partial_image` / `image_generation.completed` |
| `--partial-images` | `partial_images` | 0–3，每张 partial 额外消耗 100 output token |
| `--safety-id` | `safety_identifier` | ≤ 128 字符，用户名或邮箱的哈希值 |
| `--param k=v` | 任意字段 | 值按 JSON 解析，`a.b=1` 会写成嵌套字段 |

响应：`data[].b64_json`（SVG 解码后是 UTF-8 XML），以及 `revised_prompt`、`usage`、`svg_usage`、`size`、`quality`、`background`、`output_format`。

限制：SVG 需要 `n=1`，且不支持 stream / partial / compression；GIF 不支持 stream / partial / compression / mask。

## edit → `POST /v1/images/edits`（JSON）

在 generate 的基础上增加：

| CLI | API 字段 | 说明 |
| --- | --- | --- |
| `-i`（可重复） | `images[]` | `{ image_url }` 或 `{ file_id }`，最多 16 张 |
| `--mask` | `mask` | 作用于第一张图；必须带 alpha 通道，与原图格式、尺寸相同，< 50MB |
| `--markup` | `markup` | 透明 PNG，尺寸与第一张图相同，必须有透明像素；不能和 mask 同时使用；单张 ≤ 16,777,216 像素 |
| `--input-fidelity` | `input_fidelity` | 2 / 2.5 / 2.6 都不要传 |

edit 不支持 `svg` 输出，SVG 也不能作为编辑的输入图。流式事件：`image_edit.partial_image` / `image_edit.completed`。

图片引用：本地路径会自动转成 base64 data URL；超过约 15MB 时会先上传到 Files API（purpose=vision），改用 `file_id`。`https://` 开头的按 URL 处理，`file-xxx` 按已上传文件的 id 处理。

## respond → `POST /v1/responses`

```json
{
  "model": "<--main-model>",
  "input": "<prompt>" | [{ "role": "user", "content": [{ "type": "input_text" }, { "type": "input_image" }] }],
  "tools": [{ "type": "image_generation", "model": "<-m>", "size": "", "quality": "", "background": "",
              "output_format": "", "output_compression": 0, "partial_images": 0, "moderation": "",
              "complexity": "", "frame_count": 0, "frame_duration_ms": 0, "action": "auto|generate|edit",
              "input_image_mask": { "image_url": "" } }],
  "tool_choice": { "type": "image_generation" },
  "previous_response_id": "<--previous / --continue>",
  "safety_identifier": "",
  "stream": true
}
```

- 默认强制调用图像工具（`tool_choice`），`--no-force-tool` 则交给主模型决定。
- 结果中的 `image_generation_call` 包含 `result`（base64）、`revised_prompt` 和 `id`。还可以用 `{ "type": "item_reference", "id": "ig_..." }` 引用之前生成的图片，需要时通过 `--param` 构造 input。
- 流式事件：`response.image_generation_call.partial_image`（`partial_image_b64`）、`response.completed`。
- `action: "edit"` 要求上下文里有图片，否则会报错。
- Responses 请求还会按主模型的 token 计费；2.x 的缓存输入价格只适用于 Responses 工具。

## 错误

- `type: image_generation_user_error`：请求本身需要修改（参数、提示词或输入图），不要原样重试。`code` 是稳定的判断依据。
- `code: moderation_blocked`：可能带有 `moderation_details: { moderation_stage: input|output|unknown, categories: [...] }`。面向用户的提示保持笼统，详细信息只用于排查。
- 429（不含 `insufficient_quota`）、5xx、网络错误：脚本会按 2s、4s 退避重试（若有 `retry-after` 则优先使用），最多 2 次。

## 价格（2026-11）

图像输出 $30 / 1M token（Batch 为 $15）；图像输入 $8 / 1M；文本输入 $5 / 1M。同一质量设置下，不同模型的 token 消耗不同。实测 1024x1024 low 约 820 个输出 token（约 $0.025）。以响应中的 `usage` 为准。
