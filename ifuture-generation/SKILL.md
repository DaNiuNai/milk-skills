---
name: ifuture-generation
description: >
  使用无限画布（iFuture）文件生成 API 创建图片、视频和音频，上传参考文件、查询报价、跟踪或取消异步任务并下载结果。当用户指定无限画布、iFuture、api.i-future.net，或要求对接该服务的生成工作流时使用。支持 Node.js JavaScript 脚本；不用于操作网页画布或调用其他供应商的独立 API。
---

# 无限画布文件生成

使用 Node.js 24 原生 `fetch`、`FormData`、文件 Blob 和流式下载，无 npm 依赖。生成任务独立运行，无需创建画布或节点，与网站共用积分和个人存储。

## 使用边界与配置

- 按用户请求确定生成类型、内容、参考文件、数量和输出位置；有歧义先询问。用户只要接入代码或接口说明时，不提交真实生成任务。
- 当前任务已经授权使用无限画布及相应费用时直接继续，不重复征求许可。不因密钥存在扩大到额外生成、重新生成、取消任务或上传无关材料；没有发送和计费授权时先澄清。
- 保留用户指定的提示、模型、模式和参考文件顺序。不要擅自切换服务、模型或增加生成次数。
- 唯一凭据变量为 `IFUTURE_API_KEY`，由脚本读取；不加载 `.env`，不支持命令行传 Key。不要回显、搜索凭据文件或让用户在聊天中粘贴真实 Key。Key 在[控制台](https://dashboard.i-future.net/api-keys)创建；当前进程看不到已配置变量时，需完全重启宿主应用以刷新环境。
- API 固定为 `https://api.i-future.net/v1/ai/generation`，没有额外 `/api`。OSS 及签名下载不带 Key。上传会占用个人存储，创建任务会扣积分。

确定本 skill 安装目录的绝对路径，下文 `<skill目录>` 指该目录；调用脚本使用绝对路径，输出写入用户项目的任务目录，不写进 skill 目录。

```powershell
node "<skill目录>/scripts/generate.mjs" check-config
```

此命令不联网，仅返回固定 API 地址及 `apiKeyConfigured` 布尔值。下面所有命令均可加 `--dry-run` 离线预览：不读 Key、不联网、不写文件；它不能证明模型、余额或凭据可用。

## 查询契约，准备参考文件

先查询目标类型的可用模型并实际阅读结果，不能直接选第一个模型。用户未指定模型时，依据其要求和返回的能力选择；多种选择有实质差异且无法确定时询问。

```powershell
node "<skill目录>/scripts/generate.mjs" models --kind image --out "./outputs/ifuture/models.json"
```

`--kind` 为 `image`、`video` 或 `audio`，省略则查询全部。生成的 `modelConfigId` 使用返回的 `id`，`profileKey` 原样使用；供应商的 `model` 不能当作配置 ID。读取所选模式的 `inputGroups`、`promptRequired`、`promptMaxLength`、`parameterSchema` 与默认参数，按契约准备参数 JSON。跨字段关系仍以服务端校验为准。

需要本地参考文件时执行：

```powershell
node "<skill目录>/scripts/generate.mjs" upload --file "./reference.png" --state "./outputs/ifuture/reference-upload.json" --out "./outputs/ifuture/reference-asset.json"
```

脚本按扩展名确定 MIME，并检查实际大小；服务端还会校验真实内容。它申请上传，将 `objectId` 和签名表单持久化到 `--state`，随后向 OSS 直传并确认。生成输入必须使用确认响应的 **`id`**：

```json
[{ "assetId": "确认响应的id", "groupKey": "所选模式的分组key" }]
```

将数组保存为 `inputs.json`。也可复用该账号的上传文件或生成结果；使用 `files` 查找：

```powershell
node "<skill目录>/scripts/generate.mjs" files --kind image --query "reference" --limit 24 --out "./outputs/ifuture/files.json"
```

需要下一页时传上次结果的 `nextCursor` 给 `--cursor`；为 `null` 即结束。不要自动遍历无关文件。`acceptedInputKinds`、`maxCountByKind` 及文件内容限制要结合文件元数据检查；脚本只校验分组和总数，不能证明素材符合模型全部要求。

## 保存请求、报价与提交

将提示保存为 UTF-8 `prompt.txt`，将模型参数保存为 JSON 对象 `parameters.json`。复杂引号、多行和 PowerShell 特殊字符优先使用文件；文件开头 BOM 会移除，正文和末尾换行保留。参数文件可省略以使用所选模式默认值。

```powershell
node "<skill目录>/scripts/generate.mjs" prepare --models "./outputs/ifuture/models.json" --model "查询返回的配置ID" --prompt-file "./prompt.txt" --parameters "./parameters.json" --out "./outputs/ifuture/request.json"
```

可加 `--mode` 指定模式，省略使用模型声明的默认模式；有参考文件时加 `--inputs "./inputs.json"`。短提示可用 `--prompt` 替代文件。普通模式按模型默认值 → 模式默认值 → 用户参数合并。`layer-decomposition`、`finalize-draft` 仅使用用户参数，不混入普通模式默认值；这些特殊模式以及 GIF、SVG、标注编辑、视频首尾帧、语音合成的约束见 [API 参考](references/api.md#模型和特殊模式)。

`prepare` **只在本地创建完整请求与 UUID，不联网**。输出不覆盖已有文件，真实生成前阅读该请求确认内容。

```powershell
node "<skill目录>/scripts/generate.mjs" quote --kind image --request "./outputs/ifuture/request.json" --out "./outputs/ifuture/quote.json"
node "<skill目录>/scripts/generate.mjs" create --kind image --request "./outputs/ifuture/request.json" --out "./outputs/ifuture/accepted.json"
```

视频和音频使用相同流程，将 `--kind` 改为对应类型，并使用该类型的模型和参数；语音合成的提示是朗读正文。

- 报价自动移除 `clientRequestId`，不创建任务、不扣费、不锁价。积分均保留十进制字符串；需要计算时用 `BigInt`，不能用 `Number`。余额为正时费用仍可超过余额，实际以 `task.billing.charged` 为准。
- `create` 只提交已保存文件，重试复用相同 UUID 和原内容。未收到响应时保留原文件，原样重试 `create`；不要再次 `prepare`。同号异内容会返回 409。
- HTTP 202 只是受理。保存 `task.id`；若响应文件保存失败，stderr 仍输出 `taskId`，优先查询已有任务。
- 用户要求一次新的生成（包括失败或取消后的新尝试）才创建新请求文件和 UUID；不自动发起新的收费任务。

## 跟踪任务与交付结果

```powershell
node "<skill目录>/scripts/generate.mjs" wait --id "任务ID" --out "./outputs/ifuture/task.json"
node "<skill目录>/scripts/generate.mjs" download-task --id "任务ID" --out-dir "./outputs/ifuture/results"
```

默认每 3 秒查询，最多等待 1800 秒。`--interval-sec` 允许 2–5 秒，`--max-wait-sec` 调整本地等待上限。`--out` 保存最新状态；本次命令创建的快照文件会更新，其他已有文件不覆盖。失败或取消同样保存 `failure`、`warnings`、`billing` 并停止轮询。超时或中断不会取消服务端任务，使用原任务 ID 与新的快照文件续查。

`download-task` 下载按顺序返回的全部主结果，保存 `task.json`；用户需要末帧等辅助文件时加 `--include-auxiliary`。每次下载刷新签名 URL，不附 Key，流式写盘。文件冲突即停止；下载中断或部分失败时，读取已保存的 `task.json`，仅补下载缺失的 `assetId`：

```powershell
node "<skill目录>/scripts/generate.mjs" download --asset-id "文件ID" --out "./outputs/ifuture/missing.png"
```

下载失败不应重新生成。需要单次查询、刷新 URL 或主动取消时：

```powershell
node "<skill目录>/scripts/generate.mjs" task --id "任务ID"
node "<skill目录>/scripts/generate.mjs" download-url --asset-id "文件ID" --attachment
node "<skill目录>/scripts/generate.mjs" cancel-task --id "任务ID"
```

主动取消不自动退款，也不保证供应商立即停止；检查返回的 `task.status`，不要把取消请求受理当作取消成功。失败退款以 `billing.refunded` 为准。

交付实际文件的可点击路径和对应任务 ID，说明终态、成功任务的警告以及与用户相关的费用。具备图片、音视频预览能力时检查实际结果；未检查媒体内容时不要声称已验收。上传状态与任务响应可能包含临时签名 URL，应留在任务输出目录，不提交到仓库。

## 恢复与错误处理

上传失败时检查 `--state` 文件：有 `reservation.objectId` 才能确认或取消；申请阶段未收到响应且没有对象 ID 时，不盲目重复申请，因为申请不支持请求号幂等，可让服务端按有效期清理预占资源。OSS 已接收但确认中断时先重试确认：

```powershell
node "<skill目录>/scripts/generate.mjs" finalize-upload --object-id "上传对象ID"
node "<skill目录>/scripts/generate.mjs" cancel-upload --object-id "上传对象ID"
```

只在用户放弃未确认上传时调用取消；它不会删除已确认文件。申请签名 10 分钟有效，15 分钟内完成确认。超过有效期或服务明确判定上传失效后才重新申请。

网络请求默认每次尝试限时 60 秒（包括响应读取），可通过 `--timeout-sec` 调整至 `(0, 3600]`。幂等接口的临时网络错误、408、429、5xx 最多额外重试 2 次（`--max-retries 0..5`）；遵守 `Retry-After`，需等待超过 60 秒则停止。创建任务始终复用原始请求内容。上传申请和 OSS POST 不自动重试。400、401、402、403、404、409 不原样自动重试。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功、帮助、配置检查或离线预览 |
| 1 / 2 / 3 | 内部错误 / 参数错误 / 本地凭据不可用 |
| 4 / 5 / 6 | HTTP API 错误 / 网络或文件传输失败 / 响应结构错误 |
| 7 / 8 | 输入文件读取失败 / 输出冲突或保存失败 |
| 9 | 任务失败、取消，或下载时任务尚未成功 |
| 10 | 客户端等待超时，原任务仍可续查 |

按实际 HTTP 及业务说明处理：401 检查 Key；402 补充至正余额；403 停止请求并联系管理员；404 检查配置启用状态及资源归属；409 区分同号异内容、存储额度、上传失效和并发变化。完整协议及上传类型表按需阅读 [API 参考](references/api.md)。

运行 `node "<skill目录>/scripts/generate.mjs" --help` 查看命令，`node --test "<skill目录>/tests/generation.test.mjs"` 运行离线模拟测试；测试不读取真实 Key，也不产生生成费用。
