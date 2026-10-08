<div align="center">

<a href="https://www.npmjs.com/package/deepseek-browser-agent-pro"><img src="https://img.shields.io/npm/v/deepseek-browser-agent-pro?style=for-the-badge&color=blue" alt="npm version"/></a>
<img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=for-the-badge" alt="Node.js"/>
<img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="License"/>
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge" alt="PRs Welcome"/>

# 🤖 DeepSeek Browser Agent Pro

**An autonomous AI coding agent that runs entirely for free — no API key required.**

It drives a real browser to talk to [DeepSeek](https://chat.deepseek.com), giving you a Claude Code / Cursor-style coding agent powered by DeepSeek's models at zero cost.

[Installation](#-installation) · [Quick Start](#-quick-start) · [Usage](#-usage) · [Interactive commands](#-interactive-commands) · [Configuration](#-configuration) · [Tools](#-available-tools) · [Contributing](#-contributing)

---

> ⚠️ **Early release.** The agent drives the DeepSeek web UI, which can change without notice. If it breaks, run `deepseek-agent --calibrate` and open an issue.
>
> Based on [Omar-Azam/deepseek-browser-agent](https://github.com/Omar-Azam/deepseek-browser-agent) (MIT) — adds an interactive input box, chat history/resume, automatic context rollover, auto-retry on "server busy", and more. See the [changelog](./CHANGELOG.md).

</div>

---

## 🧠 How It Works

Most AI coding agents talk to a paid API. This one doesn't.

Instead, it uses **Playwright** to control a real Chromium browser, navigates to `chat.deepseek.com`, sends your task, waits for the response, and parses it to extract tool calls — all automatically. Your local files and terminal are wired up as tools the AI can use, so it can read code, write files, run commands, and build complete projects step by step.

```
Your Terminal
     │
     ▼
 Agent Core          ← orchestrates the loop
     │
     ├──► Browser (Playwright)  ← talks to chat.deepseek.com
     │         │
     │    DeepSeek AI  ← thinks, decides what tool to use
     │         │
     └──► Tool Executor  ← reads/writes files, runs commands
              │
         Your Project
```

---

## 📦 Installation

```bash
npm install -g deepseek-browser-agent-pro
```

> Chromium downloads automatically after install (~150 MB, one time only).
> If it was skipped (CI, offline): `npx playwright install chromium`.

**Requirements:** Node.js ≥ 18, a free [DeepSeek](https://chat.deepseek.com) account.

---

## 🚀 Quick Start

**1. First run — log in to DeepSeek:**
```bash
deepseek-agent --interactive
```
A browser window opens. Log in to your DeepSeek account, then come back to the terminal and press **Enter**. Your session is saved — you only do this once.

**2. Give it a task:**
```bash
deepseek-agent "build a REST API in Express with user authentication"
```

**3. Use the short alias `dsa` from any project folder:**
```bash
cd ~/my-project
dsa "add input validation to all my API routes"
```

---

## 💻 Usage

```
deepseek-agent [OPTIONS] [TASK]

  -t, --task <task>    Task to run (or just type it as the last argument)
  -i, --interactive    Keep browser open, run multiple tasks in a session
  -d, --dir <path>     Set working directory (default: current directory)
  --debug              Print raw AI responses to the terminal
  --headless           Run browser invisibly (requires prior login)
  --save-log           Save full session log to ~/.deepseek-agent/logs/
  --calibrate          Print DOM info to help fix selectors (run if the agent breaks)
  -v, --version        Print version
  -h, --help           Show help

Aliases:
  dsa                  Short form of deepseek-agent
```

### Examples

```bash
# Single task — runs and exits
deepseek-agent "create a Python script that scrapes Hacker News"

# Interactive mode — keeps browser open between tasks
deepseek-agent --interactive

# Run on a specific project
dsa --dir ~/projects/my-app "refactor all callbacks to async/await"

# Debug mode (shows what DeepSeek is actually outputting)
dsa --debug "build a calculator"

# Headless mode (faster — browser runs in background)
dsa --headless "write unit tests for utils.js"

```

---

## ⌨️ Interactive commands

In `--interactive` mode the input box stays at the bottom of the terminal. Type `/` to open the command menu (↑↓ select, Tab fills, Enter runs). **Alt+Enter** or a trailing `\` adds a new line. While the agent works, **Esc** stops it, and anything you type is delivered with the next step.

| Command | What it does |
|---|---|
| `/new_chat` | Start a fresh DeepSeek chat |
| `/stop` | Stop the running task (or press Esc) |
| `/continue` | Keep going after the step limit |
| `/history` | List saved chats |
| `/resume <n>` | Reopen chat number *n* from `/history` |
| `/context` | Show estimated context usage |
| `/headless on` / `/headless off` | Restart the browser invisibly / with a window |
| `/help` | Show the list |
| `/exit` | Quit |

When the chat reaches 90% of the context limit, the agent asks DeepSeek for a summary and continues in a new chat automatically.

---

## ⚙️ Configuration

### Global config — applies everywhere

Create `~/.deepseek-agent/config.json`:

```json
{
  "HEADLESS": true,
  "MAX_ITERATIONS": 50,
  "STABLE_DELAY": 3000,
  "DEBUG": false
}
```

### Per-project config — overrides global

Drop `deepseek-agent.config.json` in your project root:

```json
{
  "MAX_ITERATIONS": 60,
  "MAX_OUTPUT_LENGTH": 12000
}
```

### All settings

| Setting | Default | Description |
|---|---|---|
| `DEEPSEEK_URL` | `https://chat.deepseek.com` | Chat page to automate |
| `HEADLESS` | `false` | Hide the browser window |
| `MAX_ITERATIONS` | `300` | Max agent steps per task before stopping |
| `RESPONSE_TIMEOUT` | `180000` | Max ms to wait for a response (3 min) |
| `STABLE_DELAY` | `2500` | Ms of silence that means DeepSeek is done |
| `SEND_DELAY` | `400` | Ms between typing and pressing Enter |
| `BUSY_MAX_RETRIES` | `20` | Auto-clicks of Continue on "server unavailable" before failing |
| `BUSY_RETRY_DELAY` | `3000` | Ms to wait after each Continue click |
| `CONTEXT_LIMIT` | `128000` | Model context size (tokens, estimated) |
| `CONTEXT_ROLLOVER` | `0.9` | Fraction of the limit at which the chat is summarized and restarted |
| `WORKING_DIR` | current dir | Project the tools operate on (same as `--dir`) |
| `MAX_OUTPUT_LENGTH` | `8000` | Truncate long command outputs sent to AI |
| `DEBUG` | `false` | Print raw AI responses to terminal |
| `SESSION_DIR` | `~/.deepseek-agent/session` | Where browser cookies are saved |

---

## 🛠️ Available Tools

The agent can use these tools autonomously to complete your task:

| Tool | Description |
|---|---|
| `read_file` | Read a file's contents, optionally by line range |
| `write_file` | Create or overwrite a file (auto-creates directories) |
| `append_to_file` | Append text to an existing file |
| `replace_in_file` | Find and replace text in a file (regex supported) |
| `delete_file` | Permanently delete a file |
| `list_directory` | List directory contents, optionally recursive |
| `create_directory` | Create a directory and all parents |
| `move_file` | Move or rename a file or directory |
| `copy_file` | Copy a file to a new location |
| `get_file_info` | Get file metadata (size, line count, dates) |
| `run_command` | Execute any shell command |
| `find_files` | Find files by name pattern (e.g. `*.ts`) |
| `search_in_files` | Search text inside files (like `grep -r`) |
| `read_url` | Fetch and read the content of a URL |
| `write_files` | Write multiple files at once (batch scaffold) |

---

## 📂 Where Data is Stored

Everything lives in `~/.deepseek-agent/` in your home directory:

```
~/.deepseek-agent/
├── session/        ← Browser cookies (login once, runs forever)
├── logs/           ← Session logs (only saved with --save-log)
├── history.json    ← Chats for /history and /resume
└── config.json     ← Your global settings (optional)
```

---

## 🔧 Troubleshooting

### Agent responds but creates no files
The browser DOM rendered the AI's response in a way the parser didn't catch. Run with `--debug` to see exactly what's being received:
```bash
deepseek-agent --debug "build a calculator"
```

### Agent stops responding / loops
DeepSeek's UI may have changed. Run the calibration tool — it inspects the live DOM and prints updated selectors:
```bash
deepseek-agent --calibrate
```

### Login session expired
Just run without `--headless` — the browser opens and you log in again:
```bash
deepseek-agent --interactive
```

### `--headless` says login is required
Headless needs a saved login. Run `deepseek-agent --interactive` (without `--headless`) once first.

### Chromium didn't download automatically
```bash
npx playwright install chromium
```

### Response times out on long tasks
Increase the timeout in your config:
```json
{ "RESPONSE_TIMEOUT": 300000, "STABLE_DELAY": 4000 }
```

---

## 🗂️ Project Structure

```
deepseek-browser-agent-pro/
├── src/
│   ├── index.js          ← CLI entry point and argument parsing
│   ├── agent.js          ← Core agent loop (send → wait → parse → execute)
│   ├── browser.js        ← Playwright controller for chat.deepseek.com
│   ├── tools.js          ← All 15 filesystem and shell tools
│   ├── parser.js         ← Extracts tool calls from AI responses (6 strategies)
│   ├── prompt.js         ← System prompt and conversation history manager
│   ├── config.js         ← Configuration loader (global + per-project)
│   ├── logger.js         ← ANSI-colored terminal output + markdown rendering
│   ├── ui.js             ← Persistent bottom input box and command menu
│   ├── calibrate.js      ← DOM selector inspector
│   └── postinstall.js    ← Auto-downloads Chromium after npm install
├── test/                 ← node:test unit tests (npm test)
├── CHANGELOG.md
├── LICENSE
├── README.md
└── package.json
```

---

## 🤝 Contributing

Contributions are very welcome — there's plenty of room to grow.

### Setting up locally

```bash
git clone https://github.com/JustGimli/deepseek-browser-agent-pro
cd deepseek-browser-agent-pro
npm install          # also downloads Chromium
npm test
node src/index.js --interactive
```

### Areas that need work

- 🧪 **Tests** — only the response parser is covered so far; tools and the agent loop need tests
- 🎨 **UI selector resilience** — DeepSeek updates their UI occasionally; better selector strategies are welcome
- 🔌 **More tools** — image generation, browser control, database tools, etc.
- 🌐 **Other AI frontends** — adapting the browser layer to work with other free AI chats
- 📦 **Windows support** — currently tested on Linux; Windows path handling may need fixes
- 📝 **Better error messages** — making failures easier to diagnose

### How to contribute

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-improvement`
3. Make your changes
4. Open a Pull Request with a clear description

Please keep PRs focused — one feature or fix per PR makes review much faster.

### Reporting bugs

Open an issue on GitHub with:
- What you ran
- What you expected
- What actually happened
- Output of `deepseek-agent --debug "your task"` if relevant

---

## ⚠️ Disclaimer

This project automates a web browser to interact with chat.deepseek.com. Automating web UIs may violate the terms of service of the website being automated. Use this tool for **personal and development purposes only**. The agent can run arbitrary shell commands and modify files in your working directory — run it in projects you can restore (e.g. under git). The authors take no responsibility for account suspensions, data loss or other consequences of use. Not affiliated with DeepSeek.

---

## 📄 License

MIT — see [LICENSE](./LICENSE). Original work © Omar Azam; modifications © JustGimli.

---

<div align="center">

**Built with Playwright · Powered by DeepSeek**

If this project helped you, consider giving it a ⭐ on GitHub!

</div>
