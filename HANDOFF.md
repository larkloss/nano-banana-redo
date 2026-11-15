# 交接文档（Nano Banana Redo）

写给接手继续开发的工程师或 agent。内容以 `main` 分支 `299a7b5`（2026-11-13，PR #9 合并后）的代码为准，
写于 2026-11-15。标识符、文件名、常量保持英文原样。

- 面向使用者的说明看 [README.md](./README.md)（部分内容已过时，见第 9 节）。
- 部署步骤看 [DEPLOY.md](./DEPLOY.md)。
- 本文讲的是这两份文档没有的东西：代码怎么组织、哪些约定不能破、测试怎么做、还有什么没做完。

---

## 1. 现状

| 项目 | 状态 |
|---|---|
| 线上版本 | `main` = `299a7b5`，PR #1–#9 全部合并并已部署 |
| 开发分支 | `claude/jolly-ride-8g2e2e`，与 `main` 一致，没有未合并的代码改动 |
| 进行中的工作 | 没有。最后一个问题（第 8.1 节）由项目主人决定暂不修改 |
| 仓库内的自动化测试 | **没有**（`package.json` 无 test 脚本）。测试工具在仓库之外，见第 7 节 |

## 2. 这是什么

三个不需要后端的单文件网页应用，全部在浏览器里直接调用模型接口：

| 应用 | 入口 | 单文件产物 | 线上路径 | 作用 |
|---|---|---|---|---|
| 生成器 | `index.html` → `src/main.tsx` → `src/App.tsx` | `nano-banana.html` | `/` | 出图；失败自动重试直到凑够张数；内含修图工作室（Edit Studio） |
| 局部重绘 | `edit.html` → `src/edit/main.tsx` | `nano-banana-edit.html` | `/edit` | 画选区，只重绘选区 |
| 视频 | `video.html` → `src/video/main.tsx` | `nano-banana-video.html` | `/video` | Veo 3.1 文生/图生视频 |

三个单文件既可以双击本地打开（`file://`），也由一个带密码的 Cloudflare Worker（名为 `nano-banana-redo`）托管，
Worker 同时负责在设备间同步 prompt、设置和参考照片。

项目主人主要围绕同一个人物（Abigail Chase）的不同穿着和场景出图、修图。近期开发几乎都集中在生成器里的
**修图工作室**和它的**"only around arrows"本地合成器**上，这也是全仓库最复杂、最容易改坏的部分。

## 3. 协作约定

**和项目主人**

- 主人用中文交流，不读代码。回复用中文、大白话，先说结论；界面文案是英文。
- 流程固定：在开发分支上改 → 主人说"开 PR"才开 PR → 主人自己合并 → 主人让你"确认上线了没"。
  **不要主动开 PR，不要自己合并。**
- 主人用真实 API key 在线上实测，然后贴图反馈。很多问题只能靠他的截图判断，拿不到模型的原始回答。
- 主人明确说过的偏好：
  - 修图时**脸不能动**。全图重绘会让人物的微表情变掉，这正是"only around arrows"存在的原因。
  - 下载的文件不要"虚胖"：按设置里选的格式保存，JPEG 要保住颜色分辨率。
  - 改完的地方边缘不能糊。

**Git**

- 只推 `claude/jolly-ride-8g2e2e`（或主人新指定的分支）。PR 合并后，从最新 `main` 重开同名分支：
  `git fetch origin main && git checkout -B claude/jolly-ride-8g2e2e origin/main`。
- 提交信息、PR、代码注释里不写任何模型标识。
- 仓库没有 PR 模板。

**硬性规则**

- **API key 绝不能离开浏览器**（除了发给模型提供方）：不进同步文件，不进云端。见第 6 节。
- 改了 `src/` 就必须重新构建并提交三个单文件，否则线上还是旧代码。见第 4 节。

## 4. 开发、构建、上线

```bash
npm install
npm run dev            # Vite 开发服务器；/、/edit.html、/video.html
npm run lint           # eslint .
npm run build          # tsc -b && vite build（多页面，输出到 dist/）
npm run build:singles  # 依次构建三个单文件并复制为 nano-banana*.html
```

- 加 `?mock=1` 进入假数据模式，不需要 key（`isMockMode`，`src/lib/mockGemini.ts`、`mockVeo.ts`、`src/edit/lib/mockEdit.ts`）。
- **上线机制**：Cloudflare Workers Builds 监听 `main`。部署时 Worker **不跑 Vite**，
  `wrangler.jsonc` 的 `build.command` 只执行 `scripts/prepare-site.mjs`，把仓库里**已提交的**三个
  `nano-banana*.html` 复制进 `site/`。所以每次改 `src/` 都要 `npm run build:singles` 并把三个 HTML 一起提交。
