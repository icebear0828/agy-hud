# agy-hud Architecture

> **Version:** 0.3.4  
> **Last updated:** aligned to source as of v0.3.4

## Overview

agy-hud is a status-line plugin for the [Antigravity CLI](https://antigravity.google) (`agy`).
It renders a multi-line HUD in the terminal showing: current model, subscription tier, token usage, context-window fill, steps/tasks, breadcrumbs, and per-model quota bars.

agy invokes a registered `statusLine.command` once per agent step, piping a JSON payload on stdin. The HUD process must write rendered ANSI output to stdout and exit within ~1.5 s.

---

## Two-Layer Design

```
┌─────────────────────────────────────────────────────────────────────┐
│  PLUGIN LAYER  (staged by `agy plugin install`, lives in plugins/)  │
│   plugin.json · gemini-extension.json · skills/hud-config/         │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │  bootstrap.js downloads & installs
┌─────────────────────────────────▼───────────────────────────────────┐
│  RUNTIME LAYER  (~/.gemini/antigravity-cli/agy-hud-runtime/)        │
│   bin/agy-hud.js  ←  registered as statusLine.command              │
│   parser.js · config.js · encoding.js · paths.js · uninstall.js    │
│   statusline-installer.js · config-wizard.js                        │
│   quota.js (orchestrator) ──> quota/ (token · cache · cloud · models)│
│   renderer.js (orchestrator) ──> renderer/ (format · lang · quota-render)
└─────────────────────────────────────────────────────────────────────┘
```

The **plugin layer** is managed by `agy`'s plugin machinery (git clone / zip extract).  
The **runtime layer** is self-managed: `scripts/bootstrap.js` fetches each file from GitHub raw and performs an atomic rename-swap, then writes `statusLine` into `settings.json`.

---

## Module Dependency Graph

```
bin/agy-hud.js
  ├── parser.js        (getSessionState, parseAgyInput)
  │     └── paths.js   (resolveSafeExecutable, resolveAntigravityPath)
  ├── renderer.js      (renderHUD)
  │     ├── renderer/format.js
  │     ├── renderer/lang.js
  │     ├── renderer/quota-render.js
  │     └── encoding.js (supportsUnicode)
  ├── config.js        (loadConfig)
  ├── quota.js         (getQuota, getCachedTier, getCachedAccountEmail)
  │     ├── quota/token.js
  │     │     └── paths.js
  │     ├── quota/cache.js
  │     ├── quota/cloud.js
  │     │     └── config.js
  │     ├── quota/models.js
  │     └── paths.js
  └── paths.js

config-wizard.js
  ├── config.js
  └── renderer.js

scripts/bootstrap.js
  └── (self-contained; re-requires statusline-installer.js + quota.js from
       the freshly-installed runtimeDir after the atomic swap)

scripts/diagnose-auth.js
  ├── runtime/paths.js
  └── runtime/quota.js
```

---

## Execution Flow (per agent step)

```
agy agent step completes
  │
  ▼
agy reads settings.json → statusLine.command
  │
  ▼
spawn: node <runtimeDir>/runtime/bin/agy-hud.js
  │  stdin: JSON payload (or empty on Windows timing quirk)
  │
  ▼  bin/agy-hud.js  main()
  ├─ parse stdin → agyData  (parseAgyInput)
  ├─ derive transcriptPath from agyData or resolveAntigravityPath fallback
  │
  ├─ Promise.all([
  │    getSessionState(transcriptPath),   → state  (parser.js)
  │    loadConfig(),                      → config (config.js)
  │    getQuota({ fast: true }),          → quotaData (quota.js, from cache only)
  │    getCachedTier(),                   → tierName  (quota.js, from cache)
  │  ])
  │
  ├─ renderHUD(state, agyData, config, quotaData, tierName)  → ANSI string
  │
  └─ stdout.write(hudOutput) → process.exit(0)

Parallel (detached):
  quota.js --refresh → fetchQuotaFromCloud → writeCache  (background process)
```

**Hard timeout:** 1500 ms (`setTimeout` in `main()`). If neither `end` nor
enough data arrives, `handleInputAndRender()` runs anyway and renders with
whatever data is available.

---

## Data Flows

### Input: stdin JSON (agyData)
`parseAgyInput` does a single `JSON.parse`. Key fields used by `renderer.js`:

| Field | Used for |
|---|---|
| `transcript_path` | Passed to `getSessionState` |
| `conversation_id` | Fallback transcript path construction |
| `context_window.total_input_tokens` | Token bar numerator |
| `context_window.total_output_tokens` | Output tokens |
| `context_window.used_percentage` | Context bar fill % |
| `context_window.context_window_size` | Context bar denominator |
| `context_window.current_usage.*` | Per-turn in/out/cache breakdown |
| `model.display_name` / `model.id` | Model name display |
| `plan_tier` | Subscription tier fallback if no cached tier |
| `task_count` | Task counter (line 2) |

### State: transcript scan (getSessionState)
`parser.js` scans the JSONL transcript line-by-line:
- `step_index` → incremental max → `state.steps`
- `findContextWindow(entry)` → last `context_window` found → `state.usage` (fallback if stdin is empty)

Additional environment scan:
- `git rev-parse --abbrev-ref HEAD` → `state.branch`
- `path.basename(cwd)` → `state.currentDir`
- GEMINI.md / CLAUDE.md / MEMORY.md presence → `state.memoryFile`
- `.claude/rules`, `.cursor/rules`, `.github/rules`, `.gemini/rules` → `state.rulesCount`
- `settings.json` → `state.mcpCount` (agy + Claude Desktop combined)
- `.git/hooks` non-sample files → `state.hooksCount`

### Quota cache (quota.js)
```
getQuota({ fast: true })  [statusline hot path]
  ├── readToken()          → tok | null
  ├── readCachePayload(tok)→ payload
  ├── isCachePayloadFresh  → serve payload.data immediately
  ├── needsRefresh?        → triggerBackgroundRefresh() (detached spawn)
  └── readCacheFallback()  → stale data to prevent "Quota loading" flicker
```

Cache file: `resolveAntigravityPath('agy-hud-quota-cache.json')`  
Format: `{ version: 2, expiresAt, lastRefreshed, cacheKeyHash, tokenHash, tier, data: ModelQuota[] }`

---

## File Locations

| Path | Description |
|---|---|
| `~/.gemini/antigravity-cli/agy-hud-runtime/` | Runtime install root |
| `…/runtime/bin/agy-hud.js` | statusLine command target |
| `…/runtime/agy-hud.config.json` | Global default config |
| `<cwd>/agy-hud.config.json` | Project-level config (takes priority) |
| `~/.gemini/antigravity-cli/settings.json` | agy settings (statusLine written here) |
| `~/.gemini/antigravity-cli/agy-hud-quota-cache.json` | Quota cache (atomic write) |
| `~/.gemini/antigravity-cli/agy-hud-token.json` | Windows OAuth mirror (TTL 5 min) |
| `~/.gemini/antigravity-cli/agy-hud-error.log` | Error log (written on exception, mode 0600) |

---

## Platform Matrix

| Platform | Token source | sh shim | Node path in statusLine |
|---|---|---|---|
| macOS / Linux | `antigravity-oauth-token` (JSON file) | none | `process.execPath` (absolute) |
| Windows | Credential Manager → `agy-hud-token.json` mirror | `sh.cmd` / `sh.bat` in agy bin dirs | `.cmd` shim next to `agy-hud.js` |

---

## Key Design Decisions

1. **Stale-While-Revalidate (SWR) quota**: `getQuota({ fast: true })` never waits for network. Cache hit → serve immediately + background refresh. Cache miss → empty array + background refresh. Avoids blocking the statusline on every step.

2. **Atomic runtime update**: `bootstrap.js` writes all files to a `.tmp-<pid>-<ts>` directory, then `renameSync` swaps it into place. Concurrent readers never see a half-written runtime.

3. **Atomic cache write**: `writeCache` writes to `.tmp.<pid>` then `renameSync`. Prevents quota flicker from truncated reads during concurrent statusline renders.

4. **Windows .cmd shim**: A single-string command can't handle `"C:\Program Files\nodejs\node.exe"` quotes. The `.cmd` shim uses `%~dp0` for self-referencing and `||` for fallback — generated by `buildCmdShimContents()` in `statusline-installer.js`.

5. **`gemini-extension.json` is mandatory**: `agy plugin install` validates this file. Its absence causes `unsupported extension format`. Do not delete it.

6. **Bootstrap ≠ plugin install**: `agy plugin install` only stages `plugin.json` and skill files. The runtime JS files are downloaded and placed by `bootstrap.js` separately. This two-step design allows runtime updates independent of the plugin registry version.
