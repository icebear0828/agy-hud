# agy-hud

[![E2E](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml)
[![Release](https://img.shields.io/github/v/release/icebear0828/agy-hud)](https://github.com/icebear0828/agy-hud/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

> **Antigravity CLI (`agy`)** 的实时 statusline HUD 插件。每个 step 结束自动刷新，展示会话信息、Token 用量和**真实账号 Quota**（与 `/usage` 命令数据一致）。
>
> 每次 push 都会在 **macOS · Linux · Windows** 三平台 CI 矩阵跑 install + HUD 渲染验证——上面绿徽章 = 当前可用。

[English](./README.md)

---

## 显示效果

agy-hud 支持两种额度（Quota）显示模式：**Table 模式**（默认）与 **Compact（紧凑）模式**（按 Provider 分组的迷你进度条）。

### Table 模式（默认）
适合需要详细对比多个模型额度余量和重置时间的场景。

```
AGY-HUD │ ⎇ docs/refactor-readme-bilingual │ ❖ Plan: Google AI Pro │ ⚡ Steps: 0 │ ✓ Tasks: 0
⚿ Tokens: 83.7k (in: 4.8k, out: 13.9k, cache: 65.1k) │ ⛁ Ctx: 75.4k/1M [█░░░░░░░░░] │ 🤖 Model: Gemini 3.5 Flash(L)
1 MEMORY.md │ 0 rules │ 0 MCPs │ 2 hooks
  ───────────────────────────────────────────────────────────────────────────
  Gemini 3.5 Flash(M) [█████░]  80% ~3h22m │ Gemini 3.5 Flash(H) [█████░]  80% ~3h22m
  Gemini 3.5 Flash(L) [█████░]  80% ~3h22m │ Gemini 3.1 Pro(L)   [█████░]  80% ~3h22m
  Gemini 3.1 Pro(H)   [█████░]  80% ~3h22m │ Claude 4.6(Th)      [██░░░░]  40% ~148h28m
  Claude Opus(Th)     [██░░░░]  40% ~148h28m │ GPT-OSS 120B        [██░░░░]  40% ~148h28m
```

### Compact（紧凑）模式
极度节省空间，将当前正在使用的模型额度百分比及重置倒计时直接嵌入到第 2 行末尾，同时在下方展示按 Provider 分组的极简迷你条。

```
AGY-HUD │ ⎇ main │ ❖ Plan: Pro │ ⚡ Steps: 42 │ ✓ Tasks: 3
⚿ Tokens: 138.4M (in: 6k, out: 202k, cache: 138.2M) │ ⛁ Ctx: 138.2M/1M [████░░░░░░] │ 🤖 Model: Claude Sonnet 4.6 │ Quota: 100% ~5h
1 MEMORY.md │ 4 rules │ 1 MCPs │ 5 hooks
Anthropic: Son███ Opus█░░ │ Google: Flash███ Pro███ │ OpenAI: GPT█░░
```

### 布局结构说明
- **第一行**：当前 Git 分支、套餐、已运行的步骤数（Steps）、当前任务数（Tasks）。
- **第二行**：Token 用量（包括输入/输出/缓存细分数据）、上下文窗口使用率进度条、当前激活的模型名称（如开启 Compact 模式，还会在末尾包含当前模型的额度及重置时间）。
- **第三行**：工作区状态——项目 Memory 文件、系统 Rules 规则数、已配置的 MCP 服务数、已激活的 Git Hooks 挂钩数。
- **额度行**：账号内各模型的剩余额度比例（与 `/usage` 保持完全一致）及重置倒计时。

---

## 安装

一条命令搞定（在普通 shell 里跑，**不要**在已打开的 `agy` 会话里跑）：

**macOS / Linux**：
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.sh)
```

**Windows PowerShell**：
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.ps1 | iex
```

**Windows CMD**：
```cmd
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.ps1 | iex"
```

该安装脚本会：
1. 干净地重新安装插件（`agy plugin uninstall` + `agy plugin install`）。
2. 下载 HUD 运行所需的 runtime 到 `~/.gemini/antigravity-cli/agy-hud-runtime/`。
3. 将 `statusLine.command` 写入到 `~/.gemini/antigravity-cli/settings.json`。

重新打开一个 `agy` 会话，终端底部便会显示 HUD 状态栏。

**幂等性**——任何时候重跑同一命令都能修复配置偏移、更新版本或清空旧版残留。

### 为什么不只跑 `agy plugin install`？

`agy plugin install` 只下载并注册**声明式**插件标记文件（`plugin.json`），它不会执行任何 JS 代码，也不会修改您的 `settings.json`。而 HUD 的 statusLine 命令和渲染运行时需要进行额外配置，`install.sh` 将这两部分原子化地同步完成。

### Fork 镜像/自建仓库安装

**macOS / Linux**：
```bash
AGY_HUD_REPO_RAW=https://raw.githubusercontent.com/your-fork/agy-hud/main \
AGY_HUD_REPO_URL=https://github.com/your-fork/agy-hud.git \
  bash <(curl -fsSL "$AGY_HUD_REPO_RAW/scripts/install.sh")
```

**Windows PowerShell**：
```powershell
$env:AGY_HUD_REPO_RAW = 'https://raw.githubusercontent.com/your-fork/agy-hud/main'
$env:AGY_HUD_REPO_URL = 'https://github.com/your-fork/agy-hud.git'
irm "$env:AGY_HUD_REPO_RAW/scripts/install.ps1" | iex
```

### 手动安装（高级用户）

如果您希望分步手动运行：

**macOS / Linux**：
```bash
agy plugin install https://github.com/icebear0828/agy-hud.git
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.sh)
```

**Windows PowerShell**：
```powershell
agy plugin install https://github.com/icebear0828/agy-hud.git
$t = Join-Path $env:TEMP "agy-hud-bootstrap.js"
Invoke-WebRequest -Uri https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js -OutFile $t -UseBasicParsing
node $t; Remove-Item $t
```

**Windows CMD**：
```cmd
agy plugin install https://github.com/icebear0828/agy-hud.git
powershell -Command "Invoke-WebRequest -Uri https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js -OutFile %TEMP%\agy-hud-bootstrap.js -UseBasicParsing"
node %TEMP%\agy-hud-bootstrap.js
del %TEMP%\agy-hud-bootstrap.js
```

---

## 验证

跑完安装或 bootstrap 后：

```bash
# settings.statusLine 应当正确指向 runtime 路径
cat ~/.gemini/antigravity-cli/settings.json | grep statusLine -A2

# 直接手动运行 HUD 入口文件，应当能看到输出的 AGY-HUD 状态条
node ~/.gemini/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.js
```

若额度行显示 `Antigravity token expired`，只需刷新你的 `agy` 登录状态（`agy login`）即可，这**不是**安装程序失败。

Windows PowerShell 验证命令：

```powershell
Get-Content "$env:USERPROFILE\.gemini\antigravity-cli\settings.json"
& "$env:USERPROFILE\.gemini\antigravity-cli\agy-hud-runtime\runtime\bin\agy-hud.cmd"
```

---

## 诊断

```bash
# 检查 token 及 quota cache（额度缓存）的本地状态
node scripts/diagnose-auth.js

# 追踪 agy 自身 statusLine 执行器的错误日志
ls -t ~/.gemini/antigravity-cli/log/cli-*.log | head -1 | xargs tail -50 | grep statusline
```

最常见的故障是 `statusline_runner.go: failure N/30` —— 这表示 `settings.json` 中配置的 `statusLine.command` 指向了一个不存在的路径。重新跑一次 bootstrap 安装流程即可。

---

## 卸载

**macOS / Linux**：
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.sh)
```

**Windows PowerShell**：
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex
```

**Windows CMD**：
```cmd
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex"
```

如果您已克隆了本仓库，也可以在根目录下直接执行：`bash uninstall.sh` 或 `.\uninstall.ps1`。

卸载命令会：
1. 清除 `settings.json` 中的 `statusLine` 配置（同时保留一份名为 `.bak` 的备份文件）。
2. 删除 `~/.gemini/antigravity-cli/agy-hud-runtime/`。
3. 卸载已注册的插件（`agy plugin uninstall agy-hud`）。
4. 清理临时 Token 镜像和 quota cache 缓存文件。

---

## 配置（可选）

您可以选择在工作区根目录下创建 `agy-hud.config.json` 来覆盖默认设置。如果不创建，HUD 默认将读取已下载运行时中的 `runtime/agy-hud.config.json` 默认配置：

```json
{
  "theme": {
    "primary": "green",
    "secondary": "gray",
    "warning": "yellow",
    "critical": "red"
  },
  "display": {
    "quotaStyle": "table",
    "showTokenBar": true,
    "showBreadcrumbs": true,
    "showGitBranch": true,
    "breadcrumbCount": 3,
    "useNerdFonts": false,
    "columnWidth": 37
  },
  "thresholds": {
    "warning": 0.7,
    "critical": 0.9
  },
  "language": "auto"
}
```

### 配置项说明
- **`theme`**：定制 HUD 各组件的前景颜色（`primary`、`secondary`、`warning`、`critical`）。支持终端 ANSI 标准色（`green`、`gray`、`yellow`、`red`、`blue`、`magenta`、`cyan`）。
- **`display`**：
  - `quotaStyle`：额度显示样式，可选值为 `"table"`（默认，多列对齐表格模式）或 `"compact"`（紧凑模式，嵌入单模型额度并按 Provider 分组展示迷你进度条）。
  - `showTokenBar`：是否展示 Token 用量行。
  - `showBreadcrumbs`：是否展示工作区文件导航（Breadcrumbs）。
  - `showGitBranch`：是否在 HUD 中显示当前 Git 分支。
  - `breadcrumbCount`：导航栏中最多展示的文件项数。
  - `useNerdFonts`：开启后（设为 `true`），将使用 [Nerd Fonts](https://www.nerdfonts.com/) 的高保真开发者图标，体验更佳。
  - `columnWidth`：Table 模式下每一列的最大宽度（默认为 `37`）。
- **`thresholds`**：资源使用占比警戒线阈值（`0.0` 到 `1.0`），分别对应黄色的警告和红色的紧急状态。
- **`language`**：语言偏好选项（`"auto"`，`"en"`，`"zh"`）。

---

## 目录结构

```
agy-hud/
├── plugin.json                # {"name":"agy-hud"} — agy plugin marker
├── gemini-extension.json      # agy 远程安装验证器强制要求
├── runtime/                   # bootstrap 下载到 ~/.gemini/.../agy-hud-runtime/runtime/
│   ├── bin/agy-hud.js         # statusLine 入口（stdin JSON → ANSI HUD）
│   ├── quota.js               # fetchAvailableModels 客户端（与 /usage 对账）
│   ├── statusline-installer.js
│   ├── uninstall.js
│   └── ...
├── scripts/
│   ├── install.sh             # 一行安装入口 — macOS/Linux
│   ├── install.ps1            # 一行安装入口 — Windows PowerShell
│   ├── bootstrap.sh           # 修复用入口（被 install.sh 调用）
│   ├── bootstrap.js           # 实际下载 + 配置逻辑
│   ├── configure-utf8.ps1     # 可选：Windows UTF-8 终端配置与 Git 编码助手
│   ├── verify-display.js      # E2E：安装 + 引导 + 模拟起 PTY agy 并断言 HUD 存在
│   └── diagnose-auth.js
├── tests/unit/                # node --test 单元测试
├── .github/workflows/e2e.yml  # 跨平台 CI 自动化矩阵
└── release.sh                 # npm test → E2E 检查 → 打包 zip → Github Release
```

---

## 跨平台说明

**Windows UTF-8 终端助手**：如果您的 Windows 控制台不在 UTF-8 代码页下且您希望获得漂亮的 Unicode 框线/进度条显示，请运行：

```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/configure-utf8.ps1 | iex
```

该脚本会在您的 PowerShell 配置文件中追加 UTF-8 代码页的初始化脚本，并设定 Git 全局文件名的 UTF-8 编码支持。该命令是幂等的，运行完毕后需要重启 PowerShell。

**Windows Token 刷新机制**：Antigravity CLI 将 OAuth 的凭据（`refresh_token` / `access_token`）存放于系统的凭据管理器（Credential Manager）中（`gemini:antigravity` / `LegacyGeneric:target=gemini:antigravity`）。本 HUD 会优先使用系统临时目录中的 `agy-hud-token.json` 短效缓存。当 fast path 发现文件凭据过期或缺失，将触发分离的后台读取进程去拉取并刷新凭据，下一次渲染时会自动加载。注意，agy-hud 自身**不参与**凭据更换换取 Access Token，若凭据管理器中的 Token 彻底过期，需要您在宿主终端中先行运行 `agy login`。

**Token 文件回退路径**（按如下顺序搜索候选）：
- `~/.gemini/antigravity-cli/antigravity-oauth-token`
- `$XDG_DATA_HOME/antigravity-cli/antigravity-oauth-token`
- `$APPDATA/antigravity-cli/antigravity-oauth-token`
- `$LOCALAPPDATA/antigravity-cli/antigravity-oauth-token`

---

## CI 验证保障

每次 push 到 `main` 分支都会触发 [.github/workflows/e2e.yml](./.github/workflows/e2e.yml) 执行三平台（Linux / macOS / Windows）CI 流程：

| 操作系统 | install.sh 成功运行 | bootstrap 写入 settings.json | HUD 独立命令正确生成 `AGY-HUD` |
|----|------|------|------|
| ubuntu-latest | ✅ | ✅ | ✅ |
| macos-latest  | ✅ | ✅ | ✅ |
| windows-latest | ✅ | ✅ | ✅ |

每次 CI 运行都会上传如下产物（保留 14 天）：

| 产物名称 | 分配平台 | 内容说明 |
|---|---|---|
| `e2e-<os>` | 包含全部三个系统 | 诊断日志 `e2e-report.json` + `agy-hud-pty-*.log`（富 ANSI 颜色转义代码的文件，`cat` 它即可在本地模拟看到带颜色 HUD） |
| `hud-screenshot-<os>` | ubuntu 与 macos | `hud-ascii-<os>.png` 和 `hud-unicode-<os>.png`，由 [charm.sh `freeze`](https://github.com/charmbracelet/freeze) 生成，您可以下载后直接用图片查看器预览渲染效果。 |

CI 在**无授权模式（no-auth）**下运行，只断言命令执行生成的状态栏符合预期。带真实 Token 与账户数据的全套 E2E 集成验证通过 `release.sh` 在开发者本机进行。

---

## 已知问题

- **Windows 平台 PNG 截图限制**：CI 会使用 [charm.sh `freeze`](https://github.com/charmbracelet/freeze) 对 macOS 与 Linux 的渲染结果截图并上传，但 Windows 的 `freeze v0.2.2` 在各种传参方式下都会抛出 `No input` 错误，属于上游 Windows 兼容性 bug，因此对 Windows 仅收集 ANSI 字符日志以供 E2E 审查（下载 `e2e-windows-latest` 后 `cat` 查看）。

---

## License

MIT
