# agy-hud

[![E2E](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/icebear0828/agy-hud/actions/workflows/e2e.yml)
[![Release](https://img.shields.io/github/v/release/icebear0828/agy-hud)](https://github.com/icebear0828/agy-hud/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

> Real-time statusline HUD plugin for **Antigravity CLI (`agy`)**. Refreshes after every step with session info, detailed token breakdown, workspace context, and **real account quota** (matches `/usage` numbers).
>
> CI verifies install + HUD render on **macOS, Linux, Windows** on every push — green badge above means it works.

[简体中文](./README_zh.md)

---

## What it looks like

agy-hud supports two display modes for quota tracking: **Table Mode** (default) and **Compact Mode** (provider-grouped mini bars).

### Table Mode (Default)
Useful for detailed side-by-side comparison of multiple models' quota.

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

### Compact Mode
Highly space-efficient. It embeds the current model's remaining quota and reset countdown directly in the first line (next to model name), and displays provider-grouped mini progress bars.

```
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  user@domain.com agy-hud ⎇ main                          │ Gemini 3.5 Flash(H) Google AI Pro (Quota: 100% ~3h48m) 
  ⚿ Tokens 253.2k (in: 126.6k, out: 17.5k, cache: 109.1k) │ ⛁ 126.6k/250k [█████░░░░░] 45%                         
  1 MEMORY.md                                             │ 🖼️ Image Quota: [█████░] 90% ~3h48m  3 rules • 1 hooks 
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Other: Flash(H)███ Pro(L)██░ Sonnet██░ Gemini███
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

### Layout breakdown
- **Grid Alignment**: Information is structured in a two-column layout. The vertical divider `│` aligns perfectly across all data rows and quota tables.
- **Line 1** (identity & status): 
  - **Left column**: Username, current directory, and Git branch.
  - **Right column**: Current model and plan tier. In **Compact Mode**, the current model's remaining quota percent and reset countdown are shown here inline.
- **Line 2** (resource usage): 
  - **Left column**: Token usage breakdown (input, output, and cache — cache is hidden when zero).
  - **Right column**: Workspace context window progress bar and percentage.
- **Line 3** (metadata & image quota): 
  - **Left column**: Project memory file / breadcrumbs.
  - **Right column**: Image quota progress bar/exhausted status, along with rules, MCPs, and hooks count (only non-zero items shown; entire Line 3 is omitted if both columns are empty).
- **Quota rows**: Account quota by model (matches `/usage` exactly) with reset countdowns, enclosed in top and bottom divider lines to form a clean closed box frame.

---

## Install

One command, in a normal shell (NOT inside an active `agy` session):

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

This installer:
1. Cleanly re-installs the plugin (`agy plugin uninstall` + `agy plugin install`).
2. Downloads the HUD runtime to `~/.gemini/antigravity-cli/agy-hud-runtime/`.
3. Writes `statusLine.command` into `~/.gemini/antigravity-cli/settings.json`.

Open a fresh `agy` session — the HUD appears at the bottom of the terminal.

**Idempotent** — re-run the same command anytime to repair drift, upgrade, or clean stale files left by older versions.

### Why not a-single `agy plugin install`?

`agy plugin install` only stages the **declarative** plugin marker (`plugin.json`); it never executes JavaScript and never touches `settings.json`. The HUD's statusLine command and renderer runtime are configured separately. `install.sh` does both pieces atomically.

### For forks / mirrors

**macOS / Linux**:
```bash
AGY_HUD_REPO_RAW=https://raw.githubusercontent.com/your-fork/agy-hud/main \
AGY_HUD_REPO_URL=https://github.com/your-fork/agy-hud.git \
  bash <(curl -fsSL "$AGY_HUD_REPO_RAW/scripts/install.sh")
```

**Windows PowerShell**:
```powershell
$env:AGY_HUD_REPO_RAW = 'https://raw.githubusercontent.com/your-fork/agy-hud/main'
$env:AGY_HUD_REPO_URL = 'https://github.com/your-fork/agy-hud.git'
irm "$env:AGY_HUD_REPO_RAW/scripts/install.ps1" | iex
```

### Manual / advanced

If you prefer to run the steps yourself:

**macOS / Linux**:
```bash
agy plugin install https://github.com/icebear0828/agy-hud.git
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.sh)
```

**Windows PowerShell**:
```powershell
agy plugin install https://github.com/icebear0828/agy-hud.git
$t = Join-Path $env:TEMP "agy-hud-bootstrap.js"
Invoke-WebRequest -Uri https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js -OutFile $t -UseBasicParsing
node $t; Remove-Item $t
```

**Windows CMD**:
```cmd
agy plugin install https://github.com/icebear0828/agy-hud.git
powershell -Command "Invoke-WebRequest -Uri https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js -OutFile %TEMP%\agy-hud-bootstrap.js -UseBasicParsing"
node %TEMP%\agy-hud-bootstrap.js
del %TEMP%\agy-hud-bootstrap.js
```

---

## Verify

After bootstrap:

```bash
# settings.statusLine should point at the runtime
cat ~/.gemini/antigravity-cli/settings.json | grep statusLine -A2

# Direct HUD invocation should print the HUD status lines
node ~/.gemini/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.js
```

If quota rows show `Antigravity token expired`, refresh your `agy` login. That is **not** a bootstrap failure.

Windows PowerShell:

```powershell
Get-Content "$env:USERPROFILE\.gemini\antigravity-cli\settings.json"
& "$env:USERPROFILE\.gemini\antigravity-cli\agy-hud-runtime\runtime\bin\agy-hud.cmd"
```

---

## Diagnose

```bash
# Inspect token + quota cache state
node scripts/diagnose-auth.js

# Tail agy's own statusLine runner errors
ls -t ~/.gemini/antigravity-cli/log/cli-*.log | head -1 | xargs tail -50 | grep statusline
```

The most common failure mode is `statusline_runner.go: failure N/30` — that means `statusLine.command` in `settings.json` points to a path that no longer exists. Re-run bootstrap.

---

## Uninstall

**macOS / Linux**:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.sh)
```

**Windows PowerShell**:
```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex
```

**Windows CMD**:
```cmd
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/uninstall.ps1 | iex"
```

Or, if you have the repo cloned: `bash uninstall.sh` / `.\uninstall.ps1`.

This:
1. Clears `settings.json` `statusLine` (with `.bak` of the original).
2. Removes `~/.gemini/antigravity-cli/agy-hud-runtime/`.
3. Removes the staged plugin (`agy plugin uninstall agy-hud`).
4. Cleans payload, error log, tmp token mirror, and quota cache files across all roots and tmp directories.

---

## Configuration

Optional. Create `agy-hud.config.json` at the workspace root to override defaults. Without it the HUD uses `runtime/agy-hud.config.json` from the downloaded runtime:

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

### Configuration fields
- **`theme`**: Map of HUD component colors (`primary`, `secondary`, `warning`, `critical`). Supports standard terminal colors (`green`, `gray`, `yellow`, `red`, `blue`, `magenta`, `cyan`).
- **`display`**:
  - `quotaStyle`: `"table"` (default multi-column layout) or `"compact"` (inline quota + provider grouped mini bars).
  - `showTokenBar`: Whether to display the token bar.
  - `showBreadcrumbs`: Whether to display workspace file breadcrumbs.
  - `showGitBranch`: Whether to display the current Git branch.
  - `showCurrentDir`: Whether to display the base name of the current working directory.
  - `showUsername`: Whether to display the username/email at the start of the HUD statusline.
  - `username`: A custom string to override the resolved OS or login username/email.
  - `breadcrumbCount`: Number of files to show in breadcrumbs.
  - `useNerdFonts`: Set to `true` to use premium developer icons from [Nerd Fonts](https://www.nerdfonts.com/).
  - `columnWidth`: Max column width for the quota table layout (defaults to `40`).
- **`thresholds`**: Threshold values (`0.0` to `1.0`) for displaying quota warning and critical usage colors.
- **`language`**: Lang preference (`"auto"`, `"en"`, `"zh"`).

---

## File structure

```
agy-hud/
├── plugin.json                # {"name":"agy-hud"} — agy plugin marker
├── gemini-extension.json      # required by agy's remote-install validator
├── runtime/                   # downloaded by bootstrap to ~/.gemini/.../agy-hud-runtime/runtime/
│   ├── bin/agy-hud.js         # statusLine entry (stdin JSON → ANSI HUD)
│   ├── config-wizard.js       # configuration wizard (--config)
│   ├── config.js              # config loader & writer
│   ├── encoding.js            # console encoding & Unicode detector
│   ├── parser.js              # scans workspace metadata & session transcript
│   ├── paths.js               # cross-platform path resolution helpers
│   ├── quota.js               # SWR quota orchestrator
│   ├── quota/                 # quota & auth submodules (PR #62)
│   │   ├── cache.js           # atomic JSON caching (v3 schema)
│   │   ├── cloud.js           # API HTTP clients ( OIDC userinfo auth email)
│   │   ├── models.js          # quota normalizer & window merging
│   │   └── token.js           # cross-platform OAuth token discovery
│   ├── renderer.js            # HUD layout orchestrator
│   ├── renderer/              # ANSI rendering submodules (PR #58)
│   │   ├── format.js          # colors, abbreviator, duration formatting
│   │   ├── lang.js            # internationalization (zh/en auto-detection)
│   │   └── quota-render.js    # column bars & single-row columns (PR #61)
│   ├── statusline-installer.js# writes settings.json statusLine settings
│   ├── uninstall.js           # cleans and purges runtime files
│   └── update-checker.js      # checks for new GitHub releases
├── scripts/
│   ├── install.sh             # one-command installer — macOS/Linux
│   ├── install.ps1            # one-command installer — Windows PowerShell
│   ├── bootstrap.sh           # repair-only entry (called by install.sh)
│   ├── bootstrap.js           # actual download + configure logic
│   ├── configure-utf8.ps1     # optional Windows UTF-8 profile + Git encoding helper
│   ├── verify-display.js      # E2E: install + bootstrap + PTY-spawn agy + assert HUD
│   └── diagnose-auth.js
├── tests/unit/                # modular unit tests (node --test)
├── .github/workflows/e2e.yml  # cross-platform CI matrix
└── release.sh                 # npm test → E2E gate → zip → gh release
```

---

## Cross-platform notes

**Windows UTF-8 helper**: If your terminal is on a non-UTF-8 codepage and you want Unicode bars/borders by default, run:

```powershell
irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/configure-utf8.ps1 | iex
```

This appends a guarded UTF-8 encoding block to your PowerShell profile and sets Git's global UTF-8 filename/log options. It is idempotent and safe to re-run. Restart PowerShell after it finishes.

**Windows token refresh**: Antigravity CLI stores OAuth `refresh_token` + `access_token` in Credential Manager (`gemini:antigravity` / `LegacyGeneric:target=gemini:antigravity`). The HUD prefers a short-lived `agy-hud-token.json` mirror in tmp. When the fast path only sees a missing/expired file token, it triggers a detached background read; the next render uses the refreshed token. agy-hud does **not** swap RT for access tokens — if the Credential Manager access token is expired, refresh agy's login first.

**File token fallback paths** (searched in order):
- `~/.gemini/antigravity-cli/antigravity-oauth-token`
- `$XDG_DATA_HOME/antigravity-cli/antigravity-oauth-token`
- `$APPDATA/antigravity-cli/antigravity-oauth-token`
- `$LOCALAPPDATA/antigravity-cli/antigravity-oauth-token`

---

## Verified by CI

Every push to `main` runs [.github/workflows/e2e.yml](./.github/workflows/e2e.yml) against a 3-OS matrix:

| OS | install.sh runs | bootstrap writes settings.json | HUD command renders status lines |
|----|------|------|------|
| ubuntu-latest | ✅ | ✅ | ✅ |
| macos-latest  | ✅ | ✅ | ✅ |
| windows-latest | ✅ | ✅ | ✅ |

Each run uploads (14-day retention):

| Artifact | Per-OS | Contents |
|---|---|---|
| `e2e-<os>` | all 3 | `e2e-report.json` (diagnostic: `ok`, `hudVisible`, `staleCleaned`, …) + `agy-hud-pty-*.log` (raw ANSI bytes — `cat` to see the HUD render with colors) |
| `hud-screenshot-<os>` | ubuntu + macos | `hud-ascii-<os>.png` + `hud-unicode-<os>.png` rendered via [charm.sh `freeze`](https://github.com/charmbracelet/freeze). PNG visual evidence — download and open. |

CI runs in **no-auth mode**: it asserts the standalone HUD command renders the status lines. The full "HUD visible inside a live `agy` session with model-step trigger" check runs on dev machines (with real OAuth) via `release.sh`'s built-in E2E gate.

---

## Known issues

- **Windows PNG screenshot**: every CI run uploads `hud-ascii-*.png` and `hud-unicode-*.png` for macOS + Linux via [charm.sh `freeze`](https://github.com/charmbracelet/freeze). Windows is skipped — `freeze v0.2.2` errors `No input` for every invocation form (positional file, `--execute`, UTF-8 file via `.WriteAllText`) we tried; it's an upstream Windows bug. Windows reviewers still get the raw ANSI bytes via the `e2e-windows-latest` artifact (`cat` it to see the HUD with colors).

> **Note for Windows users**: The HUD auto-detects your active console codepage. If it's a non-UTF-8 codepage like `cp936` (GBK) or `cp1252`, the progress bar will fall back to ASCII characters (`#`) to prevent encoding corruption.
>
> If you force Unicode rendering (e.g. by setting `display.unicode: true` in your configuration) while the active codepage is not UTF-8, you may see garbled text or `?` replacement characters.
>
> **How to enable beautiful Unicode progress bars and borders on Windows:**
> 1. **PowerShell helper (Recommended)**: Run `irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/configure-utf8.ps1 | iex`, then restart PowerShell.
> 2. **Per Session**: Run `chcp 65001` once in your Command Prompt / PowerShell window before opening `agy`.
> 3. **System-wide UTF-8 (Permanent)**:
>    - Go to Windows Settings -> **Time & language** -> **Language & region** -> **Administrative language settings**.
>    - Click **Change system locale**.
>    - Check **"Beta: Use Unicode UTF-8 for worldwide language support"** and restart your computer.
>    - This forces all terminal sessions to use UTF-8 (`cp65001`) natively.

---

## License

MIT
