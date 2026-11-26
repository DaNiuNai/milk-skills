---
name: deepseek-search
description: 通过 DeepSeek Search API 联网搜索网页、通过 DeepSeek Fetch API 抓取网页并转成 Markdown 正文。零依赖 Node.js 脚本，支持 site:/lang:/after:/before:/"精确短语"/排除词等搜索语法、按权威性与相关性打分过滤、批量并行抓取多个 URL、保存全文到文件。只要用户需要查最新信息、新闻、实时数据、版本发布、文档、某个网址的内容，或者说"搜一下""查一下""上网找""联网搜索""看看这个链接/网页写了什么""抓取网页"，或者你自己判断回答需要训练数据之外的最新事实时，都应使用此 skill，即使用户没有提到 DeepSeek。
---

# DeepSeek Search

用 `scripts/deepseek-search.mjs`（Node ≥ 18，无需 npm install）调用 DeepSeek 的 Search 与 Fetch 接口。下文 `$SKILL` 指本 skill 所在目录（SKILL.md 的父目录），命令里换成实际绝对路径。

- API Key 读取环境变量 `DEEPSEEK_API_KEY`（或 `--api-key`）。缺失时脚本会报错，请提醒用户设置，不要自己编造。
- 脚本自动对 408/429/5xx 做指数退避重试；402 表示余额不足，401 表示 Key 无效，直接告诉用户。
- 计费：两个接口各 5 元 / 千次成功请求，按次计费、与 `count` 无关。所以一次搜索取够条数，比反复小搜更划算。

## 搜索

```bash
node $SKILL/scripts/deepseek-search.mjs search "<query>" [-n 10] [-q "<用户原问题>"] [-c] [--brief] [--min-score 1.5] [--json]
```

- 默认输出每条结果的标题、URL、score/authority/日期/站点和 **summary 长摘要**（600～800 字，专为模型阅读设计）。多数问题看 summary 就够，不必再抓取原文。
- `-q/--ori-question`：传入用户的原始问题（≤128 字符），帮助引擎理解意图。query 是关键词化的，ori-question 是自然语言的，两者配合效果最好。
- `-c/--content`：附带网页正文。输出会很长，只在需要深读多篇时用，且建议配合较小的 `-n`。
- `--brief`：只输出 100～200 字的 snippet，适合快速扫一眼有哪些来源。
- 打分含义：`rerank_score` 0～3，≥1.5 为优质；`authority` 0～4（-1 未知），≥3 为极权威。引用事实时优先采用高分高权威来源。

### 搜索语法（写在 query 里，可组合）

| 语法 | 示例 | 作用 |
| --- | --- | --- |
| `site:` | `DeepSeek site:github.com OR site:huggingface.co` | 限定站点，多个用 OR |
| `-site:` | `DeepSeek -site:csdn.net` | 排除站点 |
| `-词` / `-"短语"` | `DeepSeek -广告 -"release notes"` | 排除关键词/短语 |
| `"..."` | `"精确短语"` | 精确匹配 |
| `lang:` | `lang:zh,en` | 限定语言 |
| `after:` / `before:` | `after:2025-01-01 before:2026` | 限定发布时间 |

query 限 1～128 字符。好的 query 是关键词式的（"Node.js 24 新特性 after:2025"），而不是整句提问。用户问"最近""最新"时加 `after:`；需要官方信息时加 `site:` 指向官网/文档站。

## 抓取网页

```bash
node $SKILL/scripts/deepseek-search.mjs fetch <url> [<url2> ...] [--max-chars 20000] [-o <文件或目录>] [--json]
```

- 返回页面标题与 Markdown 正文。多个 URL 会并行抓取，单个失败不影响其它。
- 默认每页最多输出 20000 字符，超出会注明已截断。长文档需要全文时用 `-o` 存到文件再按需读取，避免一次塞满上下文；`--max-chars 0` 不截断。
- 404 通常是页面无可提取正文、被站点拦截或内容类型不支持（如 PDF/图片）；403 是被安全策略拒绝。遇到这类失败换一个来源，别反复重试同一 URL。

## 推荐工作流

1. **先搜**：把用户问题提炼为关键词 query，带上 `-q` 原问题，按需加 `after:`/`site:`。
2. **读摘要**：根据 summary 和分数判断是否已能回答。能答就直接答。
3. **再抓**：summary 不够细（需要具体数据、代码、完整步骤、原文引用）时，挑 1～3 个高分 URL 一次性 `fetch`。
4. **作答并注明来源**：回答中给出所依据的 URL，并说明信息日期；来源之间有冲突时如实指出，不要擅自取舍。

用户直接给了 URL 时跳过搜索，直接 fetch。

## 示例

```bash
# 查最新进展，限定时间
node $SKILL/scripts/deepseek-search.mjs search "DeepSeek V4 发布 after:2026" -n 8 -q "DeepSeek V4 什么时候发布的，有什么新能力"

# 只看官方文档
node $SKILL/scripts/deepseek-search.mjs search "fetch API 速率限制 site:api-docs.deepseek.com"

# 抓取两篇文章，全文另存
node $SKILL/scripts/deepseek-search.mjs fetch https://a.com/post https://b.com/post -o ./pages
```

在 PowerShell 中，含空格或特殊字符（`"`、`-`、`|`）的 query 用单引号包裹整个参数更稳妥，例如 `'DeepSeek -"release notes"'`。
