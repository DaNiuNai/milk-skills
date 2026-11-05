# 无限画布文件生成 API 参考

依据用户提供的 `C:\Users\milk\workspace\ifuture-workspace\docs\api\无限画布文件生成API对接.md` 整理，快照日期为 2026-11-05。模型、模式、参数以实时 `/models` 为准；此文件保留调用协议和容易混淆的约束，不提供固定可用模型清单。

## 请求与端点

API 根地址为 `https://api.i-future.net/v1/ai/generation`。API 使用 `x-api-key`；JSON 请求加 `Content-Type: application/json`，没有请求体的 POST 不必发送 `{}`。不传 `userId`、`ownerUserId` 或画布 `context`，Key 所属账号决定任务、文件、存储和积分归属。Cookie 不能替代 Key。

| 方法 | 相对路径 | CLI |
| --- | --- | --- |
| GET | `/models?kind=image` | `models`，kind 可省略或为 video/audio |
| POST | `/{image,video,audio}/quote` | `quote --kind ...` |
| POST | `/{image,video,audio}` | `create --kind ...` |
| GET | `/tasks/{taskId}` | `task`、`wait` |
| POST | `/tasks/{taskId}/cancel` | `cancel-task` |
| GET | `/files` | `files` |
| POST | `/file-uploads` | `upload` 的申请步骤 |
| POST | `/file-uploads/{objectId}/finalize` | `finalize-upload` |
| POST | `/file-uploads/{objectId}/cancel` | `cancel-upload` |
| GET | `/files/{assetId}/download-url` | `download-url`、`download` |

创建成功 HTTP 202，其他成功 HTTP 200。所有 API 响应禁止缓存；时间为 ISO 8601。错误可能是 `{code,message}`、`{success:false,error:{issues:[]}}` 或纯文本，不能假定统一 JSON 错误包。

## 模型和特殊模式

`GET /models` 返回 `{items:[...]}`，配置包含 `id`、`name`、供应商 `model`、`outputKind`、`adapterKey`、`capabilityProfile`、`profileKey`、`defaultModeKey`、`modes`、`defaultParameters`、`parameterSchema`、`maxInputCount`、`acceptedInputKinds`。

每个模式包含 `key`、`label`、`description`、`promptRequired`、`inputGroups`，可能还有 `promptMaxLength`、`defaultParameters`。每个输入组包含 `key`、`acceptedInputKinds`、`minCount`、`maxCount`，部分还有 `maxCountByKind`。按所选模式判断，不以模型级数量和类型概览替代。JSON Schema 不是跨字段关系及媒体内容的完整校验器。

普通模式参数按模型默认 → 模式默认 → 用户覆盖合并；以下两种模式使用独立参数：

- **Seedream 图层拆分**：选择实际提供 `layer-decomposition` 的图片模型，1 张 `reference` 图片；无需文字仍传 `prompt: ""`。仅用 `layerSize`、`promptOptimization`、`outputFormat`、`watermark`，不混入 `imageSize` 等普通字段。
- **Seedance 2.5 样片转正式**：`profileKey: "volcengine-seedance/seedance-2.5"`、`modeKey: "finalize-draft"`，使用 `/video`。`parameters.sourceTaskId` 指向当前账号创建未满 7 天、同配置、已成功且原请求为 `draft:true` 的样片。可选 `resolution`（固定 `1080p`）、`outputFormat`（`mp4`/`mov`）、`watermark`、`returnLastFrame`。提示为空或省略，文件为空或省略，不传普通视频字段。转正式是新收费任务，使用新 UUID，可先报价。

其他条件能力，仅在对应档案出现在实时模型列表中时使用：

