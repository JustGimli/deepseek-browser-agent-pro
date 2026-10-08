// src/agent.js — The core agent loop that ties everything together
'use strict';

const fs                           = require('fs');
const os                           = require('os');
const path                         = require('path');
const { execSync }                 = require('child_process');
const config                       = require('./config');
const logger                       = require('./logger');
const DeepSeekBrowser              = require('./browser');
const InputUI                      = require('./ui');
const { executeTool }              = require('./tools');
const { parseResponse,
        extractCommentary }        = require('./parser');
const { ConversationManager }      = require('./prompt');

// Slash commands: [command, description]
const COMMANDS = [
  ['/new_chat',     'start a fresh DeepSeek chat'],
  ['/stop',         'stop the running task (or press Esc)'],
  ['/continue',     'keep going after the step limit'],
  ['/history',      'list saved chats'],
  ['/resume <n>',   'reopen chat number n from /history'],
  ['/context',      'show estimated context usage'],
  ['/headless on',  'restart browser invisibly'],
  ['/headless off', 'restart browser with a window'],
  ['/help',         'show this list'],
  ['/exit',         'quit'],
];

const HISTORY_FILE = path.join(os.homedir(), '.deepseek-agent', 'history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

// ─────────────────────────────────────────────
//  Agent class
// ─────────────────────────────────────────────

class DeepSeekAgent {
  constructor(options = {}) {
    this.browser      = new DeepSeekBrowser();
    this.conversation = new ConversationManager();
    this.options      = options;
    this._running     = false;
    this._abort       = false;   // set by stop(): finish current wait, then end the task
    this._inbox       = [];      // messages typed while the agent is working
    this.interactive  = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Boot the browser and load DeepSeek */
  async init() {
    await this.browser.launch();
    await this.browser.newChat();
  }

  /** Shut down cleanly */
  async shutdown() {
    await this.browser.close();
  }

  /**
   * Run a task to completion.
   * Returns the final response string.
   */
  async run(task) {
    this._running   = true;
    this._abort     = false;
    this.browser.abort = false;
    try {
      return await this._runLoop(task);
    } finally {
      this._running = false; // also on throw, so stop() / Ctrl+C behave after a failed task
    }
  }

  async _runLoop(task) {
    if (this.interactive) logger.dim('Esc or /stop = stop · type a message + Enter = send it with the next step');
    const maxIter   = config.MAX_ITERATIONS;

    // ── 1. Build and send first message (or follow-up in an existing chat) ─
    logger.header(`Task: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

    const firstMsg = this.conversation.primed
      ? this.conversation.buildFollowUpMessage(task)
      : this.conversation.buildFirstMessage(task, this._getWorkingDirListing());
    this._lastTask = this._lastTask || task;

    if (config.DEBUG) {
      logger.dim('--- First message (truncated) ---');
      logger.dim(firstMsg.slice(0, 600) + '...');
    }

    this._currentTask = this._currentTask || task;
    logger.info('Sending task to DeepSeek...');
    await this._send(firstMsg);

    // ── 2. Agent loop ──────────────────────────────────────────────────────
    for (let iter = 1; iter <= maxIter; iter++) {
      if (this._abort) return this._stopped();
      logger.iteration(iter, maxIter);
      this.ui?.setStatus({ step: `${iter}/${maxIter}` });
      this._showContext();

      // Wait for response from DeepSeek
      const rawResponse = await this.browser.waitForResponse();
      this._saveHistory();
      if (this._abort) return this._stopped();

      if (!rawResponse || rawResponse.trim().length === 0) {
        logger.warn('Empty response received — retrying...');
        await this._send('Please continue. If you are waiting for input, proceed with your best judgement.');
        continue;
      }

      if (config.DEBUG) {
        logger.dim(`--- Raw response (${rawResponse.length} chars) ---`);
        logger.dim(rawResponse.slice(0, 400));
      }

      // Record the AI response in conversation history
      this.conversation.addAssistantMessage(rawResponse);

      // Parse the response
      const parsed = parseResponse(rawResponse);

      // ── Case 1: Tool call ──────────────────────────────────────────────
      if (parsed.type === 'tool_call') {
        const note = extractCommentary(rawResponse);
        if (note) logger.thought(note);
        logger.toolCall(parsed.name, parsed.args);
        if (!Object.keys(parsed.args || {}).length) {
          logger.dim('Empty args. Raw response: ' + JSON.stringify(rawResponse.slice(0, 600)));
        }

        let result;
        let isError = false;

        try {
          result  = await executeTool(parsed.name, parsed.args);
          logger.toolResult(result);
        } catch (err) {
          result  = `Error: ${err.message}`;
          isError = true;
          logger.toolResult(result, true);
        }

        // Feed result back
        const feedbackMsg = this.conversation.addToolResult(parsed.name, result, isError);
        await this._send(feedbackMsg);
        continue;
      }

      // ── Case 2: Parse error ────────────────────────────────────────────
      if (parsed.type === 'error') {
        logger.warn(`Parse error: ${parsed.message}`);
        const recovery = this.conversation.addToolResult(
          'SYSTEM',
          `Parse error: ${parsed.message}\n\nPlease try again with valid JSON in your tool call.`,
          true
        );
        await this._send(recovery);
        continue;
      }

      // ── Case 3: Final response ─────────────────────────────────────────
      if (parsed.type === 'final') {
        // Safety net: if the "final" response text contains a tool_call block
        // that our parser missed (e.g. garbled by DOM), send a correction prompt.
        const looksLikeToolCall = (
          /tool_call/i.test(parsed.content) ||
          /"name"\s*:\s*"[\w_]+"/.test(parsed.content) ||
          /write_file|read_file|run_command|list_directory/i.test(parsed.content.slice(0, 200))
        );

        if (looksLikeToolCall && this.conversation.turnCount <= maxIter - 2) {
          logger.warn('Response looks like a tool call but was not parsed — asking AI to retry format...');
          const retry = this.conversation.addToolResult(
            'SYSTEM',
            'Your response appeared to contain a tool call but it could not be parsed. ' +
            'Please respond with ONLY a ```tool_call code block and nothing else — no prose before or after it.',
            true
          );
          await this._send(retry);
          continue;
        }

        logger.finalOutput(parsed.content);

        // Optionally save conversation log
        if (this.options.saveLog) {
          await this._saveConversationLog(task, parsed.content);
        }

        return parsed.content;
      }
    }

    // ── Hit max iterations ─────────────────────────────────────────────────
    const warn = `Reached maximum iterations (${maxIter}). Type "continue" (or "дальше") to keep going.`;
    logger.warn(warn);
    return warn;
  }

  // ── Interactive (REPL) Mode ────────────────────────────────────────────────

  /**
   * Run the agent in interactive mode — keeps the browser open
   * and accepts tasks one after another.
   */
  async runInteractive() {
    const ui = this.ui = new InputUI();
    ui.setCommands(COMMANDS);
    ui.onEscape    = () => this.stop();
    ui.onInterrupt = () => (this._running ? this.stop() : process.kill(process.pid, 'SIGINT'));
    // Text sent while the agent works: /stop stops it, anything else is a message for the next step
    ui.onBusyInput = text => {
      if (['/stop', 'stop', '/стоп', 'стоп'].includes(text.trim().toLowerCase())) return this.stop();
      this._inbox.push(text.trim());
      logger.info(`Queued: ${text.trim().slice(0, 60)} (goes out with the next step)`);
    };

    logger.header('Interactive Mode — Type your task and press Enter');
    logger.info('The chat continues between tasks. / opens commands (↑↓ select, Tab fills, Enter runs). Alt+Enter or a trailing \\ adds a new line.\n');

    this.interactive = true;
    ui.start();
    ui.setStatus({ headless: config.HEADLESS, dir: path.basename(config.WORKING_DIR) });
    this._showContext();

    const ask = async () => ui.ask();
    const runTask = async text => {
      ui.setStatus({ busy: true });
      try { return await this.run(text); }
      finally { ui.setStatus({ busy: false, step: null }); }
    };

    while (true) {
      let task;
      if (this._inbox.length) {
        task = this._inbox.splice(0).join('\n');
        logger.info('Running your queued message...');
      } else {
        try {
          const ans = await ask();
          if (ans == null) break;
          task = ans.trim();
        } catch {
          break; // stdin closed
        }
      }

      if (!task) continue;

      if (['continue', '/continue', 'дальше', 'продолжай', 'продолжи'].includes(task.toLowerCase())) {
        try { await runTask('Continue the previous task from exactly where you stopped. Do not redo finished steps.'); }
        catch (err) { logger.error(`Task failed: ${err.message}`); }
        continue;
      }

      if (['exit', 'quit', 'q', '/exit', '/quit'].includes(task.toLowerCase())) {
        logger.info('Exiting...');
        break;
      }

      const hm = task.toLowerCase().match(/^\/?headless\s+(on|off)$/);
      if (hm) {
        const on = hm[1] === 'on';
        logger.info(`Restarting browser (headless ${hm[1]})...`);
        try {
          await this.browser.relaunch(on);
          ui.setStatus({ headless: on });
          await this.browser.newChat();
          this.conversation = new ConversationManager();
        } catch (err) {
          logger.error(`Relaunch failed: ${err.message}`);
        }
        continue;
      }

      if (['/new_chat', '/new', 'new'].includes(task.toLowerCase())) {
        logger.info('Starting new chat...');
        await this.browser.newChat();
        this.conversation = new ConversationManager();
        this._lastTask = this._currentTask = null;
        continue;
      }

      if (task.toLowerCase() === '/help') {
        COMMANDS.forEach(([c, d]) => logger.info(`${c.padEnd(15)} ${d}`));
        continue;
      }

      if (task.toLowerCase() === '/context') { this._showContext(); continue; }

      if (task.toLowerCase() === '/history') { this._printHistory(); continue; }

      const rm = task.match(/^\/resume\s+(\d+)$/i);
      if (rm) {
        const h = loadHistory()[Number(rm[1]) - 1];
        if (!h) { logger.warn('No such chat. Use /history.'); continue; }
        try {
          await this.browser._navigate(h.url);
          this.conversation = new ConversationManager();
          this.conversation.primed    = true;
          this.conversation.baseChars = h.chars || 0;
          this._lastTask = h.title;
          logger.success(`Resumed: ${h.title}`);
          this._showContext();
        } catch (err) {
          logger.error(`Resume failed: ${err.message}`);
        }
        continue;
      }

      try {
        await runTask(task);
      } catch (err) {
        logger.error(`Task failed: ${err.message}`);
        if (config.DEBUG) console.error(err);
      }
    }

    ui.stop();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Ask the running task to stop (also aborts the in-page wait + generation). */
  stop() {
    if (!this._running || this._abort) return;
    this._abort = true;
    this.browser.abort = true;
    logger.warn('Stopping…');
  }

  _stopped() {
    logger.warn('Stopped by user. Send a new message, or type "continue" to resume.');
    return 'Stopped by user.';
  }

  /** Send a message; if the chat is >= CONTEXT_ROLLOVER of the limit, hand off to a fresh chat first. */
  async _send(msg) {
    if (this._inbox.length) {
      const notes = this._inbox.splice(0).join('\n');
      msg += '\n\nMESSAGE FROM THE USER (sent while you were working — take it into account now):\n' + notes;
      this.conversation.baseChars += notes.length;
      logger.info('↳ your message was delivered');
    }
    const projected = this.conversation.estimatedTokens + Math.ceil(msg.length / 3);
    if (projected / config.CONTEXT_LIMIT >= config.CONTEXT_ROLLOVER) {
      try { return await this._rollover(msg); }
      catch (err) { logger.warn(`Rollover failed (${err.message}) — continuing in the same chat`); }
    }
    return this.browser.sendMessage(msg);
  }

  /** Ask DeepSeek for a handoff summary, then continue in a new chat with system prompt + summary. */
  async _rollover(pendingMsg) {
    logger.warn(`Context ≥ ${Math.round(config.CONTEXT_ROLLOVER * 100)}% — summarizing and moving to a new chat...`);
    await this.browser.sendMessage(
      'CONTEXT HANDOFF. Do NOT call any tools. Write a compact plain-text summary of this whole conversation ' +
      'so a fresh chat can continue seamlessly: 1) the user\'s goal, 2) what is done (files created/changed, ' +
      'commands run, results), 3) current state and known problems/errors, 4) exact remaining steps, ' +
      '5) important paths, names and decisions.'
    );
    const summary = await this.browser.waitForResponse();
    if (!summary || summary.trim().length < 50) throw new Error('empty summary');

    await this.browser.newChat();
    this.conversation = new ConversationManager();
    this._lastTask    = '↪ ' + (this._currentTask || '').slice(0, 56);

    const task = [
      'ORIGINAL TASK: ' + (this._currentTask || '(see summary)'),
      '',
      'SUMMARY OF THE PREVIOUS CHAT (it ran out of context — continue from here, do not redo finished work):',
      summary,
      '',
      'LATEST MESSAGE TO RESPOND TO:',
      pendingMsg,
    ].join('\n');
    const first = this.conversation.buildFirstMessage(task, this._getWorkingDirListing());
    logger.success('New chat started with summary.');
    return this.browser.sendMessage(first);
  }

  _showContext() {
    const used  = this.conversation.estimatedTokens;
    const limit = config.CONTEXT_LIMIT;
    const pct   = Math.round(used / limit * 100);
    const line  = `Context ≈ ${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`;
    this.ui?.setStatus({ ctx: `${pct}% (${Math.round(used / 1000)}k/${Math.round(limit / 1000)}k)` });
    if (pct >= 80) logger.warn(line + ' — consider /new_chat');
    else if (!this.ui) logger.dim(line);
  }

  /** Upsert this chat (keyed by DeepSeek chat URL) into history.json */
  _saveHistory() {
    try {
      const url = this.browser.page.url();
      if (!/\/a\/chat\/s\//.test(url)) return; // chat not created yet
      const list  = loadHistory();
      const entry = list.find(h => h.url === url) || { url, title: (this._lastTask || '').slice(0, 60) };
      entry.chars   = this.conversation.chars;
      entry.updated = new Date().toISOString();
      fs.writeFileSync(HISTORY_FILE, JSON.stringify([entry, ...list.filter(h => h !== entry)].slice(0, 50), null, 2));
    } catch {}
  }

  _printHistory() {
    const list = loadHistory();
    if (!list.length) return logger.info('No saved chats yet.');
    list.forEach((h, i) => logger.info(
      `${String(i + 1).padStart(2)}. ${h.title}  \x1b[2m(${h.updated.slice(0, 16).replace('T', ' ')}, ~${Math.ceil(h.chars / 3)} tok)\x1b[0m`
    ));
    logger.dim('Resume with: /resume <n>');
  }

  _getWorkingDirListing() {
    try {
      const result = execSync(
        `find . -maxdepth 3 \\
          -not -path '*/node_modules/*' \\
          -not -path '*/.git/*' \\
          -not -path '*/dist/*' \\
          -not -path '*/.next/*' \\
          -not -path '*/build/*' \\
          -not -name '*.lock' \\
          | sort | head -80`,
        { cwd: config.WORKING_DIR, encoding: 'utf8', timeout: 5_000 }
      ).trim();
      return result || '(empty directory)';
    } catch {
      return '(could not read directory)';
    }
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = path.join(os.homedir(), '.deepseek-agent', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile  = path.join(logsDir, `session-${ts}.txt`);
      const content  = [
        `DeepSeek Agent — Session Log`,
        `Date: ${new Date().toISOString()}`,
        `Task: ${task}`,
        `Working Dir: ${config.WORKING_DIR}`,
        '═'.repeat(60),
        this.conversation.exportLog(),
        '',
        '═'.repeat(60),
        'FINAL RESPONSE:',
        finalResponse,
      ].join('\n');

      fs.writeFileSync(logFile, content, 'utf8');
      logger.dim(`Conversation saved: ${logFile}`);
    } catch (err) {
      logger.warn(`Could not save log: ${err.message}`);
    }
  }
}

module.exports = DeepSeekAgent;
