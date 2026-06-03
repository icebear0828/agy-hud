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
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  user@domain.com agy-hud ⎇ main                          │ Gemini 3.5 Flash(H) Google AI Pro                      
  ⚿ Tokens 253.2k (in: 126.6k, out: 17.5k, cache: 109.1k) │ ⛁ 126.6k/250k [█████░░░░░] 45%                         
  1 MEMORY.md                                             │ 🖼️ Image Quota: [█████░] 90% ~3h48m  3 rules • 1 hooks 
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Gemini 3.5 Flash(H)                [██████] 100% ~3h48m │ Gemini 3.1 Pro(L)                  [█████░]  80% ~3h48m
  Sonnet 4.6 (Thinking)              [███░░░]  50% ~4h48m │                                                        
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

### Compact（紧凑）模式
极度节省空间，将当前正在使用的模型额度百分比及重置倒计时直接嵌入到第一行右侧（模型名后面），同时在下方展示按 Provider 分组的极简迷你条。

```
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  user@domain.com agy-hud ⎇ main                          │ Gemini 3.5 Flash(H) Google AI Pro (Quota: 100% ~3h48m) 
  ⚿ Tokens 253.2k (in: 126.6k, out: 17.5k, cache: 109.1k) │ ⛁ 126.6k/250k [█████░░░░░] 45%                         
  1 MEMORY.md                                             │ 🖼️ Image Quota: [█████░] 90% ~3h48m  3 rules • 1 hooks 
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Other: Flash(H)███ Pro(L)██░ Sonnet██░ Gemini███
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

### 布局结构说明
- **双列网格对齐**：所有信息划分为左右两列，中间以垂直分隔符 `│` 隔离，各行的对齐线在纵向上像素级对齐。
- **第一行**（身份与状态）：
  - **左列**：登录用户名、当前工作目录及 Git 分支。
  - **右列**：当前模型与套餐 Tier。在**紧凑（Compact）模式**下，当前模型的剩余额度比例及重置时间会直接紧跟在此处。
- **第二行**（资源消耗）：
  - **左列**：Token 用量细分（含输入、输出及缓存——缓存为零时自动隐藏）。
  - **右列**：Context 窗口进度条与百分比。
- **第三行**（元数据与图片额度）：
  - **左列**：项目 Memory 文件或面包屑。
  - **右列**：Image Quota 进度条/超限倒计时，以及非零的 Rules、MCP 和 Hooks 计数（两列均为空时此行自动省略）。
- **额度框体**：账号内各模型的剩余额度比例及重置倒计时。整体 HUD 首尾与中间均用横线闭合成一个整洁、高一致性的框体。

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

# 直接手动运行 HUD 入口文件，应当能看到输出的状态行
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
4. 清理所有数据根目录及临时目录下的 payload、错误日志、临时 Token 镜像和 quota cache 缓存文件。

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
    "showCurrentDir": true,
    "showUsername": false,
    "username": "",
    "breadcrumbCount": 3,
    "useNerdFonts": false,
    "columnWidth": 40
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
  - `showCurrentDir`：是否在 HUD 中显示当前工作目录的文件夹名称。
  - `showUsername`：是否在 HUD 第一行显示用户名/登录邮箱。
  - `username`：自定义显示用户名以覆盖系统用户名或登录邮箱。
  - `breadcrumbCount`：导航栏中最多展示的文件项数。
  - `useNerdFonts`：开启后（设为 `true`），将使用 [Nerd Fonts](https://www.nerdfonts.com/) 的高保真开发者图标，体验更佳。
  - `columnWidth`：Table 模式下每一列的最大宽度（默认为 `40`）。
- **`thresholds`**：资源使用占比警戒线阈值（`0.0` 到 `1.0`），分别对应黄色的警告和红色的紧急状态。
- **`language`**：语言偏好选项（`"auto"`，`"en"`，`"zh"`）。

---

## 目录结构

```
agy-hud/
├── plugin.json                # {"name":"agy-hud"} — agy 插件标记文件
├── gemini-extension.json      # agy 远程安装验证器强制要求
├── runtime/                   # bootstrap 下载到 ~/.gemini/.../agy-hud-runtime/runtime/
│   ├── bin/agy-hud.js         # statusLine 入口（stdin JSON → ANSI HUD）
│   ├── config-wizard.js       # HUD 命令行配置向导（--config）
│   ├── config.js              # 全局/局部配置文件加载器
│   ├── encoding.js            # 控制台编码与 Unicode 检测器
│   ├── parser.js              # 工作区元数据扫描与 transcript 日志解析
│   ├── paths.js               # 跨平台路径解析工具集
│   ├── quota.js               # SWR 额度获取主协调器
│   ├── quota/                 # 额度与身份认证子模块 (PR #62)
│   │   ├── cache.js           # 原子化 JSON 缓存读写（v3 schema）
│   │   ├── cloud.js           # 额度与 OIDC 权威用户邮箱 HTTP 客户端
│   │   ├── models.js          # API 配额标准化与多窗口观察合并
│   │   └── token.js           # 跨平台 OAuth 访问令牌发现与 C# 读取
│   ├── renderer.js            # HUD 界面排版主协调器
│   ├── renderer/              # ANSI 终端渲染子模块 (PR #58)
│   │   ├── format.js          # ANSI 配色、大数进位及重置时长格式化
│   │   ├── lang.js            # 多语言（中文/英文）及本地化诊断支持
│   │   └── quota-render.js    # 配额进度条与单行双列对齐排版 (PR #61)
│   ├── statusline-installer.js# 向 settings.json 写入 statusLine 命令
│   ├── uninstall.js           # 清理与卸载 HUD 运行时文件
│   └── update-checker.js      # 检查新版本 Github Release 的微服务
├── scripts/
│   ├── install.sh             # 一行安装入口 — macOS/Linux
│   ├── install.ps1            # 一行安装入口 — Windows PowerShell
│   ├── bootstrap.sh           # 修复用入口（被 install.sh 调用）
│   ├── bootstrap.js           # 实际下载 + 配置逻辑
│   ├── configure-utf8.ps1     # 可选：Windows UTF-8 终端配置与 Git 编码助手
│   ├── verify-display.js      # E2E：安装 + 引导 + 模拟起 PTY agy 并断言 HUD 存在
│   └── diagnose-auth.js
├── tests/unit/                # 模块化单元测试目录 (node --test)
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

