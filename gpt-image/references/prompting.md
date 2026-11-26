# GPT Image 提示词指南

整理自 OpenAI 官方 Image prompting guide（GPT-Image-2.6 / 2.5）。各模型通用。

## 目录
1. 基本原则
2. 生成类任务模板
3. 编辑类任务模板
4. 多轮迭代与角色一致性
5. 参数与提示词的分工
6. 结果检查清单

## 1. 基本原则

1. **先说结果和用途**：主体 + 用途（产品照、广告、示意图、App 界面……）+ 构图 / 画幅 / 关键位置约束。复杂需求用带标签的分段写：Scene / Subject / Details / Constraints。
2. **格式不重要，清楚才重要**：短句、段落、列表、类 JSON 都可以，选最方便阅读和修改的写法，不要依赖特殊语法。
3. **描述看得见的细节**：材质、光线、颜色、媒介。要写实就明确写 "photorealistic" / "real photograph"，并说明景别和质感；相机参数只是外观提示，不保证物理精确。夜景、雨天、霓虹等场景要写清尺度、氛围和颜色，不能只靠"氛围感"这类词。
4. **人物和动作要具体**：景别（"full body visible, feet included"）、相对大小、视线（"looking down at the open book"）、与物体的交互（"hands naturally gripping the handlebars"）。
5. **文字要精确**：要出现的文字放在引号里，说明位置、字体风格、出现几次（"Render the tagline exactly once"）；生僻词或品牌名可以逐字母拼出；加上 "No extra text, no watermarks"。小字或密集文字用 `medium`/`high` 及以上质量。中文文字同样用引号括起来。
6. **改什么和不改什么分开写**：编辑时写 "change only X"，再列出要保留的内容（身份、几何形状、布局、光线、标签……），以及不要出现的东西（多余文字、logo、水印）。
7. **给参考图分配角色**：按编号说明每张图的作用（主体 / 风格 / 服装 / 背景），以及怎么组合（"Place the dog from the second image into image 1, next to the woman"）。
8. **逐步迭代**：把上一张输出作为下一次的输入，每次只提一个改动，并重复关键的保留约束。

## 2. 生成类任务模板

**写实摄影**
```text
Create a photorealistic candid photograph of <subject + action>.
<visible details: skin texture, materials, wear>.
Shot like a 35mm film photograph, medium close-up at eye level, 50mm lens.
Soft <light>, shallow depth of field, subtle film grain, natural color balance.
The image should feel honest and unposed. No glamorization, no heavy retouching.
```

**带文字的广告 / 海报**
```text
Create a <style> ad for a brand called <Brand>. <audience and feel>.
The ad shows <scene> with the tagline "<exact text>".
Render the tagline exactly once, clearly and legibly, integrated into the layout.
No extra text, no watermarks, no unrelated logos.
```

**Logo（位图或 SVG）**
```text
Create an original, non-infringing logo for <Company>, a <business>.
Warm, simple, timeless. Clean vector-like shapes, strong silhouette, balanced negative space.
Favor simplicity over detail so it reads clearly at small and large sizes. Flat design, minimal strokes.
Fully transparent background. A single centered logo with generous padding, no backdrop, checkerboard, or watermark.
```
位图 logo 用 `--background transparent -f png`；可编辑的矢量 logo 用 `-f svg`（仅 2.6）。

**信息图 / 教学图 / 幻灯片 / 图表**：按"交付物规格"来写：说明交付物类型、画布和层级，直接给出真实的文字和数据，描述视觉风格，并加上实际约束（易读字号、留白、不要装饰性杂物、不要图库照片感）。横版幻灯片用 `1536x864` 之类的尺寸，有小字时用 `-q high`。生成后核对每个数字和标签。

**App / 网页界面预览**：把产品当作已经上线来描述（"Create a realistic mobile app UI mockup for …"），写清布局、层级、间距和真实的界面元素，避免 concept art 一类的说法；需要的话加 "Place the UI in an iPhone frame"。

**漫画 / 分镜**：每格一个清晰的视觉节拍，"Panel 1: … Panel 2: …"，描述具体动作。