- 每次 Vite 构建会清空 `dist/`，所以 `build:single*` 每步都立刻 `cp`；不要改成最后统一复制。
- `site/`、`dist/`、`.wrangler`、`.dev.vars` 不入库。
- 本地跑 Worker：`npx wrangler dev`，在 `.dev.vars` 里放 `APP_PASSWORD`（至少 8 位）。没有对应的 npm 脚本。
- `worker/` 有自己的 `worker/tsconfig.json`，`tsc -b` 不检查它，只有 ESLint 覆盖。
- **确认上线**：我工作的云端环境出不了网到 `workers.dev` 和 `api.cloudflare.com`，没法直接打开线上站点。
  我是用 Cloudflare 的 MCP 工具查 Worker 的最近修改时间（`workers_list` / `workers_get_worker`），
  必要时用 `workers_get_worker_code` 在线上代码里找新功能特有的字符串。合并后大约十分钟内完成部署。

**代码风格**

- 无分号、单引号、尾逗号、行宽约 120。仓库**没有** Prettier 配置；要格式化就用
  `npx prettier --no-semi --single-quote --print-width 120`，用默认配置会把文件整体改乱。
- TypeScript `~6.0`：`erasableSyntaxOnly`（不能用 enum、namespace、参数属性）、`verbatimModuleSyntax`
  （类型要用 `import type`）、`noUnusedLocals` / `noUnusedParameters`。
- 所有东西必须能内联进单文件：Worker 一律 `?worker&inline` 导入（`src/lib/localEditClient.ts`、`src/lib/jpegExport.ts`）。
- 技术栈：Vite 8、React 19、Tailwind v4、`vite-plugin-singlefile`、`@google/genai`、`jszip`、`wrangler`。

## 5. 代码地图

```
src/
  App.tsx, main.tsx          生成器外壳
  types.ts                   Settings、GeneratedImage、ParsedResponse …
  lib/
    retryEngine.ts           自动重试引擎 runGeneration
    errors.ts, friendly.ts   结果分类、给用户看的措辞
    models.ts                MODELS 模型表
    gemini.ts openai.ts xai.ts omni.ts   四个调用器（GenerateCaller）
    mentions.ts              @N 引用参考图
    annotate.ts              箭头标记 → 提示词 + 箭头示意图
    frame.ts                 把图垫成模型能回答的形状，再裁回来
    localEdit.ts             本地合成器（1676 行，核心）
    localEditClient.ts, localEdit.worker.ts   合成器的 Worker 封装、与重试引擎的衔接
    flow.ts seamCut.ts imageMath.ts          合成器的数学部件
    imageUtils.ts            上传、导出、下载、文件名
    jpegEncode.ts (+.worker.ts), jpegExport.ts   自写的 4:4:4 JPEG 编码器
    storage.ts refStore.ts   localStorage / IndexedDB
    promptAssembly.ts promptFile.ts          模块化 prompt、同步文件
    cloud.ts                 云同步客户端
    veo.ts videoEngine.ts veoModels.ts       视频
  hooks/                     useRetryRun、useEditStudio、useSettings、usePromptWorkspace、usePromptFileSync …
  components/                run/ settings/ prompt/ gallery/ studio/ cloud/ common/
  edit/                      局部重绘应用（lib/align.ts、blend.ts、mask.ts 也被生成器的合成器复用）
  video/                     视频应用
worker/index.ts, pages.ts    Cloudflare Worker：登录、同步接口、Durable Object
scripts/prepare-site.mjs     部署时把三个单文件复制进 site/
```

### 5.1 生成器与重试引擎

- `runGeneration(call, params, signal, onEvent)`（`src/lib/retryEngine.ts`）：**每个 API key 一条并行通道**，
  共享 `collected / attemptsStarted / attemptsCompleted`。每个提供方最多 3 个 key。
- 一次调用的结果分五类（`src/lib/errors.ts`）：

| 类别 | 判定 | 后果 |
|---|---|---|
| success | 返回了图 | 每张图都计入目标 |
| moderation / empty | 被审核拦截或没有图 | 算一次尝试，继续重试 |
| transient | 429、≥500、`TypeError`、消息含 fetch/network/ECONN | 不占尝试次数，退避后重试；连续第 7 次该通道退出 |
| fatal | 400/401/403/404 或认不出的错误 | 只杀掉该通道 |
| aborted | 用户按了 Stop | 通道以 `stopped` 退出 |

- 常量：`MAX_CONSECUTIVE_TRANSIENT=6`，退避 2 s 起倍增到 60 s。默认目标 5 张、尝试上限 50。
- 模型表 `MODELS`（`src/lib/models.ts`）：

| 提供方 | id |
|---|---|
| Gemini 图片 | `gemini-nano-banana-2.1`（默认）、`gemini-3.1-flash-image`、`gemini-3-pro-image-preview`、`gemini-2.5-flash-image` |
| Gemini 视频 | `gemini-omni-1.1-flash` |
| OpenAI | `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2` |
| xAI | `grok-imagine-image-2.0`、`grok-imagine-image-quality`、`grok-imagine-image` |

