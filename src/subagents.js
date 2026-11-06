// src/subagents.js — run several tasks in parallel tabs of ONE DeepSeek account
// (no multi-account pooling: that's rate-limit evasion, out of scope on purpose)
'use strict';

const config               = require('./config');
const logger                = require('./logger');
const { RateLimiter }      = require('./rateLimiter');

class SubagentPool {
  constructor(mainBrowser) {
    this.mainBrowser = mainBrowser;
    // Shared by the main tab too, once subagents are in play — same account either way.
    this.mainBrowser.rateLimiter = this.mainBrowser.rateLimiter || new RateLimiter(config.SUBAGENT_RATE);
  }

  /**
   * Run `task` to completion in a fresh tab under the main tab's browser context
   * (same login/cookies). Returns the subagent's final plain-text answer.
   * `signal` (the main task's) aborting stops this subagent too — Esc / /stop.
   */
  async spawn(task, index, total, signal) {
    if (signal?.aborted) throw new Error('Stopped before start.');
    const tab = await this.mainBrowser.openTab();

    // Required late (not at top) to dodge the agent.js <-> subagents.js circular require.
    const DeepSeekAgent = require('./agent');
    const worker = new DeepSeekAgent({ subagentInfo: { index: index + 1, total } });
    worker.browser = tab; // skip init(): no new persistent context, just this tab
    // ponytail: browser_* web-research tools stay bound to the main tab (the `web`
    // module is a process-wide singleton) — a subagent calling them acts on the main
    // tab, not its own. Fine for coding tasks; give subagents their own web binding
    // if that gap ever actually bites.

    const onAbort = () => worker.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw new Error('Stopped.'); // aborted while the tab was opening
      return await logger.withContext({ index: index + 1, total }, () => worker.run(task));
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try { await tab.page.close(); } catch {}
    }
  }
}

module.exports = { SubagentPool };
