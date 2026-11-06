// src/tools/subagents.js — lets DeepSeek itself spawn parallel subagents
// (same binding pattern as tools/browser.js's `web`)
'use strict';

const config = require('../config');

let pool = null;

/** Give the tool access to the running SubagentPool (set once in agent.js init()) */
function bind(p) {
  pool = p;
}

module.exports.tools = {
  spawn_subagents: {
    description: 'Run 2+ INDEPENDENT subtasks at once, each in its own browser tab under ' +
      'this same DeepSeek account (shared send-rate budget — see SUBAGENTS in your ' +
      'instructions). Only for pieces of work that do not depend on each other or on ' +
      'order; for a single task or ordered steps, just do them yourself. Disabled unless ' +
      'the user turned it on (/subagents on).',
    parameters: {
      tasks: { type: 'array', required: true, description: 'Self-contained task descriptions, one per subagent.' },
    },
    async execute({ tasks }, ctx = {}) {
      if (ctx.isSubagent) throw new Error('Subagents cannot spawn further subagents.');
      if (!config.SUBAGENTS_ENABLED) throw new Error('Subagents are disabled — ask the user to run /subagents on.');
      if (!pool) throw new Error('Subagent pool not ready.');

      const arr = Array.isArray(tasks) ? tasks : [tasks];
      if (!arr.length) throw new Error('tasks must be a non-empty array.');
      if (arr.length > config.MAX_SUBAGENTS) {
        throw new Error(`Max ${config.MAX_SUBAGENTS} subagents at once (MAX_SUBAGENTS).`);
      }

      const results = await Promise.allSettled(
        arr.map((t, i) => pool.spawn(t, i, arr.length, ctx.signal))
      );

      return results
        .map((r, i) => `[subagent ${i + 1}] ` + (r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason?.message || r.reason}`))
        .join('\n\n');
    },
  },
};

module.exports.bind = bind;
