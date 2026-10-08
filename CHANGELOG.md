# Changelog

All notable changes to this project will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/).

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
- Plugin / custom tool system
