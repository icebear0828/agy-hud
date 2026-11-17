# Module Reference

> All paths are relative to the runtime install root:  
> `~/.gemini/antigravity-cli/agy-hud-runtime/`

---

## `runtime/bin/agy-hud.js` — Entrypoint

**Role:** Registered as `statusLine.command` in `settings.json`. Launched by `agy` once per agent step.

### `main()` (async)
- Checks `process.argv.includes('--config')` → delegates to `config-wizard.js::startWizard()`
- Sets a **1500 ms hard timeout** (`setTimeout(() => handleInputAndRender(), 1500)`)
- Collects stdin chunks, fires `handleInputAndRender()` on `end` or timeout
- Runs `Promise.all([getSessionState, loadConfig, getQuota, getCachedTier])`
- Calls `renderHUD(state, agyData, config, quotaData, tierName)`, writes to stdout
- On any exception: writes stack to `agy-hud-error.log` (mode 0600), then `process.exit(0)`

**Why `process.exit(0)` even on error?** Prevents agy from treating a failed statusline as a blocking error.

### stdin → agyData
`parseAgyInput(inputStr)` wraps `JSON.parse` in a try/catch. Returns `null` for empty or malformed input (Windows timing quirk — agy may invoke before payload is ready).

### Transcript path resolution
```js
agyData?.transcript_path ||
resolveAntigravityPath(path.join(
  'brain',
  agyData?.conversation_id || '',
  '.system_generated', 'logs', 'transcript.jsonl'
))
```

---

## `runtime/parser.js` — Session State

### `getSessionState(transcriptPath)` → `Promise<SessionState>`

Reads the JSONL transcript line-by-line (sync `readFileSync` inside an async function for simplicity — file is local and typically <1 MB). For each line:
- `JSON.parse(line)` — silently skips invalid lines
- Tracks max `entry.step_index` → `state.steps`
- `findContextWindow(entry)` → last match wins → `state.usage`

**`findContextWindow(value, depth=0)`**: Depth-limited (max 4) recursive object search. Returns the first object with any of: `total_input_tokens`, `total_output_tokens`, `context_window_size`, `used_percentage`, or an `isObject(value.current_usage)`.

**Git branch**: `execFileSync(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'])` with `cwd: process.cwd()`. Fails silently → defaults to `'main'`.

**Memory file detection order**: `GEMINI.md` → `CLAUDE.md` → `MEMORY.md` in cwd, then `~/.claude/projects/<projectKey>/memory/MEMORY.md`.

`projectKey` derivation:
```js
normalizedCwd.replace(/:/g, '').replace(/\//g, '-')
```

**Rules count**: Counts `.md` files in:
- `.claude/rules`, `.cursor/rules`, `.github/rules`, `.gemini/rules`

**Hooks count**: `git rev-parse --git-path hooks` → reads non-`.sample`, non-`.disabled` files.

**MCP count**: `settings.json` (`mcpServers` or `mcp` key) + Claude Desktop config (`claude_desktop_config.json`). Counts are **additive** (both sources merged).

### `parseAgyInput(jsonStr)` → `Object | null`
Thin wrapper: `JSON.parse(jsonStr)` or `null` on exception.

### `SessionState` shape
```js
{
  steps: number,
  branch: string,
  memoryFile?: string,       // filename only, not full path
  rulesCount: number,
  mcpCount: number,
  hooksCount: number,
  usage?: {                  // from transcript; mirrors agyData.context_window shape
    total_input_tokens?: number,
    total_output_tokens?: number,
    used_percentage?: number,
    context_window_size?: number,
    current_usage?: { input_tokens?, cache_read_input_tokens? }
  }
}
```

---

## `runtime/quota.js` — Quota & Token Orchestrator

**Role:** Orchestrates the stale-while-revalidate (SWR) fetching, caching, and token resolution for user account quota.

It delegates the core mechanics to its four specialized submodules under `runtime/quota/`:
- `token.js` — Discovery of token credentials across all platforms.
- `cache.js` — Atomic reading and writing of quota cache.
- `cloud.js` — Direct HTTP interactions with Google OpenID Connect and Cloud Code PA endpoints.
- `models.js` — Model discovery, quota normalization, and multi-window merging logic.