- 参考图上限：xAI `MAX_XAI_SOURCES`=3，OpenAI `MAX_OPENAI_SOURCES`=16，Gemini 用 `model.maxReferences`（6 或 14）。
- 存储：设置 `nbr.settings.v1`，key `nbr.apiKey|2|3`、`nbr.xaiApiKey|2|3`、`nbr.openaiApiKey|2|3`（localStorage）；
  参考照片在 IndexedDB `nbr-refs`。**图库里的图只在内存里，刷新就没了。**

### 5.2 Prompt、模块、`@` 引用

- 两种模式：单文本框，或可开关、可排序、带多个"变体"的模块（`usePromptWorkspace`）。
  `assembleModules` 把启用的模块用空行拼起来，模块名不发给模型。
- **`@N`** 指第 N 张参考照片（`src/lib/mentions.ts`，正则 `MENTIONS`，1–99，支持全角 `＠` 和 `@1@2` 连写）。
  各提供方的改写方式：

| 提供方 | 函数 | 做法 |
|---|---|---|
| Gemini | `captionedReferences` | 每张图前插一行 `Reference image N:`，文中 `@N` 改成 `reference image N` |
| OpenAI、xAI | `withNumberedReferences` | 在 prompt 前加一句编号说明，再改写 `@N` |
| Omni | `withOmniTags` | `@N` → `<IMAGE_REF_{N-1}>` |

  没有有效 `@N` 的 prompt 原样发送。修图工作室自己编号（`buildEditPrompt`），并设 `Settings.imagesExplained`
  让提供方不再重复改写。
- 输入 `@` 时弹出的选择器在 `src/components/common/MentionTextarea.tsx`，只在 `PromptPanel` 里启用。
- **文件同步**（`usePromptFileSync`）：把 `{version, updatedAt, workspace, settings}` 写到用户选的 JSON 文件。
  线上有云同步时界面换成 `CloudSection`。

### 5.3 修图工作室（Edit Studio）

入口：图库里任何一张图片的 Edit 按钮，或者**上传自己的图**（选择文件 / 拖入 / 粘贴，`App.uploadPictures`，一批最多 12 张，
第一张自动打开工作室）。

- 状态和流程都在 `src/hooks/useEditStudio.ts`：`EditSession` → 多个 `EditVersion`（可分叉）→ `EditTurn`。
- 用户可以写一段总指令，也可以在图上点最多 6 个带编号的**箭头**（`EditMark`，坐标是 0–1 的比例），每个箭头配一句话。
- `runTurn` 发给模型的图片顺序固定为：**原图、箭头示意图、参考照片**。`buildEditPrompt`（`src/lib/annotate.ts`）
  按这个顺序描述每张图，顺序一变提示词就对不上。
- 开关 **"only around arrows"**（`localOnly`，默认开）：模型的回答不直接采用，而是交给本地合成器，
  只把箭头附近真正改变的部分贴回原图，其余像素保持原图。
- "Take whole picture"：用户可以改为采用模型的整张回答（`takeWholePicture`）。
- 本地合成结果在应用内一直是 PNG；用户选的是 JPG 时只打 `saveAs` 标记，**下载时**才编码一次（`exportBlob`）。

**与重试引擎的衔接**（`makeLocalEditCaller`，`src/lib/localEditClient.ts`）

| 合成器的结论 | 引擎看到的 | 效果 |
|---|---|---|
| 可用 | 一张图（合成结果） | 成功 |
| 普通拒绝（例如箭头附近没变化、画成了另一张图） | 空回答 | 算一次失败，自动重试 |
| `final` 拒绝（回答的形状不对） | 先垫框重发一次；仍不行就抛普通 `Error` | 该通道终止，提示用户关掉 only around arrows |
| Worker 崩溃（`EditorDead`）/ 用户 Stop | 原样抛出 | 终止 / 停止 |

**形状问题（`src/lib/frame.ts`）**

合成要求回答和原图形状完全一致，但模型只会按固定比例出图，上传的图往往不符合。做法：

- `frameShape` 找最近的可用比例，`frameTo` 用镜像内容把图垫到那个形状，`marksInFrame` 换算箭头位置，
  `cropFromFrame` 再把原图范围裁回来。
- 模型的"3:4"实际会偏几个百分点，而且每个模型不一样。所以用模块级的 `learned` 表（键 `modelId|ratio`）
  **从真实回答里学**实际形状，而不是写死表格。它只在本次页面打开期间有效。
- OpenAI 可以直接指定尺寸（`matchSize` → `openaiSizeMatching`），1:3 到 3:1 之间不需要垫框。
- 发送分辨率按像素数选（`localSettings`）：超过 5.5 MP 用 4K，超过 1.6 MP 用 2K，否则 1K。

### 5.4 本地合成器（`src/lib/localEdit.ts`）

