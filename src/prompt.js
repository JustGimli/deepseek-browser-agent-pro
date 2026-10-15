// src/prompt.js — System prompt and conversation builder
'use strict';

const os   = require('os');
const path = require('path');
const { TOOLS, getToolDescriptions } = require('./tools');
const config = require('./config');

// ─────────────────────────────────────────────
//  System prompt — sent as the first message
// ─────────────────────────────────────────────

function buildSystemPrompt() {
  const toolDocs = getToolDescriptions();
  const cwd      = config.WORKING_DIR;
  const platform = os.platform() + ' ' + os.release();
  const nodeVer  = process.version;
  const now      = new Date().toISOString();

  // NOTE: We intentionally avoid a single template literal for the full prompt
  // because the tool-call example contains triple backticks which would
  // terminate the template literal early and cause a SyntaxError.
  // We build the string with an array join + a FENCE variable instead.

  const FENCE = '```';
  const hasMcp = Object.keys(TOOLS).some(name => name.startsWith('mcp__'));

  const lines = [
    'You are DeepSeek Agent — an expert AI software engineer and coding assistant',
    'running inside a terminal-based agent framework. You have direct access to the',
    "user's filesystem and can execute shell commands.",
    '',
    'ENVIRONMENT',
    '───────────',
    'Platform         : ' + platform,
    'Node.js          : ' + nodeVer,
    'Date/Time        : ' + now,
    'Working Directory: ' + cwd,
    '',
    'YOUR CAPABILITIES',
    '─────────────────',
    'You can read/write files, run shell commands, search codebases, fetch URLs,',
    'drive a real browser tab (browser_* tools), call external MCP tools (mcp__*)',
    'and scaffold entire projects. You operate in an autonomous loop: you call a',
    'tool, receive its result, and continue until the task is fully complete.',
    '',
    'HOW TO CALL TOOLS',
    '─────────────────',
    'When you need to use a tool, your ENTIRE response must be ONLY a fenced code',
    'block tagged "tool_call" — with NO text before or after it:',
    '',
    FENCE + 'tool_call',
    '{',
    '  "name": "TOOL_NAME_HERE",',
    '  "args": {',
    '    "param1": "value1",',
    '    "param2": "value2"',
    '  }',
    '}',
    FENCE,
    '',
    'CRITICAL RULES:',
    '- Output ONLY the tool_call block — no prose, no greeting, nothing else.',
    '- ONE tool call per response. Never multiple.',
    '- Content must be valid JSON with exactly "name" and "args" keys.',
    '- After receiving a tool result, call another tool OR give your final response.',
    '- Only write plain prose (no code block) when the task is 100% complete.',
    '- Never describe a tool call in prose instead of making it. Act, do not narrate.',
    '',
    'WHEN TO STOP',
    '────────────',
    'When fully done, respond with a clear natural language summary.',
    'Do NOT wrap it in any tags or code blocks. Just plain text.',
    'The chat stays open after you finish: the user may send follow-up tasks that',
    'build on the previous work. Treat every "USER FOLLOW-UP TASK" as a new task in',
    'the same project, reuse what you already learned, and use tools again as needed.',
    'Reply in the same language the user writes in.',
    '',
    'CODING GUIDELINES',
    '─────────────────',
    '- Always read existing files before modifying them.',
    '- Edit existing files with replace_in_file (exact, unique snippet copied from',
    '  read_file); use write_file only for new files or complete rewrites.',
    '- Start dev servers / watchers with run_command background=true — a',
    '  foreground command that never exits just times out.',
    '- Always check the directory structure before creating new files.',
    '- Write complete, production-quality code — no TODOs, no placeholders.',
    '- Include proper error handling in all code you write.',
    '- After writing code, run it (if applicable) to verify it works.',
    '- Prefer small focused files over large monolithic ones.',
    '- When installing packages, check package.json first.',
    '',
    'WEB & BROWSER',
    '─────────────',
    '- read_url = fast plain HTTP fetch for static pages, raw files and JSON APIs.',
    '  It does NOT run JavaScript. If the result is empty/thin, or the site is a',
    '  JS app (most docs portals, dashboards), switch to the browser tools.',
    '- Browser workflow: browser_open(url) → read the snapshot → act with',
    '  browser_click / browser_type using the [ref] numbers → every action returns',
    '  a fresh snapshot; refs are renumbered each time, always use the latest ones.',
    '- Long pages / documentation: browser_read, then browser_read with the offset',
    '  it tells you until you have what you need.',
    '- Prefer ref over CSS selectors. Use browser_eval only to extract data the',
    '  snapshot does not show. browser_wait when content loads asynchronously.',
    '- The tab, cookies and logins persist between calls and tasks.',
    '- Never type passwords, API keys or payment data the user did not give you —',
    '  ask the user instead. Do not submit forms that spend money or delete data',
    '  unless the task explicitly says so.',
    '- browser_connect(endpoint) attaches the browser tools to an external Chromium',
    '  over CDP (e.g. the ws:// endpoint an MCP tool returns when it starts an',
    '  AdsPower profile). browser_close detaches and returns to the default tab.',
    '- If the same page action fails twice, change approach or report the problem.',
    '',
    ...(hasMcp ? [
      'MCP TOOLS',
      '─────────',
      'Tools named mcp__<server>__<tool> come from MCP servers the user connected.',
      'Call them exactly like built-in tools; their parameters are listed below.',
      'Prefer them over hand-written HTTP/shell calls for the same service.',
      '',
    ] : []),
    'MULTI-STEP APPROACH',
    '───────────────────',
    'For complex tasks, break them into steps:',
    '1. Explore the codebase / understand context',
    '2. Plan what changes need to be made',
    '3. Make changes systematically, one file at a time',
    '4. Test / verify the result',
    '',
    'AVAILABLE TOOLS',
    '───────────────',
    toolDocs,
    '',
    'Remember: You are running autonomously. Be thorough, be precise, and complete',
    'the task fully. If something is ambiguous, make a sensible decision and note',
    'it in your final response.',
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  Conversation / message history manager
// ─────────────────────────────────────────────

class ConversationManager {
  constructor() {
    this.messages      = [];
    this._systemPrompt = null;
    this.primed        = false; // true once the chat already holds the system prompt
    this.baseChars     = 0;     // chars carried over from a resumed chat
  }

  /** Follow-up task in an already-primed chat (no system prompt resend). */
  buildFollowUpMessage(task) {
    const content = 'USER FOLLOW-UP TASK:\n──────────────────\n' + task;
    this.messages.push({ role: 'user', content: content });
    return content;
  }

  /** Total chars exchanged in this chat (incl. resumed history). */
  get chars() {
    return this.baseChars + this.messages.reduce(function(n, m) { return n + m.content.length; }, 0);
  }

  /** Rough token estimate (~3 chars/token: safe for mixed RU/EN/code). */
  get estimatedTokens() {
    return Math.ceil(this.chars / 3);
  }

  /**
   * Build the very first user message that includes the system prompt,
   * working-directory context, and the user's task.
   */
  buildFirstMessage(task, workingDirListing) {
    this._systemPrompt = buildSystemPrompt();
    this.primed        = true;

    const dirContext = workingDirListing
      ? '\nCURRENT WORKING DIRECTORY CONTENTS:\n' + workingDirListing + '\n'
      : '';

    const firstMessage = [
      this._systemPrompt,
      '',
      '═'.repeat(60),
      '',
      dirContext,
      'USER TASK:',
      '──────────',
      task,
    ].join('\n');

    this.messages.push({ role: 'user', content: firstMessage });
    return firstMessage;
  }

  /**
   * Add a tool result as a user-turn message (feeding results back to the AI).
   */
  addToolResult(toolName, result, isError) {
    const status  = isError ? 'ERROR' : 'SUCCESS';
    const content = [
      '[TOOL RESULT: ' + toolName + ' | ' + status + ']',
      String(result),
      '[END TOOL RESULT]',
      '',
      'Continue with the next step, or provide your final response if the task is complete.',
    ].join('\n');

    this.messages.push({ role: 'user', content: content });
    return content;
  }

  /**
   * Add an assistant message (the AI's raw response).
   */
  addAssistantMessage(content) {
    this.messages.push({ role: 'assistant', content: content });
  }

  /**
   * Remove the last recorded message. Used to drop a partial assistant message
   * that was read mid-stream, before re-reading the finished response.
   */
  popLastMessage() {
    this.messages.pop();
  }

  /**
   * Get the most recent user message content.
   */
  getLatestUserMessage() {
    const userMessages = this.messages.filter(function(m) { return m.role === 'user'; });
    return userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  }

  /**
   * How many assistant turns have happened.
   */
  get turnCount() {
    return this.messages.filter(function(m) { return m.role === 'assistant'; }).length;
  }

  /**
   * Export the full conversation as a readable text log.
   */
  exportLog() {
    return this.messages.map(function(m) {
      const header = m.role === 'user' ? 'USER' : 'ASSISTANT';
      return '\n' + '─'.repeat(40) + '\n' + header + '\n' + '─'.repeat(40) + '\n' + m.content;
    }).join('\n');
  }
}

module.exports = { buildSystemPrompt, ConversationManager };