### `getQuota(options)` — SWR Orchestration
- Calls `token.js::readToken(options)`. If token is absent or invalid, returns cache fallback if transient parse error, or a `not_logged_in` diagnostic reason.
- Reads cache payload via `cache.js::readCachePayload(token)`.
- If cache is fresh (`cache.js::isCachePayloadFresh`), returns cached data immediately.
- If cache needs refresh (stale or token rotated), spawns a detached background process: `node runtime/quota.js --refresh` (throttled by last-refreshed timestamps).
- If token is expired, returns `expired_token` diagnostic.
- If no cache exists at all, falls back to any readable on-disk cache to prevent terminal flicker, else returns an empty array.

---

## `runtime/quota/token.js` — Token Discovery

Handles finding and parsing `antigravity` OAuth credentials on different systems.

### Methods
- `readToken(options)`: Resolves an active access token. On Windows, uses `agy-hud-token.json` mirror or prompts a Credential Manager lookup. On Unix/macOS, reads token files.
- `readWindowsCredentialTokens(credentialReader)`: Discovers credential items with targets `gemini:antigravity` or `LegacyGeneric:target=gemini:antigravity` from the Windows Credential Manager using a fast inlined C# P/Invoke helper script executed by PowerShell.
- `parseTokenPayload(raw)`: Normalizes `antigravity-cli` (nested under `token.access_token`) and legacy `oauth-creds` (directly under `access_token`) formats.
- `isTokenExpired(token)`: Checks if the token's remaining lifespan is less than 60 seconds.
- `anyTokenFileExists(roots)`: Quick check to distinguish a logged-out environment from a transient file lock / OAuth refresh state.

---

## `runtime/quota/cache.js` — Quota Cache & Keying

Maintains an on-disk JSON cache using a stable, token-independent identity key to avoid invalidating the cache upon token rotation (OAuth refresh).

### Schema v3
```json
{
  "version": 3,
  "expiresAt": 1716900000000,
  "lastRefreshed": 1716899880000,
  "cacheKeyHash": "<sha256 of cache identity>",
  "tokenHash": "<sha256 of access token for fallback>",
  "tier": "Google AI Pro",
  "accountEmail": "user@example.com",
  "data": [
    {
      "id": "gemini-3.5-flash-low",
      "displayName": "Gemini 3.5 Flash (Low)",
      "modelProvider": "MODEL_PROVIDER_GOOGLE",
      "remainingFraction": 0.85,
      "resetTime": "2026-05-31T10:00:00Z",
      "windows": {
        "fiveHour": {
          "remainingFraction": 0.85,
          "resetTime": "2026-05-31T10:00:00Z",
          "observedAt": 1716899880000
        },
        "weekly": {
          "remainingFraction": 0.50,
          "resetTime": "2026-06-03T10:00:00Z",
          "observedAt": 1716899880000
        }
      }
    }
  ]
}
```

### Methods
- `writeCache(data, token, tier, accountEmail)`: Writes the payload atomically by writing to `agy-hud-quota-cache.json.tmp.<pid>` first, then performing an atomic `fs.renameSync` with permission `0o600`.
- `readCachePayload(token)`: Matches cache based on `cacheKeyHash` (derived from token source format and file paths) or `tokenHash` (fallback).
- `getCachedAccountEmail(token)`: Returns the cached active email only when the cached identity matches the current token.
- `readCacheFallback()`: Serves any structurally valid cache on disk when the current identity lacks a cache, avoiding statusline loading flicker.

---

## `runtime/quota/cloud.js` — API Clients

Handles raw HTTP communication with Google PA and OIDC endpoints.

### API Endpoints
- **Quota Data:** `POST /v1internal:fetchAvailableModels`, `POST /v1internal:retrieveUserQuotaSummary`, and `GET https://aicode.googleapis.com/v1alpha:fetchQuotaStatus` (with built-in `HTTPS_PROXY` / `HTTP_PROXY` tunnel support)
- **Subscription Tier:** `POST /v1internal:loadCodeAssist`
- **Authoritative Account Identity:** Google OIDC UserInfo endpoints (`https://openidconnect.googleapis.com/v1/userinfo` tried first as it is reliable in proxied environments, fallback to `https://www.googleapis.com/oauth2/v3/userinfo`).