**设计原则：输出先画上原图，只有被选中区域内的像素才被改写。区域之外与原图逐位相同。** 这是"脸不动"的保证，
任何改动都不能破坏它。

对外接口：`prepareLocalEdit(source, marks)` → `composeLocalEdit(job, result)` → `LocalComposite`
（`{kind:'ok', blob, mask, info}` 或 `{kind:'reject', reason, final?}`）。调试用 `lastLocalEditStats()`、
`lastLocalEditDebug()`（模块级全局量，只在主线程直接调用时可读）。

`composeLocalEdit` 的步骤：

1. **形状检查**：长宽比偏差超过 `AR_TOLERANCE` → `final` 拒绝。这是唯一的 `final`。
2. **对位**：整体平移（`analyzeResult`，来自 `src/edit/lib/align.ts`）；整体缩放由 `measureZoom` + `fitAxisScale`
   （Theil–Sen）估计，**只有缩放后颜色失配确实下降（`ZOOM_GAIN`）才采用**，因为大面积改动会骗过估计。
3. **稠密位移场**（`blockFlow`、`warpPlanes`，`src/lib/flow.ts`）：只用于检测，**贴回去的像素不做扭曲**。
4. **差异**：模糊后的 Y'CbCr 上取 ±1 px 内的最小差（`tolerantLabDistance`，名字里的 Lab 是历史遗留）。
5. **噪声模型** `a + b·梯度`：全局一份，每个箭头周围再一份，都有上限（`NOISE_A_MAX`、`NOISE_B_MAX`、`LOCAL_NOISE_CAP`）。
6. **`looksUnrelated`**：大部分细节都对不上 → 普通拒绝"画成了另一张图"。
7. **判定每个箭头是否"改到了"**：`strong`（差异 > max(`HIGH_MIN`, `HIGH_K`·噪声)）和 `weak`（`LOW_MIN`/`LOW_K`）。
   箭头尖 `CORE_RADIUS` 内最近的强变化块就是这个箭头的编辑对象；要求质量 ≥ `SEED_FLOOR`，
   并且峰值够高（`SEED_PEAK`）或面积够大（`SEED_PLENTY`）。没有箭头改到 → 普通拒绝。
8. **生长**：从箭头处的强变化出发，连上 `closeR` 以内、或经弱变化相连的其他强变化块（最多 4 跳）；
   弱变化只跟随 `WEAK_REACH`·`closeR` 这么远，更远的淡变化视为模型重绘带来的漂移。
9. **`toneDrift`**：把"只是色调被整体带偏"的部分从编辑里分出去（典型：改头发时脸色被带偏）。
10. **孔洞**：小孔填上（上限 π·`closeR`²），大孔和被剔除的部分保持原图。
11. **接缝**：`optimalSeamRegion`（`src/lib/seamCut.ts`，最小割）在 `must ⊆ 区域 ⊆ may` 之间找代价最低的边界。
12. **融合**（`blendArea`）：贴入层用 `sharpAnswer`（可分离 Lanczos-3）重采样，超过 `SHARP_MAX` 像素才退回
    浏览器插值；`computeCorrection(..., openFrame=true)`（`src/edit/lib/blend.ts`）做颜色校正；
    回答比原图平滑时补颗粒。alpha 从接缝处的 0 平滑升起。
13. **输出**：与原图同尺寸的 PNG，加一张区域蒙版和 `LocalEditInfo`
    （`arrowsChanged`、`coverage`、`reachedLimit`、`widespread`）。

主要常量（尺寸类是"短边的比例"）：

| 常量 | 值 | 含义 |
|---|---|---|
| `WORK_MAX` / `COARSE_MAX` / `CROP_MAX` / `BLEND_MAX` | 768 / 192 / 900 / 256 | 检测、缩放估计、接缝裁块、校正场的工作尺寸（长边） |
| `ZONE_RADIUS` | 0.22 | 箭头周围不参与对位和颜色估计的范围 |
| `CORE_RADIUS` | 0.06 | 变化必须出现在离箭头尖这么近的地方 |
| `CLOSE_RADIUS` | 0.008 | 闭运算半径 `closeR` |
| `WEAK_REACH` | 2 | 弱变化跟随距离（× `closeR`） |
| `FAR_REACH` / `MAX_REACH` | 0.95 / 0.5 | 强变化跟随范围 / 箭头自己噪声模型的作用范围 |
| `FEATHER` / `SEAM_ROOM` | 0.012 / 0.035 | 融合过渡宽度 / 接缝可游走的宽度 |
| `HIGH_MIN`, `HIGH_K` | 14, 5 | 强变化阈值 |
| `LOW_MIN`, `LOW_K` | 7, 3 | 弱变化阈值 |
| `SEED_FLOOR`, `SEED_PEAK`, `SEED_PLENTY` | 16, 12, 0.03 | 箭头"改到了"的判定 |
| `NOISE_A_MAX`, `NOISE_B_MAX`, `LOCAL_NOISE_CAP` | 6, 0.3, 3 | 噪声模型上限 |
| `SCALE_MIN`, `SCALE_MAX`, `ZOOM_GAIN` | 0.002, 0.08, 0.97 | 缩放采用条件 |
| `AR_TOLERANCE` | 0.03 | 形状检查 |
| `UNRELATED`, `WIDESPREAD` | 0.85, 0.02 | "另一张图" / "改动很分散"提示 |
| `SHARP_MAX` | 12e6 | Lanczos 重采样的像素上限 |

