# milk-skills

个人常用的 Agent Skills 合集。

## Skills

| Skill | 说明 |
| --- | --- |
| [deepseek-search](deepseek-search/SKILL.md) | 通过 DeepSeek Search / Fetch API 联网搜索网页并抓取网页正文（零依赖 Node.js 脚本，需设置 `DEEPSEEK_API_KEY`） |
| [gpt-image](gpt-image/SKILL.md) | 使用 OpenAI GPT Image 模型生成和编辑图片（零依赖 Node.js 工具，需 Node ≥ 24.5） |
| [gpt-image-fragmentation-guard](gpt-image-fragmentation-guard/SKILL.md) | 预防、诊断和修复 GPT Image 生成中的碎图问题 |
| [sdxl-lora-tag-edit](sdxl-lora-tag-edit/SKILL.md) | 为 SDXL LoRA 训练数据集编辑标签 |

## 安装

```bash
npx skills add https://github.com/DaNiuNai/milk-skills --skill <skill-name>
```

各 skill 的配置与用法见对应的 `SKILL.md`。

## License

[MIT](LICENSE)