### Methods
- `fetchQuotaFromCloud(accessToken)`: Queries `fetchAvailableModels` with a 3-second abort timeout.
- `fetchTierFromCloud(accessToken)`: Queries `loadCodeAssist` and extracts the subscription tier.
- `fetchAccountEmail(accessToken)`: Resolves the signed-in account email directly using the active access token, ensuring the email is always authoritative after account switching (PR #62).

---

## `runtime/quota/models.js` — Quota Model Normalization

Handles model identification, mapping deprecations, and merging multi-window quota records.

### Methods
- `discoverAgentModelIds(apiResponse)`: Dynamically extracts supported model IDs from `agentModelSorts[0].groups[0].modelIds` inside the API response.
- `resolveDeprecatedIds(ids, response)`: Swaps deprecated model IDs for their newer replacements via `response.deprecatedModelIds`.
- `normalizeQuotaModels(models, interestingModelIds)`: Normalizes API responses into structured `ModelQuota[]`. Clamps `remainingFraction` to `0.0–1.0`.
- `classifyQuotaWindow(resetTime)`: Classes window targets into `fiveHour` (short duration) and `weekly` (long duration) buckets.
- `mergeQuotaWindows(previousCache, freshData)`: Aggregates new observations and previous cache. Because the API only returns one active quota window at a time, this routine ensures both 5-hour and weekly quotas remain preserved in the cache without overwriting each other.
- `pickCriticalWindow(windows)`: Determines which window has the lower available remaining fraction to surface for priority warnings.

---

## `runtime/renderer.js` — HUD Layout & Rendering Orchestrator

**Role:** The layout orchestrator that constructs the multi-line terminal HUD.

It integrates session states, Git branches, tokens, and quota data, delegation rendering tasks to three submodules under `runtime/renderer/`:
- `format.js` — Terminal colors, duration formatting, and token normalization.
- `lang.js` — Internationalization, label localization, and language detection.
- `quota-render.js` — Quota columns and provider-grouped progress bars.

### `renderHUD(state, agyData, config, quotaData, tierName)` → `string`
Produces a multi-line ANSI string with a deterministic structure:
```
[line 1] branch | model | plan
[line 2] tokens ctx-bar steps tasks [compact-quota]
[line 3] breadcrumbs | rules | MCPs | hooks  (optional, only non-zero items)
[divider]
[quota rows] (paired in two columns for table mode, or single-line for compact mode)
[divider]
\n
```

---

## `runtime/renderer/format.js` — Formatting Helpers

Provides pure, self-contained layout, styling, and color functions.

### Methods
- `colors`: Direct access to ANSI 8-color helper wrappers (`green`, `red`, `yellow`, `gray`, `cyan`, etc.).
- `abbreviateDisplayName(name)`: Strips verbose tags like `Family` or `Tier` to shorten model names (e.g., `Gemini 3.5 Flash (Low)` → `Gemini 3.5 Flash(L)`).
- `compactModelName(displayName)`: Generates ultra-shortened names for compact-mode grouping (e.g. `Gemini 3.1 Pro(L)` → `Pro(L)`).
- `formatTokens(tokens)`: Formats large numbers to units like `k` and `M` (e.g., `83724` → `83.7k`, `1000000` → `1.0M` without rounding spikes).
- `formatDuration(ms)`: Formats reset time remaining (e.g., `~3h22m`, `~6d4h`).
- `applyCacheSmoothing(inTokens, cacheRead)`: Smoothing adapter that gracefully handles temporary cache misses across execution cycles.

---

## `runtime/renderer/lang.js` — Internationalization

Manages locale parsing and text string mapping.

### Methods
- `resolveLanguage(langConf)`: Parses configuration or environment variables (`LC_ALL` > `LC_CTYPE` > `LANG`). Detects `zh` locales matching `/^zh(?:_|-|$)/i`, otherwise defaults to `en`.
- `PROVIDER_LABELS`: Maps model providers (`Google`, `Anthropic`, `OpenAI`).
- `LANGUAGE_TEXT`: Dictionary containing localized text for diagnostics, loading screens, and not-logged-in notices.

---

## `runtime/renderer/quota-render.js` —配额渲染器

Handles rendering quota progress bars and column pairs.

> [!NOTE]
> As of PR #61, the renderer has reverted to the clean, space-efficient single-row column layout. It displays the active binding quota directly rather than rendering separate rows for 5-hour and weekly buckets, preventing terminal vertical bloat.

### Methods
- `createQuotaRenderers(ctx)`: Instantiates a renderer context containing:
  - `renderQuotaColumn(q)`: Draws a single model quota column (`Name [█████░] 80% ~3h22m`). Uses theme-defined thresholds for color warnings.
  - `renderCompactQuotaLine(q)`: Outputs simplified mini bars per provider (e.g., `Anthropic: Son███ Opus█░░`).


Applied to **remaining** fraction (inverted from usage %):
- remaining ≤ `(1 - critThresh) * 100` → red
- remaining ≤ `(1 - warnThresh) * 100` → yellow  
- else → green

For context window (usage):
- usage > `critThresh * 100` → red
- usage > `warnThresh * 100` → yellow

### Icon Sets

Three tiers, selected by `useNerdFonts` then `unicode`:

| Icon | Nerd Font | Unicode | ASCII |
|---|---|---|---|
| branch | `` | `⎇` | `[B]` |
| plan | `󰌢` | `❖` | `[P]` |
| step | `` | `⚡` | `[S]` |
| task | `` | `✓` | `[T]` |
| token | `󰚩` | `⚿` | `[Tk]` |
| ctx | `󱔐` | `⛁` | `[C]` |
| model | `󰚗` | `🤖` | `[M]` |

All icons can be overridden via `config.icons.<key>`. Values are sanitized: OSC sequences, CSI sequences, and C0 control chars stripped; max 8 chars.

### Model Name Abbreviation

**`abbreviateDisplayName(name)`** — `ABBREVIATION_RULES`:
- `Gemini X.Y Family (Tier)` → `Gemini X.Y Family(T)`
- `Claude Family X.Y (Tier)` → `Family X.Y(T)`
- `GPT-OSS spec (Tier)` → `GPT-OSS spec`

**`compactModelName(displayName)`** — `COMPACT_NAME_RULES` (quota table compact mode):
- `Gemini … Flash/Pro (Tier)` → `Flash/Pro(T)`
- `Claude Family …` → `Family`
- `GPT-OSS …` → `GPT`

### Token Breakdown

```js
cacheRead = agyCurrentUsage.cache_read_input_tokens
          || usage.cache_read_input_tokens
          || transcriptCurrentUsage.cache_read_input_tokens
          || transcriptUsage.cache_read_input_tokens
          || 0

inTokens = agyCurrentUsage.input_tokens
         || transcriptCurrentUsage.input_tokens
         || max(0, totalInput - cacheRead)   // fallback

outTokens = totalOutput
tokenTotal = inTokens + outTokens + cacheRead
```

`firstNumber(...values)` returns the first `Number.isFinite` value.

### Quota Table (table mode)

Each model column:
```
<name padded to nameWidth>  [██████]  100%  ~2h30m
```
- `nameWidth = max(10, columnWidth - 21)` (21 = bar+pct+time chrome)
- Two columns per row, separated by `│`
- Divider lines: `─`.repeat(columnWidth * 2 + 1)

### Quota Compact (compact mode)

Groups models by provider (`PROVIDER_LABELS`). Per model: 3-char mini bar.
Also injects current-model quota inline on line 2 (`Quota: X%`).

### `modelNamesMatch(left, right)`

Normalizes both names via `simplifyModelName` then strips trailing `preview|experimental|beta|latest`. Exact match or prefix match (either direction).

### Language Support

Auto-detected from `config.language` or env (`LC_ALL` > `LC_CTYPE` > `LANG`):
- `zh` if locale matches `/^zh(?:_|-|$)/i`
- `en` otherwise

Affects `quotaUnavailable`, `quotaLoading`, and reason strings.

---

## `runtime/config.js` — Configuration

### `loadConfig()` → `Promise<Config>`

Resolution priority:
1. `<cwd>/agy-hud.config.json` (local, project-specific)
2. `<runtimeDir>/runtime/agy-hud.config.json` (global default)

Merges with `DEFAULT_CONFIG = { enabled: true, theme: 'default' }`.

### `saveConfig(config, isGlobal)` → `Promise<void>`

Writes to local or global path based on `isGlobal` flag.

### Default config file (`runtime/agy-hud.config.json`)
```json
{
  "theme": { "primary": "green", "secondary": "gray", "warning": "yellow", "critical": "red" },
  "display": { "showTokenBar": true, "showBreadcrumbs": true, "showGitBranch": true, "breadcrumbCount": 3, "useNerdFonts": false },
  "thresholds": { "warning": 0.7, "critical": 0.9 },
  "language": "auto"
}
```

---

## `runtime/encoding.js` — Unicode Detection

### `supportsUnicode()` → `boolean`

Cached singleton (module-level `_cached`). Calls `detectUnicodeSupport()` once.

### `detectUnicodeSupport(opts)` — Resolution order

1. `AGY_HUD_FORCE_ASCII=1` → `false`
2. `AGY_HUD_FORCE_UNICODE=1` → `true`
3. Windows: `chcp.com` → codepage `65001` → `true`, else `false`
4. Unix: `/utf-?8/i` in `LC_ALL|LC_CTYPE|LANG` → `true`; `POSIX` locale → `false`
5. Empty locale → `true` (modern terminal assumption)

**`readWindowsCodepage()`**: Runs `chcp.com` via `resolveSafeExecutable('chcp')`, parses first 3–5 digit sequence, 500 ms timeout.

---

## `runtime/paths.js` — Cross-Platform Path Resolution

### `getAntigravityRoots()` → `string[]`

Priority-ordered candidate list (nulls filtered):
1. `~/.gemini/antigravity-cli`
2. `$XDG_DATA_HOME/antigravity-cli`
3. `$APPDATA/antigravity-cli`
4. `$LOCALAPPDATA/antigravity-cli`

### `resolveAntigravityPath(relativePath)` → `string`

Searches roots in order; returns first existing file's joined path.
Falls back to `path.join(roots[0], relativePath)` (write target).

### `resolveSafeExecutable(name)` → `string | null`

- Windows special cases: `chcp` → `%SystemRoot%\System32\chcp.com`; `powershell` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
- Searches `PATH` entries, skipping: empty, `.`, relative paths
- Extensions: `.exe .cmd .bat` on Windows; no extension on Unix
- Returns first existing, is-a-file match

---

## `runtime/statusline-installer.js` — Settings & Shim Writer

### `configureStatusLine(baseDir, options)` → `{ settingsPath, command }`

1. `writeCmdShim(hudScriptPath)` — generates `.cmd` next to `agy-hud.js` (Windows only)
2. `ensureWindowsShShim()` — writes `sh.cmd`/`sh.bat` into agy bin dirs (Windows only)
3. Reads/creates `settings.json`, sets `settings.statusLine = { type: 'command', command }`
4. Writes only if `settings.statusLine.command !== targetCommand` (idempotent)

### `createStatusLineCommand(hudScriptPath, nodePath, platform)` → `string`

- Windows: `"<path>.cmd"` (quotes for spaces in path)
- Unix: `"<nodePath>" "<hudScriptPath>"`

### `buildCmdShimContents(hudScriptPath)` → `string`

Uses `path.win32.basename` so generated correctly even on Mac hosts (tests).
```batch
@echo off
setlocal
node "%~dp0agy-hud.js" %* 2>nul
if %ERRORLEVEL%==0 exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles%\nodejs\node.exe" "%~dp0agy-hud.js" %*
```

### `ensureWindowsShShim(platform, env)`

Target dirs: `$LOCALAPPDATA\agy\bin` + any PATH entry containing `agy.exe`.  
Safety: skips dirs containing `sh.exe` (Git Bash etc.) and skips files whose content doesn't match our shim exactly (won't overwrite third-party shims).