**所有阈值都是在 `WORK_MAX`=768 下调出来的。** 改工作尺寸等于同时改了 `closeR`、块数和 `SEED_FLOOR` 的含义。

已知并接受的取舍：

- 被前景物体挡住一截的细长物体（勺柄、长线缆）只会被取到一部分。连接距离停在 `closeR`，
  是因为放宽后会把箭头旁边被模型顺手重画的眼睛拉进编辑范围。
- 只有一个整体缩放，不处理旋转；贴入的像素只做整体缩放加每块的平移。
- 颜色与原来很接近的那部分编辑可能被留成原图。见第 8.1 节。

### 5.5 图库、上传、保存

- `uploadToImage`（`src/lib/imageUtils.ts`）：按文件头的魔数判断真实格式（不信扩展名和声明的类型）；
  PNG/JPEG、长边 ≤ `MAX_UPLOAD_SIDE`（4096）、且方向是正的（`storedUpright` 读 EXIF）时**原样保留字节**，
  否则摆正、缩小后重画。字节会复制一份，因为磁盘上的文件被移动后 `File` 就读不出来了。
- 下载：`exportBlob` → `makeFilename` → 浏览器下载；"Download all" 打包成 zip（`downloadAllAsZip`）。
- **自写 JPEG 编码器**（`src/lib/jpegEncode.ts`，基线 4:4:4，`SAVE_QUALITY`=95）：浏览器 canvas 的 JPEG 在质量低于 100 时
  会把颜色分辨率减半，锐利边缘会出现色彩拖影。编码在 Worker 里跑，失败时回到主线程。`jpegEncode.ts` 不能依赖 DOM。

### 5.6 局部重绘应用（`src/edit/`）

画选区 → 发原图和黑白蒙版 → `analyzeResult` 估计平移 → `compositeResult` 只把选区贴回原图
（可选无缝融合：增益/偏移拟合 + 膜校正 + 颗粒匹配）。只用 Gemini（`gemini-3.1-flash-image`、`gemini-3-pro-image-preview`）。
`align.ts`、`blend.ts`、`mask.ts` 被生成器的合成器复用，**改它们会同时影响两个应用**。

### 5.7 视频应用（`src/video/`）

Veo 3.1（`veo-3.1-generate-preview`、`-fast-`、`-lite-`）：提交 → 每 8 s 轮询 → 下载。
`src/lib/videoEngine.ts` 是 `retryEngine.ts` 的近似副本，**改重试策略要两边一起改**。
生成器里还有另一条视频路径：`gemini-omni-1.1-flash`（`src/lib/omni.ts`）。

### 5.8 Cloudflare Worker 与云同步

- `worker/index.ts`：密码登录（`APP_PASSWORD`，少于 8 位则所有请求返回 503）、无状态会话 cookie `nbr_session`
  （HMAC，30 天，改密码即全部登出）、登录失败锁定（每个网络段 10 次 / 全局 100 次，15 分钟窗口）。
- 接口：`GET /api/snapshot`、`POST /api/push`（按 key 做 compare-and-set，冲突返回 409）、`GET|PUT /api/blob/<id>`。
  写操作要带 `X-NBR: 1` 头并且同源。
- 存储：一个 Durable Object（`SyncStore`，SQLite），没有 KV/R2/D1。按设计是单用户、单数据集。
- 客户端 `src/lib/cloud.ts`：三个应用的 `main.tsx` 都先 `await bootCloud()` 再渲染。它接管
  `Storage.prototype.setItem/removeItem`，把所有通过 `isSyncedKey` 的 `nbr.*` 键和参考照片（`refs:generator`）同步上去。
- 不同步的：API key、`nbr.promptSync.updatedAt`、生成的图片和视频。

## 6. 不能破坏的约定

1. **API key 不同步。** key 不在 `Settings` 里（`Settings` 会整体写进同步文件）。云同步靠名字排除：客户端
   `isSyncedKey` 拒绝匹配 `/api.?key/i` 的键，服务端 `SECRET_KEY_PATTERN` 再拒一次。**新增任何存 key 的键名，
   必须仍然匹配这个正则。**
