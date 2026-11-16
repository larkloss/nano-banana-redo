# 合成器基准（compositor bench）

"only around arrows" 本地合成器（`src/lib/localEdit.ts`）的离线回归测试。不调用任何模型：
用脚本**模拟模型的回答**，再检查合成器保住了多少想要的改动、有没有动到不该动的像素。

改合成器的任何阈值或步骤之前和之后都跑一遍。

## 准备（一次）

```bash
# 仓库根目录
npm install
npm install --no-save playwright && npx playwright install chromium   # 浏览器，仓库本身不依赖它

# Python 3.11+
python3 -m venv .venv && .venv/bin/pip install -r tools/compositor-bench/requirements.txt
```

`esbuild` 随仓库的依赖一起装好了。样例照片不在仓库里，`sim.py` 直接读 scikit-image 包自带的
`astronaut.png`、`coffee.png`、`chelsea.png`。

## 使用

```bash
cd tools/compositor-bench
python sim.py                      # 生成 47 个用例到 cases/（约 6 分钟，只需一次）
node run.cjs before                # 用当前源码跑一遍，结果写到 out/before/
python metrics.py before           # 打分；有用例不通过时退出码为 1

# 改完代码后
node run.cjs after && python metrics.py after
```

- `node run.cjs <标签> [名字过滤…] [--maps]`：每次运行都会重新打包当前源码。
  `--maps` 另外输出检测阶段的几张图，用来看一块内容是在哪一步被留下或被取走的：
  `map-strong.png` 强变化、`map-weak.png` 弱变化、`map-joined.png` 并入的部分、
  `map-first.png` 各箭头最初认领的部分、`map-outline.png` 被认作"只在一张图里有的轮廓"的细线、
  `map-outlined.png` 凭轮廓或物体范围整块取走的部分、`map-grown.png` 最终区域。
- 每个用例的 `out.json` 里有逐箭头的统计（`stats`）：`outline` ≥ 0.5 表示"轮廓围住了箭头处的淡变化"这条规则触发了，
  `around` ≥ 0.75（正数）表示"箭头被一圈轮廓围住"这条规则触发了。
- `python sim.py <场景 id…>` 只重新生成指定场景。
- `cases/`、`out/`、`.build/` 不入库。

## 用例

每个用例一个目录：

| 文件 | 内容 |
|---|---|
| `orig.png` | 被编辑的原图 |
| `ideal.png` | 原图加上**只有**想要的那处改动（标准答案） |
| `result.png` | 模拟的模型回答：把 `ideal` 整张"重画"一遍 |
| `gt.png` | 改动所在位置（软蒙版） |
| `protect.png` | 必须保持原样的区域（脸、另一只眼睛等） |
| `meta.json` | 箭头位置 `marks`（0–1 的比例）；期望 `expect`：`ok` / `reject` / `any`；可选 `left_max`（允许残留的百分比，默认 15）；可选 `options` |

`meta.json` 的 `options` 就是应用在两张图之外交给合成器的东西（`LocalEditOptions`）：

- `extents`：每个箭头所指物体的范围框（"find the object" 开关打开时由 Gemini 给出）；
- `guarded`：不许凭轮廓或范围取走的区域（脸）；
- `touches`：用户在结果上点选的补取 / 还原点。

`sim.py` 里的 `SCENARIOS` 定义了 27 个场景：

- 移除物体、换色、提亮、加斑块；单箭头和双箭头；紧贴画面边缘；模型没改或改错了地方；
- `S-arm*`：一条和身后内容同色的"手臂"被删掉（`smooth` 把照片磨平，`objects` 是原图里有、标准答案里没有的东西）。
  内部新旧几乎一样，明显不同的只有轮廓；
- `*-found`：同样的场景加上物体范围（场景里写 `found=True`），`A-hood-ring-found` 的范围框把脸也框了进去，
  脸在 `guarded` 里，必须保持原样（`guard=True`）；
- `C-remove-spoon-touched`：自动部分留下的勺柄，由三个补取点取走（`touches`）。

`repaint()` 模拟模型重画整张图带来的偏差，分三档：

| 级别 | 平移 px | 缩放 | 扭曲 | 噪声 | 色调 | JPEG | 旋转° |
|---|---|---|---|---|---|---|---|
| `mild` | 3.0 | 0.004 | 0.6 | 2.0 | 0.025 | 90 | – |
| `strong` | 6.0 | 0.009 | 1.3 | 4.0 | 0.05 | 82 | – |
| `warped` | 6.0 | 0.018 | 1.5 | 3.0 | 0.04 | 85 | 0.6 |

加新用例：在 `SCENARIOS` 里加一项（坐标用照片原始像素，`scale` 是放大倍数），再 `python sim.py <id>`。

## 指标

| 列 | 含义 | 期望 |
|---|---|---|
| `pass` | 接受/拒绝与 `expect` 一致，`protect` 为 100，并且 `left` 不超过允许值 | 全部 True |
| `kept` | 想要的改动保住了多少（1 = 全部） | 越高越好 |
| `left` | 改动里明显不同的像素中，仍与原图逐位相同的比例（没被取走的部分） | ≤ `left_max`（默认 15） |
| `extra%` | 改动范围之外（外加短边 5% 的余量）被替换的像素占全图的比例 | 接近 0 |
| `protect` | 受保护区域里与原图逐位相同的比例（不计紧贴改动的那一圈） | **必须 100** |
| `strict` | 同上，但只留很窄的余量 | 越高越好 |
| `seam` / `seamGrad` | 接缝外侧 ±3 px 带上相对标准答案的颜色 / 梯度误差 | 越低越好 |

基线（2026-11-16）：47 / 47 通过。已登记的已知限制（场景里用 `left_max` 或 `expect='any'` 标出，改好了就该收紧）：

- `C-remove-spoon`：被杯沿隔开的勺柄只取到一部分（残留约 30%）；
- `S-arm-large__strong`：重画偏差大时，大物体仍有一部分留下（约 22%）；
- `S-arm-thin-line`：只有一条发丝粗细的轮廓时认不出来，回答被拒绝。给出物体范围后这两种情况都能取干净
  （见 `S-arm-large-found`、`S-arm-thin-line-found`）。

## 局限

这 47 个用例只是最小的一套。开发过程中另有三百多个针对性更强的用例（发丝、耳钉、痣、眼镜、孔洞、
缩放漂移、严重压缩等）没有入库，见仓库根目录 `HANDOFF.md` 第 7 节。模拟的回答也不等于真实模型的回答：
通过基准是必要条件，不是充分条件。