### `getWindowsAgyBinDirs(env)` → `string[]`

Returns deduplicated, resolved absolute paths.

---

## `runtime/config-wizard.js` — Interactive Config TUI

### `startWizard()` (async)

Full-screen interactive menu using raw TTY keypress events.

Menu items (toggled with Space/Enter, navigated with ↑/↓ or digit keys):
1. **Configuration Scope** — Local vs Global
2. **Theme Preset** — Emerald Green / Ocean Blue / Cyberpunk Magenta / Amber Gold / Custom (cycles)
3. **Quota Display Mode** — Table / Compact
4. **Icon & Font Set** — Nerd Fonts → Unicode Emoji → Plain ASCII (cycles)
5. **Show Git Branch** — Enabled/Disabled
6. **Show Token Bar** — Enabled/Disabled
7. **Show Breadcrumbs** — Enabled/Disabled
8. **Breadcrumb Limit** — 1–5 (cycles via `(val % 5) + 1`)
9. **Save & Exit** — calls `saveConfig`
10. **Cancel & Exit**

Live HUD preview rendered below menu using mock data (branch: main, steps: 12, Pro tier, sample quota).

---

## `runtime/uninstall.js` — Cleanup

### `uninstall(options)` → `results`

For each antigravity root:
1. `removeRuntimeDir(<root>/agy-hud-runtime)`
2. `clearStatusLine(<root>/settings.json, runtimeDir)` — only if command contains our runtimeDir path
3. `removeExtraFiles(root)` — `agy-hud-payload.json`, `agy-hud-token.json`, `agy-hud-quota-cache.json`, `agy-hud-error.log`, `hud/`