2. **改 `src/` 必须重建并提交三个单文件。**
3. **合成区域之外逐位等于原图。** 合成结果在应用内保持 PNG，JPEG 只在下载时编码。
4. **错误分类靠字符串。** `classifyError` 在消息里找 "abort"（→ 停止）、"fetch"/"network"（→ 可重试）、
   裸的 400/429/5xx 数字（→ HTTP 状态）。所以：
   - `openai.ts` 故意写 "Content moderation blocked…" 让通道继续重试；
   - xAI/OpenAI 的"连不上"消息故意避开 fetch/network 两个词，让 CORS 拦截直接终止而不是白试六次；
   - 合成器的 `final` 拒绝理由里不能出现上面任何一个词或数字。
   **改这些文案就是改行为。**
5. **只有形状拒绝是 `final`。** 内容类拒绝必须是普通拒绝，交给重试循环。
6. **图片顺序**：原图、示意图、参考图，必须与 `buildEditPrompt` 里的编号、`imagesExplained: true` 保持一致。
7. **`@N` 的编号在三处要一致**：`PromptPanel` 的计数、参考图条上的角标、`App.tsx` 里的
   `references.slice(0, maxReferences)`，都要和各调用器收到的数量对得上。
8. **`extras` 以合成图的 base64 为键**（`localEditClient.ts`）。`useRetryRun` 必须把引擎给的原始 `part` 传给 `onImage`。
9. **版本号**取自 `useEditStudio` 里 state 更新函数之外的 `versionCounters` ref（为了 React StrictMode），不要挪进更新函数。
10. **合成器用原图的原始字节准备**（`source.image.blob`），不用垫框后的图。
11. **云同步层自己的写入**必须用 `rawSetItem` / `rawRemoveItem` 和 `saveStoredReferences(slot, refs, false)`，否则会被当成用户编辑再推回去。
    应用不能在 `bootCloud()` 完成前读 localStorage。
12. **`usePersistedReferences` 在首次加载完成前不能写**（`loadedRef`），否则会清空已存的参考照片。
13. **对象 URL 故意不回收**（`clearImages`）：工作室可能还在显示这些图。
14. Worker 的 `Referrer-Policy` 是 `same-origin`：改成 `no-referrer` 会让登录 POST 的 `Origin` 变成 `null`，被同源检查拒绝。

## 7. 测试

**仓库里没有任何测试。** 到目前为止的验证全靠我在会话的临时目录里搭的工具，它们**不在仓库里**，
会话容器回收后就没有了：

`/tmp/claude-0/-home-user-nano-banana-redo/4b44d2d2-3f26-533e-9d9e-86e1eec6ebb3/scratchpad`

如果你接手时这个目录已经不存在，下面是重建它所需要知道的全部。把合成器的回归测试搬进仓库是我建议的**第一件事**（第 8.3 节）。

### 7.1 合成器离线基准

思路：不调用任何模型，用脚本**模拟模型的回答**，再看合成器保住了多少编辑、动了多少不该动的像素。

- **用例**：每个用例一个目录，含 `orig.png`、`result.png`（模拟的模型回答，分辨率可以不同）、
  `ideal.png`（原图加上"只有想要的改动"）、`gt.png`（改动的软蒙版）、`meta.json`
  （`marks:[{x,y}]` 为 0–1 比例，`expect` 为 `ok` / `reject` / `any`），可选 `protect.png`（必须保持原样的区域）。
- **生成**（`bench/sim.py`）：在 scikit-image 自带的样例照片（astronaut、coffee、chelsea 等）上做
  填色、换色、提亮、加斑块，得到 `ideal`；再用 `repaint()` 模拟模型重绘整张图：
  平移、缩放、旋转、6×6 平滑扭曲、模糊再锐化、新噪声、增益/偏移/gamma 漂移、JPEG 压缩、可选改变输出分辨率。
  三个强度：

| 级别 | 平移 px | 缩放 | 扭曲 | 噪声 | 色调 | JPEG | 旋转° |
|---|---|---|---|---|---|---|---|
| `mild` | 3.0 | 0.004 | 0.6 | 2.0 | 0.025 | 90 | – |
| `strong` | 6.0 | 0.009 | 1.3 | 4.0 | 0.05 | 82 | – |
| `warped` | 6.0 | 0.018 | 1.5 | 3.0 | 0.04 | 85 | 0.6 |

- **运行**：把一个很小的 `harness.ts` 用 esbuild 打成 IIFE，在无头 Chromium（Playwright）里对每个用例调用。
  harness 的全部内容就是：

```ts
import { composeLocalEdit, lastLocalEditDebug, lastLocalEditStats, prepareLocalEdit } from '<repo>/src/lib/localEdit'
window.runCase = async (origB64, resB64, marks) => {
  const job = await prepareLocalEdit(blob(origB64), marks.map((m, i) => ({ id: String(i), text: 'x', ...m })))
  const out = await composeLocalEdit(job, await createImageBitmap(blob(resB64)))
  return { out, stats: lastLocalEditStats(), debug: lastLocalEditDebug() }  // 图片转成 base64 传回
}
```

  打包：在仓库根目录 `npx esbuild <harness.ts> --bundle --format=iife --outfile=<harness.js>`。
  评分用 Python（PIL、numpy、scipy）。
