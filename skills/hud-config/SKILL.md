---
name: hud-config
description: 当用户想要配置或自定义 agy-hud 的显示设置（主题、图标、面板模式等）时触发。
---

# 配置 agy-hud 状态栏

当用户要求修改、设置、美化或配置 `agy-hud` 状态栏时，推荐按以下流程处理：

1. **查看可用配置项**：
   先运行 `node "$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs" schema` 确认最新配置键名、默认值和可接受范围（不要凭记忆猜测旧版键名）。

2. **通过选择题确认用户偏好**（可选，若用户未明确说明）：
   使用 `ask_question` 收集以下关键项：
   - **布局模式** (`lineLayout`)：`expanded`（默认多行对齐 claude-hud 风格）或 `compact`（单行紧凑）
   - **配额风格** (`display.quotaStyle`)：`table`（默认 Google / Claude / Argon 剩余配额矩阵，保留两位小数）、`minimal`（极简单行 `Usage` 条）、`models`（双列全模型详细条）或 `compact`（横向迷你条）
   - **界面语言** (`language`)：`auto`、`zh-Hans`、`zh-Hant` 或 `en`
   - **常用开关**：Git 状态 (`gitStatus.enabled`)、文件统计 (`gitStatus.showFileStats`)、工具活动 (`display.showTools`)、费用统计 (`display.showCost` / `display.showDailyCost`)、内存 (`display.showMemoryUsage`)、输出速度 (`display.showSpeed`)

3. **写入配置**：
   - 全局配置优先使用沙盒 CLI 命令安全写入 `~/.gemini/antigravity-cli/agy-hud/config.json`：
     `node "$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs" set <key>=<value> ...`
   - 局部工作区覆盖可写入当前项目的 `./agy-hud.config.json`。
   - 修改后可运行 `node "$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs" preview` 立即预览效果。
