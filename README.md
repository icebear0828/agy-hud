# agy-hud 🚀

> **Antigravity CLI (agy)** 的实时状态 HUD 插件 —— 在每个步骤完成后自动刷新状态栏，展示会话信息、Token 用量和**真实账号 Quota**。

---

## 功能展示

```
 AGY-HUD  ⎇ main | Plan: Pro | Steps: 42  Tasks: 3
 Tokens: 85.2k/12.1k | Ctx: 85.2k/200.0k [████░░░░░░] | Model: Claude Sonnet 4.6

  Gemini 3.5 Flash (Hig… [█████░░░] 60% ~30m  |  Gemini 3.5 Flash (Med… [█████░░░] 60% ~30m
  Claude Sonnet 4.6 (Th… [███░░░░░] 40% ~4h 2m  |  Claude Opus 4.6 (Thin… [███░░░░░] 40% ~4h 2m
  GPT-OSS 120B (Medium) [███░░░░░] 40% ~4h 2m
```

**第一行**：项目分支、套餐、执行步骤数、Task 数  
**第二行**：Token 消耗、上下文窗口使用率进度条、当前模型  
**Quota 行**：每个模型的**账号剩余额度**（与 `/usage` 命令数据完全一致）+ 重置倒计时

---

## 安装

### 方式一：Git URL（推荐）

```bash
agy plugin install https://github.com/icebear0828/agy-hud.git
```

远程安装会安装一个轻量 `post_invocation` hook。hook 运行时会把 runtime 克隆或更新到 agy app data 目录，并自动写入 `settings.json` 的 `statusLine` 命令。

### 方式二：本地开发

```bash
git clone https://github.com/icebear0828/agy-hud.git
cd agy-hud
./setup.sh
```

本地开发模式会安装插件，并把 `settings.json` 的 `statusLine` 指向当前仓库里的 `extensions/bin/agy-hud.js`。

---

## 工作原理

### 状态栏触发
agy 在每个步骤完成后，会执行 `settings.json` 中配置的 `statusLine` 命令。HUD 读取 agy 通过 stdin 传入的 JSON payload（包含会话 ID、Token 用量、模型信息等），渲染后输出到 stdout。

### Quota 数据来源
通过逆向 agy 二进制，确认 `/usage` 命令数据来自：

```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
```

每个 model 对象包含 `quotaInfo.remainingFraction`（剩余比例）和 `quotaInfo.resetTime`（重置时间）。

Token 自动从 agy 的 OAuth 凭据文件读取（跨平台自动搜索），结果本地缓存到重置时间为止，**无后台轮询，无性能影响**。

---

## 配置（可选）

在项目根目录创建 `agy-hud.config.json`，或编辑插件默认配置 `extensions/agy-hud.config.json`：

```json
{
  "display": {
    "useNerdFonts": true
  }
}
```

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `display.useNerdFonts` | boolean | `false` | 启用 Nerd Font / Powerline 图标 |

---

## 文件结构

```
agy-hud/
├── extensions/index.js   # 插件入口，注册 on_step_complete 钩子
├── extensions/bin/agy-hud.js # 主程序：解析 stdin → 渲染输出
├── extensions/statusline.js # statusLine 自动配置
├── extensions/quota.js   # 账号 Quota 获取（含跨平台 token 自动发现 + 本地缓存）
├── extensions/renderer.js # ANSI 渲染器（进度条、颜色、倒计时）
├── extensions/parser.js  # 解析 agy stdin JSON payload
├── extensions/config.js  # 读取 agy-hud.config.json
├── extensions/git.js     # Git 分支信息
└── hooks/hooks.json      # 远程安装后的 statusLine bootstrap hook
```

---

## 跨平台支持

Token 凭据按优先级自动搜索以下路径：

| 平台 | 路径 |
|---|---|
| macOS / Linux | `~/.gemini/antigravity-cli/antigravity-oauth-token` |
| Linux (XDG) | `$XDG_DATA_HOME/antigravity-cli/antigravity-oauth-token` |
| Windows | `%APPDATA%\antigravity-cli\antigravity-oauth-token` |
| Windows (alt) | `%LOCALAPPDATA%\antigravity-cli\antigravity-oauth-token` |

---

## 致谢

本项目的灵感来自 [jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud) —— 一个面向 Claude Code 的同类 HUD 插件，展示上下文用量、活跃工具和 Todo 进度。感谢 Jarrod 的开源工作为这个方向提供了思路。

---

## License

MIT
