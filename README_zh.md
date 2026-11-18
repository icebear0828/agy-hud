# agy-hud

[![E2E](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml)
[![Release](https://img.shields.io/github/v/release/icebear0828/agy-hud)](https://github.com/icebear0828/agy-hud/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

> 为 **Antigravity CLI (`agy`)** 与 Claude Code 打造的实时状态栏插件。
> 采用严格 **TypeScript** + Node 原生 `--permission` 权限笼隔离架构（`fence.mjs` + `collector.mjs`），完整对齐 **claude-hud 0.15.3** 全量特性，并支持 Antigravity 多提供商配额高精度查询。

[English](./README.md) | [架构说明](./ARCHITECTURE.md)

---

## 运行环境要求

- **Node.js `>= 22.18.0`**（依赖 Node 原生 `--permission` 权限模型与 TS 类型剥离能力）

---

## 界面样式

### 开箱即用的 Full 预设与快捷切换
默认开启全套遥测信息（费用、输出速率、缓存倒计时、内存占用、环境配置数、工具、Skills、MCPs、子代理、待办与词元统计），也可随时通过 `/hud preset` 一键切换：
- `/hud preset minimal` — 回归清爽双行极简视图（`模型 / 项目` + `上下文 | 配额`）
- `/hud preset essential` — 核心工作区活动、待办、耗时与环境计数
- `/hud preset full` — 完整全量遥测（默认）

### Antigravity 多提供商扩展视图（`display.quotaStyle`）
可随时通过 `/hud set display.quotaStyle=table` 切换为 Antigravity 专属详细配额视图：
- **`table`**：Google / Claude（及 Argon）5h 与周配额 2x2 对照矩阵，精确到两位小数
- **`models`**：双列全模型实时配额对比条
- **`compact`**：按提供商分组的横向迷你进度条

### 核心功能一览
- **实时活动追踪**：增量解析 Claude / Antigravity transcript JSONL，显示正在/已完成的工具调用、激活的 `Skills`、MCP 服务状态与报错、子代理及其推理强度、待办进度、会话 Token 总量及 Prompt Cache 命中率。
- **VCS 与工作区增强**：Git 脏状态 / ahead-behind / 推送预警阈值 / 行级增删统计 / worktree / OSC 8 可点击链接、`jj` 版本控制支持、`pathLevels`、`launchDir`、`addedDirs`。
- **配额预警与花费统计**：`usagePace` 消耗速率预警、5 种时间格式、`externalUsagePath` 外部用量快照读写、当日及每周花费统计（支持按配额周期或自然日历周 `display.weeklyCostPeriod` 重置）。
- **全面自定义与本地化**：`expanded`/`compact` 布局、`elementOrder`、`projectLineOrder`、`mergeGroups`、`rightAlign`、256 色及 `#rrggbb` 十六进制配色、简体中文 / 繁體中文 / English 自动检测。
- **`/hud` 完整子命令体系**：`doctor`、`schema`、`preview`、`set`、`set --undo`、`report`、`install` 及终端交互配置向导（`--config`）。

---

## 一键安装

请在普通终端中执行——**切勿在正在运行的 `agy` 会话内安装**（`agy` 退出时可能会用内存态覆盖 `settings.json`）。

**macOS / Linux**:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.sh)
```

**Windows PowerShell**:
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.ps1 | iex
```

**Windows CMD**:
```cmd
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.ps1 | iex"
```

### 配置与诊断命令（`/hud`）

主配置文件位于 `~/.gemini/antigravity-cli/agy-hud/config.json`（首次运行自动平滑迁移 v0.3 旧版 `agy-hud.config.json`）。

```bash
HUD="$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs"
node "$HUD" schema               # 查询所有配置键名与默认值
node "$HUD" doctor               # 诊断运行环境、登录状态、配额与最近渲染心跳
node "$HUD" preview              # 预览当前配置渲染效果
node "$HUD" set display.quotaStyle=table display.showTools=true
node "$HUD" set --undo           # 撤销上一次修改
node "$HUD" --config             # 启动终端交互配置向导
```

### 一键卸载

**macOS / Linux**:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.sh)
```

**Windows PowerShell**:
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex
```

## License

MIT