- **指标**：
  - `kept`：想要的改动保住了多少，`1 − err(合成, ideal) / err(原图, ideal)`，在改动核心区上算；
  - `extra%`：改动范围（外加短边 5% 的余量）之外被替换的像素比例；
  - `protect`：`protect.png` 区域里逐位相同的比例，**应当是 100**；
  - `seam` / `seamGrad`：接缝外侧 ±3 px 带上的颜色 / 梯度误差；
  - 该接受的被拒绝、该拒绝的被接受，记为 wrong-kind。
- **规模**：原始基准 36 例（三张样例照片 × 多种编辑 × 三个强度）；后来几轮对抗式评审又加了三百多例
  （发丝、耳钉、痣、眼镜、孔洞、画面边缘、双箭头、严重压缩、暗角、缩放漂移等），合计 344 例。
- **最后一次全量结果**（PR #9 的代码，336 例）：接受 312、拒绝 24、wrong-kind 6、`protect<100` 3、平均 `kept` 0.916；
  36 例基准全部通过。PR #9 相对 PR #7：接缝颜色误差 1.20 → 1.24，接缝梯度误差 1.55 → 1.65
  （贴入层更锐利的代价，可以接受）。

### 7.2 端到端脚本

Playwright 打开构建好的 `nano-banana.html`（`file://`），先往 localStorage 里放假的 key 和设置，
用 `page.route` 伪造 `generativelanguage.googleapis.com`、`api.openai.com`、`api.x.ai` 的回答
（回答用基准用例里的 `result.png`），然后像用户一样点界面。覆盖过的内容：

- 本地修图整轮流程（无变化的回答被拒后重试、脸部像素不变、采用整张回答）；
- 三个提供方的请求格式（包括 OpenAI `/v1/images/edits` 的 multipart、xAI 多图失败后的单图回退）；
- 箭头界面与生成的提示词；
- 上传（EXIF 方向、超大图、非标准比例垫框）、拖入、粘贴；
- `@N` 引用与选择器；
- 保存格式（应用内 PNG，下载和 zip 按所选格式）；
- Stop 发生在准备阶段 / 合成阶段，Worker 崩溃后回到主线程；
- 云端：登录、同步、冲突、CSRF、开放重定向、锁定（需要 `npx wrangler dev` 跑在 8787，
  并且每次用全新的 `--persist-to` 目录，因为锁定测试会把自己锁住 15 分钟）。

注意：这些脚本靠界面文案定位元素（"Apply edit"、"only around arrows" 等），改文案会让它们失效；
跑之前要先 `npm run build:single`。

### 7.3 没有验证过的

以下都只用模拟回答测过，**没有用真实 API key 验证**（我这边拿不到 key，也连不上线上站点）：

- 非标准比例的上传图，垫框后各模型的真实回答裁回来是否对齐；
- 各模型对 `@N` 引用的实际遵从程度；
- 各模型 id 是否都可用。

## 8. 未完成的事

### 8.1 颜色接近的编辑部分被留成原图（已定位，主人决定暂不修）

- **现象**：一个箭头指着裙子，要求改短。结果里新露出的大腿下缘还留着一块原来的裙摆。
- **原因**：那一块新内容（皮肤）和原内容（裙子）颜色太接近，差异只够得上 `weak` 甚至更低；
  而弱变化只跟随强变化 `WEAK_REACH`·`closeR` 这么远，更远的就按"没变"留成了原图。
  主人要的"腿上蹭了灰"让肤色更接近米色的裙子，所以更容易碰上。
- **复现**（模拟，不是模型的真实回答）：把那一块的回答换成"原图的平滑色调与干净编辑结果的混合"，
  使它与原图的 RGB 最大通道差中位数为 12 时，那一块有 15% 被留成原图；中位数为 8 时有 67%。
  单箭头、`mild` 重绘强度。
- **主人的解决办法**：多放一个箭头指到那一块，残留就没有了。主人因此认为"可能也不是个问题"，要求先不改。
  多箭头为什么有效没有单独做模拟验证，但与机制吻合：每个箭头各自认领尖端附近的变化。
- **如果以后要修**：候选方案是让"被已认领的变化包围、并紧贴着它"的弱变化也并入。风险是放松了保护范围，
  正好与 `toneDrift` 和连接距离那几条防线相冲突（它们防的就是脸被带进来），必须重跑全部带 `protect.png` 的用例。
- 给使用者的建议：改大面积的东西（整条裙摆）时沿着要变的区域放 2–3 个箭头，尤其是两端。

### 8.2 我提过、主人还没要求做的功能

围绕"同一个人物、不同穿着和场景"的工作方式，我建议过：