Global cleanup:
- `removeTokenMirrors()` — `os.tmpdir()/agy-hud-token.json` + quota cache (legacy locations)
- `removeWindowsShShims()` — deletes only our own `sh.cmd/sh.bat` (body match)

**Backup**: `clearStatusLine` copies `settings.json` → `settings.json.bak` before modifying.

---

## `scripts/bootstrap.js` — Runtime Installer

### `installRuntime(options)` → `Promise<result>`

1. `pickAntigravityRoot()` — finds root with `plugin.json` present, then with `settings.json`, else `roots[0]`
2. `cleanStalePluginFiles()` — removes `hooks.json`, `mcp_config.json`, and dirs `agents/commands/rules/extensions` from all plugin dirs (v0.1.x leftovers)
3. Downloads all `RUNTIME_FILES` to `.tmp-<pid>-<ts>/` — either from `AGY_HUD_SETUP_SOURCE_DIR` (local) or `requestBuffer(url)` (GitHub raw, with redirect following, https→http downgrade rejected)
4. `replaceRuntimeDirAtomically()` — backup → rename new → delete backup; rollback on error
5. Re-requires `statusline-installer.js` from new runtimeDir (clears require cache first)
6. `configureStatusLine()` → updates `settings.json`
7. `refreshQuotaCache()` — eager quota + tier fetch on install

