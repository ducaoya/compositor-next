# Compositor（跨平台）

[English](README.md) · **简体中文**

一个用于合成与修图的跨平台图像编辑器，以
[robbietilton/Compositor](https://github.com/robbietilton/Compositor) 的设计为基础 —— 那是原作者
用 Swift 写的、面向 macOS 的免费开源 Photoshop 替代品。

那个项目是这里一切设计的灵感来源与参照。本项目是它的从零重写，让同一个编辑器能跑在 Windows、
macOS 和 Linux 上：用 Tauri 2 + Vue 3 + WebGPU + Rust，而不是 AppKit + Core Image + Metal。

它读写原项目的 `.comp` 工程格式（版本 1–11），因此任一编辑器保存的工程都能在另一个里打开。

**协议：MIT。** 本项目是衍生作品，原项目的版权声明已完整保留在 [LICENSE](LICENSE)。详见
[署名与协议](#署名与协议)。

## 功能

- **`.comp` 工程读写** —— 图层组、图层蒙版、剪贴蒙版、参考线、逐图层不透明度与混合模式，兼容
  版本 1 到 11。
- **合成** —— 全部 24 种混合模式，按 Photoshop 的方式在 sRGB 空间合成；12 种调整图层（色相/饱和度、
  色阶、曲线、曝光度、渐变映射、颗粒、反相、黑白、色彩平衡、高斯模糊、动感模糊、添加杂色）；
  可绘制的图层蒙版；图层组。
- **绘制与选区** —— 画笔与橡皮擦（大小、硬度、不透明度、流量、笔迹平滑）；矩形、椭圆、套索选区
  以及魔棒，支持羽化、扩展、收缩；移动工具带吸附，以及缩放/旋转手柄。
- **导入图像，导出拼合 PNG。**
- **全程撤销**，一次手势一步。
- **Photoshop 风格的界面**，内置英文与简体中文，可安装第三方语言包。
- **文件里有的内容都能完整往返**，即使当前版本还渲染不了。

尚未实现：图层效果与色相/饱和度的色彩范围分带（两者可完整读写，但未渲染）；PSD 导入；相机 RAW；
选择主体；双击打开 `.comp`；以及任何与"不能丢的文档"相关的功能 —— 目前没有自动保存，也没有崩溃恢复。

## 开始使用

环境要求：[Rust](https://rustup.rs)（Windows 上需 MSVC 工具链）、Node 22+、pnpm，以及 WebView2 运行时。

```sh
pnpm install
pnpm app          # 打开桌面窗口
```

也可以在浏览器里单独跑前端（会载入一个示例文档），无需桌面外壳即可调试画布、画笔和混合模式：

```sh
pnpm dev
```

其余脚本：

| 命令 | 作用 |
|---|---|
| `pnpm check` | 运行全部 Rust 与 TypeScript 测试 |
| `pnpm build` | 构建前端产物 |
| `pnpm tauri build` | 打包出可签名的桌面安装包 |
| `node scripts/make-sample-comp.mjs` | 重新生成 `examples/sample.comp` |
| `node scripts/dev-browser.mjs` | 后台静默的 headless Chrome + WebGPU，用于脚本化界面验证 |

建议先打开 `examples/sample.comp` —— 它覆盖了混合模式、图层组、剪贴蒙版和图层蒙版。
`scripts/dev-browser.mjs` 启动的是**后台无窗口**的 Chrome（远程调试 + 软件 Vulkan 设备），
本项目的界面改动都是这样验证的，它不会抢占你的屏幕。

### 多语言

英文是默认语言，也是回退语言；简体中文随应用内置。其他语言就是一个 JSON 文件：**编辑 › 语言 ›
安装语言包…**，或把文件放进语言包目录后点击"重新载入语言包"。语言包可以只翻译一部分 —— 未翻译的
键会回退显示英文，而不是显示键名。详见 [docs/language-packs.md](docs/language-packs.md)。

## 二次开发

```
crates/core/     .comp 格式：manifest schema、校验、包 I/O
crates/shaders/  对 WGSL 做解析与校验，让着色器写错在测试阶段就失败
src-tauri/       桌面外壳，以及 webview 允许调用的命令
web/src/model/   文档、混合、调整、选区、工具 —— 纯逻辑，无需 GPU 即可测试
web/src/render/  WebGPU 合成器、WGSL、画笔、PNG 编码器
web/src/state/   session 状态中枢，以及前端与 Rust 的边界
web/src/i18n/    消息表与语言包机制
web/src/components/  Vue 界面
```

`web/src/model/` 里没有 canvas、没有 GPU、没有 DOM，所以大部分有意思的算法都能直接测试。
任何需要 GPU 的东西都在 `web/src/render/`。

**加一个工具**改三处：`web/src/model/tools.ts` 里加一条（标签键、快捷键、内联 SVG、
`implemented: true`），在 `web/src/components/CanvasStage.vue` 的指针状态机里加一个 `case`，
在 `web/src/components/OptionsBar.vue` 里加它自己的选项区。

**加一种混合模式**：`BLEND_MODES` 加一项、`web/src/model/blend.ts` 加一个分支、
`web/src/render/compositor.wgsl` 加一个 `case`。**加一种调整**结构相同：`ADJUSTMENT_KINDS`、
`buildLut` 或 `web/src/render/adjust.wgsl` 里的 `case`，以及 `AdjustmentPanel.vue` 里的一块控件。
两种情况都有一个 Rust 测试会去解析**真实的着色器文件**，一旦编号顺序错位就失败 —— 这是保证"在这个
编辑器里调好的工程，在另一个里打开仍然正确"的唯一办法。

**加一句文案**：在 `web/src/i18n/locales/en.json` 和 `zh-CN.json` 各加一个键。有测试强制两者键集合
完全一致、占位符完全一致。

**改格式**：schema 在 `crates/core/src/manifest.rs`，规则在 `validate.rs`。任何"旧版本读不了"的改动
都要提升 `Manifest::CURRENT_VERSION`；任何旧版本必须容忍的字段都要可选。Rust 从不拼接面向用户的
英文句子 —— 它只返回翻译键和占位符取值，由语言包负责措辞。

各部分的衔接方式 —— 合成管线、CPU 绘制路径、存盘协议，以及三个只有在真实 GPU 上才会暴露的
bug —— 记录在 [docs/architecture.md](docs/architecture.md)。

**先跑测试。** `pnpm check` 会跑全部：Rust 测试覆盖格式与着色器，TypeScript 测试覆盖算法、图层树
和消息表。只有 GPU 才能体现的行为 —— 每种混合模式、每种调整、画笔、选区、变换手柄、蒙版绘制 ——
都是通过脚本驱动真实界面在 headless Chrome 里验证的，其中三个 bug 用其他办法根本发现不了。

## 署名与协议

**本项目是 [robbietilton/Compositor](https://github.com/robbietilton/Compositor) 的衍生作品**，
该项目采用 MIT 协议，Copyright (c) 2026 Wonder Assembly LLC。按其条款要求，其版权声明已完整保留在
[LICENSE](LICENSE)。

这里没有任何一行是该项目的源码拷贝 —— 语言不同、UI 工具包不同、渲染栈也不同。从它那里推导来的是
设计：

- `.comp` 格式：schema、版本历史、校验规则与各项上限；
- 24 种混合模式公式，以及"在 sRGB 而非线性光下混合"这一取舍；
- 12 种调整公式：色阶、保形曲线插值、线性光下的曝光度、黑白的通道混合、色彩平衡的色调权重、
  渐变映射与颗粒的哈希；
- 合成模型：穿透式图层组、组不透明度乘算进子图层、剪贴蒙版即 alpha 链接、调整层作用于其下方；
- 色相/饱和度的 HSL 数学，以及 Photoshop 的乘法式饱和度；
- 界面，仿照原项目，而原项目仿照 Photoshop。

如果你是原作者，希望这里的措辞或署名方式有所调整，请开 issue。

本项目采用 **MIT 协议**发布。发布前请把 [LICENSE](LICENSE) 里那行占位版权署名替换为你自己的
名字或实体。