- **GPT Image 2.6**：`openai-images/gpt-image-2.6-flare`、`openai-images/gpt-image-2.6-sunburst` 以及相应 `openrouter-images/` 档案支持 `complexity: low|medium|high`，文档默认 `high`，质量档位沿用 2.5，以实时 schema 为准。
- **OpenAI 渠道 GIF**：`default` 模式，`outputFormat: gif`，`frameCount` 2–16（默认 9），`frameDurationMs` 20–2000（默认 200，供应商按 10 ms 取整）。多帧优先自动尺寸，仍受总像素预算及预览权限限制。
- **OpenAI 渠道 SVG**：`default` 模式，`outputFormat: svg`；有权限才使用 `svgModel` 和可选 `svgReasoningEffort`。推理用量与图片用量分开保存。
- **GIF/SVG 共同约束**：只支持文生图，`inputs` 必须为空，不接受 `outputCompression`。透明背景使用 PNG/WebP。
- **OpenAI 渠道标注编辑**：`markup-edit` 模式，`reference` 组 1–16 张图，`markup` 组 1 张含透明像素的 PNG，与首张参考图方向及尺寸一致。提示描述标注区域修改，输出仅 PNG/JPEG/WebP。
- **OpenRouter 渠道**：文档所述图像端点仅开放 PNG/JPEG/WebP，尚不接受上述 GIF/SVG/标注编辑参数。复杂度由服务的渠道适配器透传，不自行把供应商内部 `provider.options` 填入生成参数。
- **MiniMax 视频**：文生视频须具体宽高比；首帧、尾帧、首尾帧使用 `ratio: adaptive`，提供相应图片分组。分辨率、时长和字段大小写依档案，不能跨模型复用。
- **语音合成**：`text-to-speech`，提示是朗读正文，不接受参考文件。`parameters:{}` 使用默认音色，可用字段可能含 `voice`、`instruction`、`language`、`rate`、`volume`、`pitch`、`outputFormat`、`sampleRate`，按 schema 和音色的语言、表现力限制填写。

## 生成请求、报价和幂等

```json
{
  "modelConfigId": "实时模型配置id",
  "clientRequestId": "00000000-0000-4000-8000-000000000001",
  "input": {
    "profileKey": "实时模型profileKey",
    "modeKey": "实时模式key",
    "prompt": "用户提示或朗读正文",
    "parameters": {},
    "inputs": [{"assetId": "确认文件id", "groupKey": "模式分组key"}]
  }
}
```

`modelConfigId`、`assetId` 最长 128，`modeKey`、`groupKey` 最长 100，提示全局上限 100000 且另受模式限制。`inputs` 最多 64，默认 `[]`，按数组顺序处理；不接受外部 URL、OSS 路径和 Base64。

报价 body 只有 `modelConfigId` 和完整 `input`，不含 `clientRequestId`、`context`。响应 `{cost:"100",creditBalance:"1000"}`。不扣积分也不锁价，创建时余额大于 0 即可全额扣费，余额可变负。

创建前持久化完整 body。UUID 幂等在同账号内跨 Key 和网站调用共用：同号同内容返回原任务，不重复扣费；同号异内容返回 409。网络不确定时重用原号原内容；失败、取消或成功后明确要新生成才换 UUID。积分最小单位使用十进制字符串，计算 `BigInt(charged) - BigInt(refunded)`。

## 任务响应

创建和查询返回 `{task:{...},creditBalance:"..."}`；创建独立任务另有 `boardUpdatedAt:null`。任务包含：

- `id`、`modeKey`、`status`、`outputKind`；`createdAt`、`startedAt`、`completedAt`，未发生时间为 `null`。
- `outputAssets` 按顺序排列的主文件；`auxiliaryAssets` 如视频末帧；可能有多个主文件。
- `warnings` 即使成功也可能存在，项含 `position`、`code`、`message`、`source`。
- `failure` 含 `code`、`message`、`source`；非失败时为 `null`。
- `billing:{charged:"...",refunded:"..."}`，净扣费是两者差值。失败来源为 `provider`、`user`、`platform`、`unknown`；文档说当前供应商原因可退款，实际以 `refunded` 为准。

`queued/running` 继续查询，`succeeded/failed/cancelled` 为终态。失败查询仍是 HTTP 200。取消无请求体；仅影响排队和运行中任务，结束时返回原状态，可重复但要检查实际状态。不撤销成功结果，主动取消不自动退款，停止轮询也不会取消任务。

