# Images API 协议与兼容边界

## 请求

- 生成：`POST <base>/images/generations`，`application/json`。
- 编辑：`POST <base>/images/edits`，`multipart/form-data`，每张参考图使用重复的 `image[]` 字段。由原生 FormData 设置 boundary。
- 认证仅向上述 API 地址发送 `Authorization: Bearer <key>`。
- 共同字段为 `model`、原始 `prompt`、固定 `n: 1` 和 `output_format`；用户指定时增加 `size`、`quality`、`background`。
- 默认模型是用户约定的 `gpt-image-2.5`。兼容服务可能使用自定义别名；不能由客户端推断该别名对应哪个官方模型/快照。
- 不发送 `response_format`、`input_fidelity`、`stream` 或 `partial_images`。GPT Image 的编码输出通常在 `b64_json`；`output_format` 表示图片编码格式，而不是响应使用 URL 还是 base64。
- 不对任意模型硬编码官方某个旧版本的尺寸与质量上限。参数语法通过不代表服务端支持；遇到不兼容需依据该服务文档，在用户同意后调整。

## 最终响应

接受恰好一个 `data` 元素：

```json
{
  "data": [{ "b64_json": "<标准 base64 图片编码>" }]
}
```

兼容服务也可以返回 `data[0].url`。下载使用独立请求，不携带 API Key、不跟随重定向，不打印签名 URL。仅接受 HTTPS；本地测试允许与 API 同源的 HTTP 回环下载。返回图片必须为 PNG/JPEG/WebP，每张最多 50 MB。

脚本检查 base64 规范编码、文件签名及基本结构完整性（例如 PNG chunk 边界和 IEND、JPEG 结尾、WebP 容器长度），不做完整的图片解码、CRC 验证或视觉质量评分。不能据此承诺像素数据绝无损坏；交付前仍应打开真实文件。

HTML、SSE、`partial_image_b64`、空 data、多图结果或没有最终载荷的响应都判为失败。没有最终图片就不写成品。

`revised_prompt`、`usage` 及服务端模型信息等额外响应元数据目前不持久化；报告模型时只能说“请求/配置的模型”，不要把它当成服务端已确认的实际模型快照。需要审计完整元数据时应另行明确扩展接口，不开启原始响应日志来排障。

## 网络与数据处理

- 可访问用户明确配置的第三方兼容服务；提示和参考图会发送到该服务，不能声称它们必定只到 OpenAI。
- API 根地址按用户提供的路径使用；不猜测 `/v1`，也不允许 URL 中带用户名、密码、查询参数或片段。
- 认证请求和图片下载都不跟随重定向。若服务需要重定向，先让用户提供最终受信任地址，不放开自动转发认证。
- 不枚举环境变量；仅读取 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_IMAGE_MODEL`。不加载 `.env`、不调用 Codex、不扫描用户会话或认证目录。
- 不自动重试，不切换模型或服务。超时覆盖请求和下载，但不撤销服务端已经受理的生成任务。
- 对远端错误仅报告 HTTP 状态与本地安全解释；远端可能回显 Key，所以不原样输出错误体、headers、网络异常或 stack。
- 没有 `--force`；最终写入使用排他创建。若 API 已成功但本地保存失败，说明可能已计费，不能直接重新调用当作免费补救。

## 常见问题

- **缺少 Key**：让用户在系统环境变量中自行设置 `OPENAI_API_KEY`，重启宿主应用后再离线检查。不向聊天粘贴 Key。
- **401/403**：检查 Key 是否属于当前服务，以及图像模型/项目权限；不自动尝试另一组凭据。
- **404**：核对 base URL 是否为正确 API 根路径、模型是否真实存在及服务是否提供 Images API。
- **400**：检查该模型是否支持 `output_format`、当前尺寸、质量和编辑功能。兼容接口并不代表支持所有 GPT Image 字段。
- **429**：可能是限流或额度问题；查看服务后台，不自动重试。
- **网络/超时**：确认服务端可能已经计费。先检查服务后台或人工决定是否重试。
- **URL 下载失败**：可能是签名过期、重定向或 CDN 不可达。不要把失败的下载当成从未生成，也不要把 API Key 添加到下载地址。
- **扩展名改变**：服务没有遵守请求格式；脚本使用实际格式扩展名而不伪装文件或自动转码。

## 官方参考

- [OpenAI 图像生成指南](https://developers.openai.com/api/docs/guides/image-generation?generate-images-api=responses)
- [Images API：生成](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Images API：编辑](https://developers.openai.com/api/reference/resources/images/methods/edit)

接口支持随模型和服务变化，以目标服务最新文档为准。这些链接不构成对 `gpt-image-2.5` 简写在官方服务可用性的保证。
