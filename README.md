# agy-hud

[![E2E](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml)
[![Release](https://img.shields.io/github/v/release/icebear0828/agy-hud)](https://github.com/icebear0828/agy-hud/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

> Real-time statusline HUD plugin for **Antigravity CLI (`agy`)** & Claude Code.
> Built with strict **TypeScript**, native `node --permission` capability caging (`fence.mjs` + `collector.mjs`), full **claude-hud 0.15.3** feature parity, and real **Antigravity multi-provider quota** tracking.

[简体中文](./README_zh.md) | [Architecture](./ARCHITECTURE.md)

---

## Requirements

- **Node.js `>= 22.18.0`** (uses native `--permission` caging and Node TypeScript type-stripping)

---

## What It Looks Like

### Default Full Preset & Quick Preset Switching
Ships with full telemetry enabled out of the box (cost, speed, prompt cache, RAM, environment counts, active tools, skills, MCPs, subagents, todos, and session tokens). Switch anytime via `/hud preset`:
- `/hud preset minimal` — classic two-line compact view (`Model / Project` + `Context | Usage`)
- `/hud preset essential` — core activity, todos, duration, and config counts
- `/hud preset full` — full telemetry (default)

### Expanded Multi-Provider Quota Views (`display.quotaStyle`)
Switch anytime with `/hud set display.quotaStyle=table` (or `models` / `compact`):

- **`table`**: 2x2 Google / Claude (and Argon) 5-hour & weekly quota grid with 2-decimal precision
- **`models`**: 2-column per-model remaining quota bars
- **`compact`**: inline provider family mini progress bars (`Google: ... │ Anthropic: ...`)

### Full Feature Highlights
- **Session & Activity**: Real-time running/completed tools (`◐ Read`, `✓ Edit ×3`), active `Skills`, MCP server statuses/errors, subagents with reasoning effort, todos progress bar, session tokens breakdown, and prompt cache hit rate.
- **VCS & Workspace**: Git dirty/ahead/behind, unpushed commit warning/critical thresholds, per-file line diffs (`+N -M`), linked worktrees, OSC 8 clickable file/branch links, JJ (`jj:(bookmark*)`) support, `pathLevels`, launch dir breadcrumb (`launch › cwd`), and `addedDirs`.
- **Usage, Pace & Spend**: `usagePace` burn-rate color projection, 5 wall-clock/relative `timeFormat` modes, external usage snapshots (`externalUsagePath` / `externalUsageWritePath`), session/today/weekly spend tracking with calendar weekday resets (`display.weeklyCostPeriod`).
- **Customization**: `lineLayout` (`expanded` / `compact`), `elementOrder`, `projectLineOrder`, `mergeGroups`, `rightAlign`, preset / 256-color / `#rrggbb` hex colors, `en` / `zh-Hans` / `zh-Hant` / `auto` localization, ASCII/Unicode auto-detection.
- **`/hud` Subcommands**: `doctor`, `schema`, `preview`, `set`, `set --undo`, `report`, `install`, plus interactive TTY wizard (`--config`).

---

## Install

Run from a normal shell — **NOT** from inside an active `agy` session (`agy` may overwrite `settings.json` on exit).

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

### What the installer does
1. Verifies Node `>= 22.18.0` and cleanly re-installs `agy plugin install https://github.com/icebear0828/agy-hud.git`.
2. Downloads runtime + TypeScript logic modules into `~/.gemini/antigravity-cli/agy-hud-runtime/`.
3. Installs `~/.gemini/antigravity-cli/agy-hud/statusline.mjs` (plus Windows `.cmd` / `sh.cmd` shims) and writes `statusLine.command` into `~/.gemini/antigravity-cli/settings.json`.
4. Pre-warms Antigravity quota cache if OAuth credentials are available.

### Configuration (`config.json` / `/hud`)

Global user config lives at `~/.gemini/antigravity-cli/agy-hud/config.json` (with automatic migration from legacy v0.3 `agy-hud.config.json`).

Quick examples via CLI or `/hud` skill:
```bash
HUD="$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs"
node "$HUD" schema               # List all config keys & defaults
node "$HUD" doctor               # Inspect runtime, auth, quota & last render
node "$HUD" preview              # Preview HUD render
node "$HUD" set display.quotaStyle=table display.showTools=true
node "$HUD" set --undo           # Revert last change
node "$HUD" --config             # Launch interactive TUI configuration wizard
```

### Uninstall

**macOS / Linux**:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.sh)
```

**Windows PowerShell**:
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex
```

---

## Security Architecture

Logic under `src/**/*.ts` runs inside Node's `--permission` sandbox combined with `fence.mjs`:
- Allowed reads: only files explicitly named by `collector.mjs` (`config`, `transcript`, project metadata, stripped `src/`).
- Allowed writes: only `<configDir>/agy-hud/data/`.
- Forbidden inside `src/`: `child_process`, `http`/`https`/`net`, `fetch`, `eval`/`Function`, and OAuth credentials.

Run `npm test` and `npm run verify` to validate types, unit tests, architecture rules, escape probes, launcher behavior, and corpus fixtures.

## License

MIT