**历史 / 真实场景**：直接给出地点和日期，例如 "Bethel, New York on August 16, 1969"，生成后检查服装和环境是否符合时代。

**GIF 动图（2.6）**：描述主体、动作和循环方式，让主体回到起始姿态，说明镜头是否移动：
```text
<subject> in <scene>. <subject> slowly <action>, then returns to its starting pose.
Keep the camera still. Make the motion loop smoothly.
```

## 3. 编辑类任务模板

**去除物体**：`Remove the <object> from <location>. Do not change anything else.`

**替换物体 / 家具**：
```text
In this photo, replace ONLY the <object> with <new object>.
Preserve camera angle, lighting, floor shadows, and surrounding objects.
Keep all other aspects of the image unchanged.
```

**换装 / 保留人物身份**：
```text
Edit the image to dress the person using the provided clothing images.
Do not change their face, facial features, skin tone, body shape, pose, or identity.
Replace only the clothing, fitted naturally with realistic fabric behavior.
Match lighting, shadows, and color temperature. Do not change the background or framing; no text, logos, or watermarks.
```

**合成多张参考图**：`Place the <element> from the second image into image 1, <where>. Use the same lighting and style. Do not change anything else.` 不要用 "combine" / "merge" 这类笼统的词，要写成 "edit the first image by adding … from the second image"。

**风格迁移**：`Use the same style from the input image and generate <new subject> on <background>.`

**透明抠图**：
```text
Extract the product from the input image and isolate it on a fully transparent background.
Centered product, crisp silhouette, no halos or fringing. Preserve geometry and label legibility exactly.
Do not add a backdrop, checkerboard, scenery, or shadow.
```
同时加上 `--background transparent -f png`。画出来的棋盘格不是真正的透明。

**草图转写实**：`Turn this drawing into a photorealistic image. Preserve the exact layout, proportions, and perspective. Choose realistic materials and lighting. Do not add new elements or text.`

**翻译图中文字并保留排版**：`Translate the text in the infographic to <language>. Do not change any other aspect of the image.` 生成后检查有没有漏翻的文字。

**markup 圈注编辑**：`Recolor the <object> inside the red circle to <…>. Keep <…> unchanged. Remove the red circle from the finished image.`

**mask 局部重绘**：提示词描述**整张图编辑后的样子**（例如 "A sunlit lounge with a pool containing a flamingo"），或者明确写出要在透明区域里做什么。

## 4. 多轮迭代与角色一致性

- 第一张图满意后，把它作为下一次的 `-i` 输入（或用 `respond --continue`），每次只改一个条件，例如 "Make it look like a winter evening with snowfall."
- 多张插画要保持同一个角色：第一张先建立角色设定（外貌、比例、服装、性格、风格、约束），之后每张都附上这张角色图，并重复写出角色的关键特征（"Same green hooded tunic, same facial features, proportions, and color palette. Do not redesign the character."）。
- 连续编辑会累积偏差：每一步都重复要保留的约束；需要像素级保持不变的区域，最后用原图合成回去，而不是依赖提示词。

## 5. 参数与提示词的分工

- 尺寸、质量、背景、格式用 API 参数控制，提示词里描述画面内容。提示词中的 "4K" 不会改变实际输出尺寸。
- `quality` 决定能渲染多少细节（纹理、小字）；`complexity`（仅 2.6）决定动笔之前规划得有多充分。排版出错时先调 complexity，排版正确但小字看不清时再调 quality。每次只调一个。
- 做局部小改时，`--complexity low` 往往更稳，周围内容不容易被一起改掉。
- 草稿先用 `low` 确定方向，定稿再提高质量；`xhigh` / `max` 只在确实能补上某个质量缺陷时使用。

## 6. 结果检查清单

- 每个字都能看清，并且和要求一致吗？图表的标签和关系对吗？
- 人物身份、产品形状、标签和参考图中的细节保留下来了吗？
- 编辑是否只改了要求的部分？
- 要求透明时，文件真的有透明像素吗（而不是画了一块背景）？
