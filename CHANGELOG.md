# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/).

---

## [1.1.2] — 2026-10-15

### Fixed
- `write_file` (and any tool call) failed with `tool_call block had invalid JSON: Unterminated string` when the content contained triple backticks (README code blocks, code that builds markdown): the ```` ```tool_call ```` block was cut at the first ```` ``` ```` inside the JSON string. The parser now finds the end of the JSON object with a string-aware scan
- Mid-stream reads cut right after a ```` ``` ```` inside a string are detected as incomplete and re-read
- The "looks like an unparsed tool call" re-ask was disabled once the whole chat (all tasks) passed `MAX_ITERATIONS - 2` replies; it now uses the current run's step
- Ctrl+U in the multi-line input put the cursor on the wrong line
- Fallback input mode (no TTY / short terminal) leaked a `close` listener per prompt (`MaxListenersExceededWarning` after 10 prompts)
- stdin was not paused again after the login "press Enter" prompt
- `npm run calibrate` saved its screenshot to `/tmp` (wrong on Windows); now uses the OS temp dir

### Changed
- Parser: one JSON scanner shared by tool-call extraction, mid-stream detection and loose JSON search; the separate ```` ```json ```` strategy is folded into the loose search
- Removed unused code: `ConversationManager.getLatestUserMessage` / `turnCount`, `buildSystemPrompt` and `toParameters` exports, logger `separator` / `jsonPreview`, `walk` `files` option, a duplicate send-button selector
- Logger strips ANSI codes with `util.stripVTControlCharacters`

---

## [1.1.1] — 2026-10-15

### Fixed
- A large tool call read while DeepSeek was still streaming was reported to the model as invalid JSON. Such reads are now detected as incomplete and re-read (up to 3 times) instead of costing a turn

---

## [1.1.0] — 2026-10-14

### Added
- Browser tools for the agent, in its own tab of the DeepSeek Chromium: `browser_open`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_wait`, `browser_eval`, `browser_tab`, `browser_close`. Actions return a snapshot with numbered elements (`ref`) to click / type into
- `browser_connect`: attach the browser tools to an external Chromium over CDP (e.g. an AdsPower profile)
- MCP client (stdio): servers from `mcpServers` in the config are started on launch and their tools exposed as `mcp__<server>__<tool>`
- Config: `WEB_TIMEOUT`, `mcpServers`, `MCP_START_TIMEOUT`, `MCP_CALL_TIMEOUT`
- System prompt sections on web/browser usage and MCP tools
- Missing required tool parameters are reported by name
- `run_command` `background: true` for dev servers / watchers: returns pid, log file and first output; background processes are stopped when the agent exits
- MCP servers start in parallel; optional per-server `"tools": [...]` allowlist
- Tests for file/shell tools, `read_url` and the MCP client

### Changed
- `src/tools.js` split into `src/tools/` (`index.js` registry, `fs`, `shell`, `net`, `browser`)
- `read_url` uses `fetch`, prefixes the HTTP status and final URL, and suggests `browser_open` for JS-rendered pages
- The "looks like an unparsed tool call" re-ask knows every tool name and is capped at 2 in a row
- `run_command` runs asynchronously: Esc / `/stop` kills the command (with its child processes), the UI stays responsive, output includes stderr
- `replace_in_file` requires `find` to match exactly once unless `all_occurrences: true` (default was replace-all) and errors on no match
- `read_file` always numbers lines and returns long files in whole-line chunks with the next `start_line` (was: first/last half of the file, middle cut)
- `find_files`, `search_in_files`, recursive `list_directory` and the start-up directory listing are pure Node — no shell `find` / `grep`, so patterns with quotes work and Windows is closer
- `search_in_files` matches the pattern as a regex or as plain text
- Browser actions (click/type/press/wait) return a shorter snapshot to save context
- Parser: one shared JSON → tool-call path for all strategies
- DeepSeek DOM selectors all live in `SEL` in `src/browser.js`; thinking-block stripping shared with the parser

### Removed
- Tools `append_to_file` (now `write_file` with `append: true`), `create_directory`, `move_file`, `copy_file`, `get_file_info` (one-liners via `run_command`)
- Parser strategy for XML tool calls with stripped angle brackets (the DOM never produces that text)

### Fixed
- `read_url` failed with `Invalid URL` when a server redirected with a relative `Location` header
- `replace_in_file` mangled replacements containing `$&` / `` $` `` / `$'` and over-reported the count with `all_occurrences: false`
- After `/resume`, a context rollover used the previous chat's task as "ORIGINAL TASK"

---

## [1.0.0] — 2026-10-07

First public release of `deepseek-browser-agent-pro`, a fork of
[Omar-Azam/deepseek-browser-agent](https://github.com/Omar-Azam/deepseek-browser-agent) (MIT).

### Inherited from the original project
- Browser automation via Playwright targeting chat.deepseek.com, no API key
- 15 built-in tools: file read/write/append/replace/delete/move/copy, directory listing/creation, shell commands, file search, grep, URL fetching, batch file writing
- Multi-strategy response parser (fenced blocks, JSON, XML, DOM-stripped XML, bare JSON, function calls)
- Interactive REPL, single-task mode, persistent login session
- `--calibrate`, `--debug`, `--headless`, `--save-log`, `--dir`, `dsa` alias
- Global (`~/.deepseek-agent/config.json`) and per-project (`deepseek-agent.config.json`) config

### Added
- Persistent bottom input box with slash-command menu, multi-line input, input history (`src/ui.js`)
- Slash commands: `/new_chat`, `/stop`, `/continue`, `/history`, `/resume <n>`, `/context`, `/headless on|off`, `/help`, `/exit`
- Esc stops the running task; messages typed while the agent works are delivered with the next step
- Chat history with `/history` and `/resume`
- Context tracking and automatic summarize-and-continue in a new chat at 90% of the limit (`CONTEXT_LIMIT`, `CONTEXT_ROLLOVER`)
- Auto-click Continue when DeepSeek shows "server temporarily unavailable" (`BUSY_MAX_RETRIES`, `BUSY_RETRY_DELAY`)
- DeepSeek native DSML tool-call format in the parser
- Markdown rendering in the terminal (headings, tables, code blocks, inline code)
- `--version` flag
- Unit tests for the response parser (`npm test`)
- `--headless` fails fast if login is required

### Changed
- Published on npm as `deepseek-browser-agent-pro`
- `MAX_ITERATIONS` default 40 → 300
- Loose parser strategies (JSON block, bare JSON, function call) only accept known tool names, so a final answer quoting e.g. a `package.json` is no longer treated as a tool call
- `postinstall` locates Playwright through Node resolution, so it works for global installs with hoisted dependencies
- Chromium is no longer started with `--no-sandbox`
- Debug screenshot goes to the OS temp dir instead of a hard-coded `/tmp`

### Fixed
- A failed task left the agent flagged as running, so Esc / Ctrl+C misbehaved afterwards
- Stale CLI help text (`npm run setup`, `node src/index.js`)

### Removed
- Unused parser helpers (`formatToolResult`, `isAskingQuestion`)

---

## Planned
- More tests (tools, agent loop)
- Windows compatibility (working-dir listing uses `find`)
- Better selector resilience for DeepSeek UI changes
- Support for additional AI frontends
- Plugin / custom tool system (MCP covers part of it)
