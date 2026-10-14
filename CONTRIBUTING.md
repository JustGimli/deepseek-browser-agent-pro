# Contributing to DeepSeek Browser Agent

Thank you for your interest in contributing! All contributions are welcome.

## Getting Started

```bash
git clone https://github.com/JustGimli/deepseek-browser-agent-pro
cd deepseek-browser-agent-pro
npm install
npx playwright install chromium
node src/index.js --interactive
```

## Project Structure

| File | Role |
|---|---|
| `src/agent.js` | Core agent loop — edit this to change how tasks run |
| `src/browser.js` | Playwright / DOM interaction with chat.deepseek.com |
| `src/parser.js` | Parses AI text responses into tool calls |
| `src/tools/` | Tools by area (`fs`, `shell`, `net`, `browser`); `index.js` is the registry |
| `src/mcp.js` | MCP client — registers tools of configured MCP servers |
| `src/prompt.js` | System prompt sent to DeepSeek |
| `src/config.js` | Configuration loading |

## Adding a New Tool

1. Open the matching module in `src/tools/` (or create one exporting `{ tools }` and spread it into `TOOLS` in `src/tools/index.js`)
2. Add an entry to its `tools` object following the existing pattern:

```js
my_new_tool: {
  description: 'What this tool does.',
  parameters: {
    param1: { type: 'string', required: true,  description: 'What param1 is' },
    param2: { type: 'number', required: false, description: 'What param2 is' },
  },
  async execute({ param1, param2 }, { signal }) {
    // your implementation; signal aborts when the user stops the task
    return 'result string';
  },
},
```

The tool is automatically included in the AI's system prompt — no other files need changing.

## Pull Request Guidelines

- One feature or bug fix per PR
- Keep the existing code style (single quotes, 2-space indent)
- Update `README.md` if you add a new tool or config option
- Run `npm test` and try your change manually before submitting

## Reporting Bugs

Open a GitHub issue and include:

- Your OS and Node.js version (`node --version`)
- The task you were running
- Full terminal output with `deepseek-agent --debug "your task"`
- Whether the DeepSeek web UI itself works normally in a regular browser

## Good First Issues

- Adding Windows path compatibility
- Writing a test suite
- Improving error messages
- Adding new tools (database access, image generation, etc.)

## Code of Conduct

Be respectful. Criticism of code is welcome; criticism of people is not.