| 操作系统 | install.sh 成功运行 | bootstrap 写入 settings.json | HUD 独立命令正确生成状态行 |
|----|------|------|------|
| ubuntu-latest | ✅ | ✅ | ✅ |
| macos-latest  | ✅ | ✅ | ✅ |
| windows-latest | ✅ | ✅ | ✅ |

每次 CI 运行都会上传如下产物（保留 14 天）：

| 产物名称 | 分配平台 | 内容说明 |
|---|---|---|
| `e2e-<os>` | 包含全部三个系统 | 诊断日志 `e2e-report.json` + `agy-hud-pty-*.log`（富 ANSI 颜色转义代码的文件，`cat` 它即可在本地模拟看到带颜色 HUD） |
| `hud-screenshot-<os>` | ubuntu 与 macos | `hud-ascii-<os>.png` 和 `hud-unicode-<os>.png`，由 [charm.sh `freeze`](https://github.com/charmbracelet/freeze) 生成，您可以下载后直接用图片查看器预览渲染效果。 |

CI 在**无授权模式（no-auth）**下运行，只断言独立命令能正确输出状态行。带真实 Token 与账户数据的全套 E2E 集成验证通过 `release.sh` 在开发者本机进行。

---

## 已知问题

- **Windows 平台 PNG 截图限制**：CI 会使用 [charm.sh `freeze`](https://github.com/charmbracelet/freeze) 对 macOS 与 Linux 的渲染结果截图并上传，但 Windows 的 `freeze v0.2.2` 在各种传参方式下都会抛出 `No input` 错误，属于上游 Windows 兼容性 bug，因此对 Windows 仅收集 ANSI 字符日志以供 E2E 审查（下载 `e2e-windows-latest` 后 `cat` 查看）。

---

## License

MIT