## 上传与恢复

申请 body：`{kind,originalFileName,contentType,extension,fileSizeBytes}`。文件名去首尾空白后 1–255 字符；扩展名不带点且匹配 MIME，大小为实际正字节数。

| kind | 上限 | MIME 与扩展名 |
| --- | --- | --- |
| image | 30 MiB | image/jpeg: jpg/jpeg；image/png: png；image/webp: webp；image/gif: gif；image/bmp: bmp；image/tiff: tif/tiff；image/heic: heic；image/heif: heif |
| audio | 50 MiB | audio/mpeg: mp3；audio/wav 或 audio/x-wav: wav；audio/mp4 或 audio/x-m4a: m4a；audio/ogg: ogg |
| video | 500 MiB | video/mp4: mp4；video/webm: webm；video/quicktime: mov |

1 MiB = 1048576 字节。脚本采用表中的首选 MIME。上传成功不等于符合具体模型对尺寸、时长、格式、大小或文件组的更严格限制。

申请返回 `objectId`、`uploadExpiresAt`、`finalizeExpiresAt`、`upload:{url,fields}`。OSS 上传为 multipart POST：原样加入 fields 全部字段，最后加名为 `file` 的文件，由客户端生成 boundary；不带 API Key，任何 HTTP 2xx 都成功，响应不必是 JSON。签名 10 分钟有效，申请后 15 分钟内确认。

申请预占存储，每账号最多 200 个未确认/待清理对象。上传申请没有客户端幂等号，不自动重试；网络中断且没有 objectId 时不要盲目反复申请。已取得 objectId 时保留状态文件供恢复，不能用该 ID 作为生成参考文件。

`finalize` 使用 objectId，返回已确认文件对象，`id` 才是 assetId。已确认可重复确认；临时 OSS 故障可重试。明确过期、缺失、大小或类型不匹配时服务端申请清理，需重新申请上传。`cancel` 返回 `{cancelled:true|false}`，重复取消或已确认可能为 false；不会删除已确认文件，待清理对象实际清理前仍占容量。

## 文件与下载

文件对象通用于生成结果、上传确认、文件列表，包含 `id`、`kind`、`origin`（upload/generated）、`originalFileName`、`contentType`、`fileSizeBytes`、`fileMetadata`（可能为 null）、`downloadUrl`、`downloadUrlExpiresAt`、`createdAt`；还可能含网站使用的引用计数和 `deletable`。

签名下载 URL 默认 1 小时过期，不附 Key。刷新接口返回 `{downloadUrl,downloadUrlExpiresAt}`；附件参数只支持 `attachment=1`，普通读取省略。保存稳定 assetId，过期不必重新生成。

文件列表参数 `kind` 可选；`query` 去首尾空白后最长 100；`limit` 1–50，默认 24；`cursor` 第一页省略，后续用 `nextCursor`。返回 `{items,nextCursor}`，末页游标为 null，按创建时间倒序，包括当前账号通过网站/API 上传和生成的可用文件。管理员也不能用这些接口跨账号访问。

## HTTP 错误

| 状态 | 常见原因 |
| --- | --- |
| 400 | JSON、未知字段、档案、模式、参数、参考文件不合法 |
| 401 | API_KEY_REQUIRED / API_KEY_INVALID；缺少、失效、过期 Key 或所属用户不存在 |
| 402 | 创建收费任务时余额非正，需要补充至正余额 |
| 403 | USER_BANNED；账号仍被封禁 |
| 404 | 模型不存在/禁用；资源不存在或不属于当前账号 |
| 409 | 请求号内容冲突、存储不足、待处理上传过多、上传失效、并发变化 |
| 5xx | 服务端/外部服务异常；有限退避，创建始终使用原请求 |

不要将模型失败（任务 failure）套入创建接口 HTTP 错误逻辑。无论下载、保存、轮询哪一步失败，均先恢复原任务和文件，不能以重新生成替代恢复。
