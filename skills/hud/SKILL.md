---
name: hud
description: Configure, preview, diagnose, install, and troubleshoot agy-hud via /hud subcommands (`doctor`, `schema`, `preview`, `set`, `--undo`, `report`, `install`).
---

# `/hud` — agy-hud Control & Diagnostics

When the user invokes `/hud` (with or without arguments), run the installed HUD runner using Node 22.18+.

## Locate the runner

```bash
HUD="$HOME/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs"
[ -f "$HUD" ] || HUD="$HOME/.gemini/config/plugins/agy-hud/hud.mjs"
```

Do not guess config keys from memory — query `schema` first.

## Subcommands

| User intent | Command |
| --- | --- |
| Diagnose setup, runtime, quota & config | `node "$HUD" doctor` |
| List config keys or search by keyword | `node "$HUD" schema [words...]` |
| Preview HUD layout with optional overrides | `node "$HUD" preview [key=value ...]` |
| Change one or more settings in `config.json` | `node "$HUD" set <key>=<value> [...]` |
| Revert a key or reset entire config | `node "$HUD" set --reset [<key>]` |
| Undo the last `hud set` | `node "$HUD" set --undo` |
| Generate scrubbed bug-report JSON | `node "$HUD" report` |
| Re-register statusLine launcher in `settings.json` | `node "$HUD" install [--replace]` |
| Interactive terminal setup wizard (requires TTY) | `node "$HUD" --config` |

## Common Antigravity & Layout Tips

- **Quota view styles** (`display.quotaStyle`):
  - `"minimal"` (default): compact `claude-hud`-aligned 2-line HUD (`Context ... │ Usage ...`)
  - `"table"`: adds the 2x2 Google / Claude (and Argon) 5h & weekly table below line 2
  - `"models"`: adds 2-column per-model quota breakdown bars
  - `"compact"`: adds inline provider family mini bars
- **Compact single-line mode**: `node "$HUD" set lineLayout=compact`
- **Language**: `node "$HUD" set language=zh-Hans` (or `zh-Hant`, `en`, `auto`)
- **Capability-only keys** (`display.externalUsagePath`, `display.externalUsageWritePath`) cannot be modified via `hud set` for sandbox safety; instruct the user to edit `config.json` directly if needed.

Present command outputs concisely, highlight any items in `findings`, and render previews or reports verbatim inside a fenced block when requested.