1. 图库持久化，并记住每张图的"配方"（prompt、模型、参考图），现在刷新就全没了；
2. 穿着 × 场景的批量组合出图；
3. 一键把某张结果设为参考照片；
4. 收藏 / 标星；
5. 修图时的"保护"标记（明确圈出不许动的地方，与箭头相对）。

这些只是建议，**开工前先问主人**。

### 8.3 我建议接手后先做的

1. **把合成器基准搬进仓库**（例如 `tools/`）：`sim.py`、harness、运行脚本、评分脚本合计几十 KB。
   现在合成器的每个阈值都靠这套东西兜底，而它只存在于临时目录里。注意：用例里有一组是主人自己的照片，**不能入库**。
2. **更新 README.md**（见第 9 节）。

### 8.4 读代码时看到、尚未处理的问题

合成器与工作室：

- `blendArea` 里用 `corr.a == 1,1,1 && corr.b[0] == 0` 判断"外圈样本太少"并换用全局拟合，但 `corr.field`
  此前已按单位增益解出，全局漂移有可能被校正两次。**这是读代码得出的疑点，没有验证。**
- `refineOffset` 比较的是未做颜色拟合的亮度。
- `sharpAnswer` 忽略回答的 alpha，并且在 gamma 编码值上重采样。
- 工作室的会话只在内存里；`learned` 形状表也是，且不区分分辨率档位。
- `LocalEditInfo.coverage` 算了但没有显示。
- 垫框只用于本地合成；采用整张回答的编辑用 `aspectRatio: 'auto'`。
- 对 OpenAI，`learnShape` 返回 null，形状不符会直接终止。

生成器：

- 结果后处理抛错时那张图被悄悄丢掉，但 `collected` 已经加过了，计数可能比图库多。
- `isAbortError` 匹配任何含 "abort" 的消息，无关错误里出现这个词会让通道静默退出。
- 普通出图选 JPG（`processImagePart`）和超过 7 MB 的编辑源图（`imageToReference`）仍用浏览器的 4:2:0 编码，
  没有走新的 4:4:4 编码器。
- 原样保留的上传图带着全部 EXIF（包括可能的 GPS）发给提供方，也原样进入下载。
- 图库没有单张删除（`removeImage` 存在但没接上）；灯箱按下标而不是 id 追踪当前图。
- 文件名前缀 `abigail-` 和 zip 名是写死的。

Prompt 与同步：

- 从同步文件拉回来的 workspace 没有逐模块校验，手改过的文件缺 `variants` 会让 `ModuleCard` 出错。
- 文件同步没有监听和先读后写，是按 `updatedAt` 的后写者胜；云模式下这个 hook 仍在运行，只是界面被隐藏。
- `@` 选择器只在 `PromptPanel` 里有，系统指令框和工作室的输入框没有。
- 云同步不分批：一次超过 100 个脏键或单值超过 900,000 字符会一直重试失败。

局部重绘与视频：

- `useEditEngine.start` 里 `rasterizeAlphaMask` / `prepareEditJob` 在 `try` 之外，抛错会让状态卡在"运行中"。
- 局部重绘的 Ctrl/Cmd+Z 在提示词输入框里也被拦截，撤销的是选区而不是文字。
- 视频：轮询或下载阶段的临时错误会让通道**重新提交一次生成（重复计费）**，因为没有保留操作句柄；
  Stop 或刷新后服务端的任务仍在计费，也无法恢复。

## 9. README.md 的过时之处

`DEPLOY.md` 是准确的（只是还把旧分支名列为 `main` 之外的备选）。`README.md` 落后于代码：

- 写的是"两个应用、基于 Gemini"，实际是三个页面，另有 OpenAI 和 xAI 两个提供方；
- 没有提视频应用和 `build:single:video`；
- 只提了 Google AI Studio 的 key，实际每个提供方有 3 个 key 位；
- 模型列表只有三个 Gemini 模型；
- 没有提修图工作室的近期功能：上传后编辑、箭头、only around arrows、`@N` 引用。

## 10. 历史

| PR | 合并日期 | 内容 |
|---|---|---|
| #1 | 2026-06-10 | 带自动重试的出图工作台 |
| #2 | 2026-06-10 | 单文件构建、系统指令、第二个 key、局部重绘应用 |
| #3 | 2026-07-18 | 无缝融合、第三个 key、模块化 prompt、Veo 视频应用 |
| #4 | 2026-10-30 | xAI 与 OpenAI 提供方、Omni 视频、文件同步、多轮修图工作室、明暗主题 |
| #5 | 2026-10-31 | Cloudflare 带密码部署与跨设备同步 |
| #6 | 2026-11-02 | 用箭头指出要改哪里 |
| #7 | 2026-11-03 | only around arrows 本地合成器及其评审修复 |
| #8 | 2026-11-12 | 上传自己的图来编辑、`@N` 引用参考图、按所选格式保存 |
| #9 | 2026-11-13 | 贴回的编辑保持锐利（Lanczos）、全色度 JPEG 编码器 |
