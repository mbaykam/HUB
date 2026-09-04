<p align="center">
  <img src="./resources/icons/icon.png" width="112" alt="HUB 图标">
</p>

<h1 align="center">HUB</h1>

HUB 是一个专注的桌面 AI 工作空间，并提供快速、移动优先的 PWA。它是
[Minke](https://github.com/lencx/Minke) 的独立定制分支，由
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供核心能力。

## 主要改进

- 修复 Cloudflare Access 与私有 DSH 浏览器会话的 PWA 身份验证流程。
- 缩短移动端启动时间，并优化屏幕键盘打开时的视口行为。
- 添加可滑动的液态玻璃导航面板、移动端主页启动和单击 Session 切换。
- 添加 Codex 与 OpenRouter 的紧凑用量面板。
- 移除常驻品牌图案和可能卡住的移动端工具提示。
- 使用简洁的几何图标，将桌面应用和 PWA 全面重命名为 HUB。

## 本地运行

需要 Node.js 24+、pnpm 11 和 Git submodules。

```bash
git clone --recurse-submodules https://github.com/mbaykam/Minke.git
cd Minke
pnpm install
pnpm run harness:stage
pnpm start
```

## 隐私

仓库只包含源代码，不包含本地配置、凭据、Session 日志、远程访问设置、
已安装插件或设备专用路径。

## 鸣谢与许可

HUB 基于 lencx 的 [Minke](https://github.com/lencx/Minke)，并包含
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
项目使用 Apache-2.0 许可证。
