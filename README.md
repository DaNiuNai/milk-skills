# skills

## deepseek-web-search

通过 **DeepSeek Search / Fetch API** 搜索公开网页、查找实时资料，或将单个网页抓取为 Markdown。使用 Node.js 22+ 原生 `fetch`，无需安装 npm 依赖。

### 安装与配置

```bash
pnpm dlx skills add https://github.com/DaNiuNai/skills --skill deepseek-web-search
```

在本机配置 `DEEPSEEK_API_KEY` 后，完全退出并重新启动承载 Agent 的终端、编辑器或应用。仅重开会话不一定会刷新父进程继承的环境；“当前进程未获取到变量”不代表系统中没有配置。密钥仅由脚本内部用于官方接口鉴权，不加载 `.env`、不回显密钥、不支持命令行传密钥。请求固定发往 `https://api.deepseek.com`，可能按次计费。

### 使用

可向 Agent 提出：“使用 DeepSeek 搜索 Node.js 官方测试运行器文档，列出来源”，或从本仓库运行：

```bash
node deepseek-web-search/scripts/web.js search --query "Node.js test runner site:nodejs.org" --count 3
```

```bash
node deepseek-web-search/scripts/web.js fetch --url "https://nodejs.org/api/test.html" --format markdown --out "./node-test.md"
```

默认输出完整 JSON；可选 Markdown 或保存为 UTF-8 文件，不覆盖现有文件。`--dry-run` 可离线预览请求，不读取密钥、不联网。支持文档中的全部 Search 参数及搜索语法；仅对 408、429、5xx 做有限退避重试，`--max-retries 0` 可禁用。

完整流程、参数、来源核验与错误处理见 [deepseek-web-search/SKILL.md](deepseek-web-search/SKILL.md)。

### 离线测试

仅使用虚构密钥与本地模拟接口，不产生 API 费用：

```bash
node --test deepseek-web-search/tests/web.test.js
```

## openai-image

通过 **OpenAI Images API 或 OpenAI 兼容服务**生成和编辑图片，支持文生图、单张/多张参考图编辑，以及 PNG、JPEG、WebP 输出。使用原生 Node.js，无额外 npm 依赖。

与下方 `gpt-image-2` 的区别：本 skill 使用自己的 API Key，可能按请求计费，**不使用 ChatGPT 订阅或 Codex 登录**。

### 安装

```bash
pnpm dlx skills add https://github.com/DaNiuNai/skills --skill openai-image
```

### 配置

需要 Node.js 22+。在本机自行设置以下环境变量，再启动使用 skill 的应用；不要把真实密钥发到聊天或写进仓库：

| 环境变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 必需，对应所选 API 服务的密钥 |
| `OPENAI_BASE_URL` | 可选，默认 `https://api.openai.com/v1`；可以指向受信任的兼容服务 API 根地址 |
| `OPENAI_IMAGE_MODEL` | 可选，默认 `gpt-image-2.5`；也可用 `--model` 明确指定 |

不加载 `.env` 文件，不回显密钥。`gpt-image-2.5` 是可配置的默认模型标识，是否可用取决于你的服务；不自动映射到其他模型。

### 使用

可向 Agent 提出：“使用我的 OpenAI 图像 API 生成一张图片，原始提示是……”，或直接从本仓库运行：

```bash
node openai-image/scripts/gen.js --check-config
```

```bash
node openai-image/scripts/gen.js --prompt "一只坐在窗边看雨的橘猫，水彩风格。" --out "./rain-cat.png"
```

```bash
node openai-image/scripts/gen.js --prompt "保留主体，只把背景改成雪山。" --ref "./reference.png" --model "gpt-image-2.5" --out "./edited.webp"
```

使用 `--dry-run` 可以先离线校验参数和参考图，不发送 API 请求。每次调用固定生成一张，不自动重试、不覆盖已有文件。自定义服务会接收提示和参考图，调用前应确认服务与费用范围。

完整参数、错误处理和 JS 库用法见 [openai-image/SKILL.md](openai-image/SKILL.md)。

### 离线测试

测试只访问本地模拟接口，使用虚构密钥，不产生图像 API 费用：

```bash
node --test openai-image/tests/image-gen.test.js
```

## gpt-image-2-skill

### 安装

```bash
npx skills add https://github.com/DaNiuNai/skills --skill gpt-image-2
```

安装完成后，请确保本机已安装并登录 Codex CLI：

1. 检查 `codex` 命令是否可用：

   ```bash
   codex --version
   ```

   如果提示找不到命令，请先安装：

   ```bash
   npm install -g @openai/codex
   ```

2. 确认已登录有 Plus 或 Pro 订阅的 OpenAI 账号：

   ```bash
   codex login status
   ```

   如果未登录，请执行 `codex login` 完成登录。Codex 的图像生成功能需要 Plus 或 Pro 订阅才能使用。

## gpt-image-fragmentation-guard

防止、诊断和恢复 GPT Image 生成中的碎图问题（碎图/破碎、网格、蜂窝、拼贴、分屏、重复肢体、画面接缝、脏噪点、ghosting 等）。通过建立空间连贯性规格、受控细节层级和生成后验收，并在失败时按恢复阶梯从干净状态回退。

### 安装

```bash
npx skills add https://github.com/DaNiuNai/skills --skill gpt-image-fragmentation-guard
```

## sdxl-lora-tag-edit

这个skill专门用于在SDXL模型上训练的LoRA进行标签编辑。