### `RUNTIME_FILES` (11 files)
```
package.json
runtime/agy-hud.config.json
runtime/bin/agy-hud.js
runtime/config.js
runtime/encoding.js
runtime/parser.js
runtime/paths.js
runtime/quota.js
runtime/renderer.js
runtime/statusline-installer.js
runtime/uninstall.js
```

### `getPluginDirs(antigravityRoot, options)` — Plugin Directory Discovery

Searched in order:
1. `~/.gemini/config/plugins/agy-hud` (agy 1.0.x)
2. `<antigravityRoot>/plugins/agy-hud` (older agy builds)
3. `$XDG_CONFIG_HOME/gemini/plugins/agy-hud`
4. `$APPDATA/gemini/plugins/agy-hud`

---

## `scripts/diagnose-auth.js` — Auth Diagnostics

`buildAuthDiagnostic()` → JSON report (no token values):

```json
{
  "schemaVersion": 1,
  "platform": "...",
  "arch": "...",
  "node": "...",
  "home": "...",
  "cwd": "...",
  "agy": { "found": bool, "path": "...", "version": "..." },
  "antigravityRoots": [{ "path": "...", "exists": bool }],
  "tokenCandidates": [{
    "path": "...", "exists": bool, "readable": bool,
    "parseable": bool, "keys": [...], "sourceFormat": "..."
  }],
  "readToken": { "found": bool, "sourceFormat": "...", "hasExpiry": bool }
}
```

Run: `npm run diagnose` or `node scripts/diagnose-auth.js`

---

## `scripts/verify-display.js` — E2E Verifier

### `main()` (async)

1. Builds zip (unless `AGY_HUD_SKIP_BUILD=1`)
2. Starts local HTTP server serving `agy-hud.zip`
3. `agy plugin install <http://localhost:PORT/agy-hud.zip>`
4. Plants stale `hooks.json` (upgrade-from-v0.1.x simulation)
5. Runs `node bootstrap.js` with `AGY_HUD_SETUP_SOURCE_DIR=<projectRoot>`
6. **Observation phase**:
   - `AGY_HUD_E2E_NO_AUTH_OBSERVE=1` (CI): directly invokes `statusLine.command` with empty stdin
   - Otherwise: spawns `expect` (preferred) or `script` to allocate PTY, runs agy, sends "hello", waits for HUD render
7. `detectHudRender()` — checks for branch icon + context bar + steps + token breakdown patterns
8. Asserts: `hudVisible && statusLineReady && runtimeReady && staleCleaned`
9. Writes PTY bytes to `agy-hud-pty-<timestamp>.log` artifact

### `detectHudRender(...values)` — Detection Patterns

Strips ANSI, checks all of:
- Branch: `/(?:⎇||\\[B\\])\\s*\\S+/`
- Context: `/(?:⛁|󱔐|\\[C\\])\\s*\\d+(?:\\.\\d+)?[kM]?\\/\\d+/i`
- Steps: `/(?:⚡||\\[S\\])\\s*\\d+/`
- Tokens: `/(?:⚿|󰚩|\\[Tk\\]|Tokens)\\s*…\\d+/i`

### `renderTerminalScreen(value, width=160)`

Full VT100 emulator: handles `\r`, `\n`, CSI cursor movement (`H f A B C D K J`).
Used to render the PTY byte stream into a plain 2D text grid for pattern matching.
