# 模型与能力矩阵

能力定义以 `scripts/lib/models.mjs` 为准，本文件用于说明背景和选型。依据：OpenAI 官方文档 + 2026-11-26 实测。

## 选型

| 场景 | 首选 |
| --- | --- |
| 新需求、日常出图、快速迭代 | `gpt-image-2.6-flare`（默认） |
| 细节多、密集文字、复杂排版、精确编辑、人物身份保持 | `gpt-image-2.6-sunburst` |
| 需要复现 / 对比 2.5 的效果 | `gpt-image-2.5-flare`（对应 2.6-flare）或 `gpt-image-2.5-sunburst`（对应 2.6-sunburst） |
| 维护旧工作流 | `gpt-image-2`（已弃用） |

官方建议：Sunburst 能满足要求时，再用相同提示词和参数试一下 Flare；如果 Flare 也达标就换成 Flare，因为它更快。

## 能力矩阵

| 能力 | 2.6 flare / sunburst | 2.5 flare / sunburst | gpt-image-2 |
| --- | --- | --- | --- |
| generate / edit | ✓ | ✓ | ✓ |
| Responses 工具（respond） | ✓（实测可用） | ✓ | ✓ |
| quality | auto/low/medium/high/xhigh/max | auto/low/medium/high/xhigh/max | auto/low/medium/high |
| complexity | low/medium/high（默认 high） | ✗（API 报错） | ✗（API 报错） |
| 自定义尺寸 | ✓ | ✓（> 2560x1440 为实验性） | ✓ |
| 透明背景 | ✓ | ✓ | ✗（文档写的是 preview，实测 API 报错） |
| 输出格式 | png/jpeg/webp/svg/gif | png/jpeg/webp | png/jpeg/webp |
| SVG | generate、respond（edit 不支持） | ✗ | ✗ |
| GIF | generate、edit、respond | ✗（未开放） | ✗ |
| mask | ✓ | ✓ | ✓ |
| markup | ✓ | ✓ | 文档未列出，实测 API 接受并能生效（脚本会给出警告） |
| input_fidelity | 不要传 | 不要传 | 不要传（始终是高保真） |
| n | 1–10 | 1–10 | 1–10 |
| 输入图片数量 | ≤ 16 | ≤ 16 | ≤ 16 |
| 快照 | — | `-2026-09-08` | `gpt-image-2-2026-04-21` |

## 实测记录（2026-11-26）

- 本账号可用的图像模型：gpt-image-2.6-flare/sunburst、gpt-image-2.5-flare/sunburst（及快照）、gpt-image-2（及快照）、gpt-image-1.5、gpt-image-1-mini、chatgpt-image-latest。
- 2.6 系列 SVG 必须提供 `svg.model`（报错 "SVG generation requires 'svg.model'"），说明本项目开启了 SVG 作者模型选择。`config.json` 的 `svgModel` 默认是 `gpt-5.5`；low 质量的图标大约 75 秒，SVG 作者部分另外消耗约 8k token。
- Responses 工具中 2.6-flare 可以正常使用，并且接受 `complexity`、`output_format=svg`、`output_format=gif` + `frame_count`。
- 开启 `stream` + `partial_images` 后，各模型（2.6-flare high、2.5-sunburst medium、gpt-image-2 medium，以及 Responses）都只返回 `*.completed` 事件，没有收到 partial 预览。代码保留了对 partial 事件的处理。
- 1024x1024 low 质量的耗时：2.6-flare 约 5–6 秒，2.6-sunburst 约 8 秒，2.5-flare 约 9 秒，gpt-image-2 约 15 秒。不指定 size 做编辑时，输出可能是 1254x1254 这类非标准尺寸。
- 网络：本机必须通过代理才能访问 api.openai.com（直连超时）。

## 新增模型

在 `config.json` 中添加：

```json
{
  "models": {
    "gpt-image-3-flare": {
      "extends": "gpt-image-2.6-flare",
      "summary": "……",
      "qualities": ["auto", "low", "medium", "high", "xhigh", "max"],
      "formats": { "generate": ["png", "jpeg", "webp", "svg", "gif", "avif"], "edit": ["png", "jpeg", "webp", "gif"], "respond": ["png", "jpeg", "webp"] }
    }
  }
}
```

`extends` 可以指向一个已有模型或家族（`family/gpt-image-2`、`family/gpt-image-2.5`、`family/gpt-image-2.6`），只需写出不同的字段。字段说明：

| 字段 | 含义 |
| --- | --- |
| `endpoints` | `{ generate, edit, responsesTool }` 是否可用 |
| `qualities` / `backgrounds` | 允许的取值 |
| `formats` | 按 `generate` / `edit` / `respond` 分别列出允许的输出格式 |
| `size` | `{ mode: "flex" \| "fixed", presets, multiple, maxEdge, maxRatio, minPixels, maxPixels, experimentalAbovePixels }` |
| `complexity` | `false` 或允许的取值数组 |
| `mask` / `markup` | `true` / `false` / `"undocumented"`（允许使用，但会给出警告） |
| `inputFidelity` | `false` 或允许的取值数组 |
| `maxInputImages` / `maxN` / `maxPartialImages` | 数量上限 |
| `gif` | `null` 或 `{ frameCount: [min, max], frameDurationMs: [min, max] }` |
| `svg` | 是否支持 SVG |
| `deprecated` / `snapshots` / `summary` | 元信息 |

如果新功能需要新的请求字段，可以先用 `--param` / `--tool-param` 传入；确认稳定后，再在 `params.mjs` 中加上对应的 CLI 选项和校验。
