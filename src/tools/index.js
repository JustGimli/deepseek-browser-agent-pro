// src/tools/index.js — Tool registry: built-in tools + tools registered at runtime (MCP)
'use strict';

// Each module exports { tools, ...lifecycle helpers }
const TOOLS = {
  ...require('./fs').tools,
  ...require('./shell').tools,
  ...require('./net').tools,
  ...require('./browser').tools,
};

/** Add a tool at runtime (used by the MCP client) */
function registerTool(name, def) {
  TOOLS[name] = def;
}

// ─────────────────────────────────────────────
//  Generate tool docs for the system prompt
// ─────────────────────────────────────────────
function getToolDescriptions() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const paramLines = Object.entries(tool.parameters || {}).map(([pName, p]) =>
      `    - ${pName} (${p.type}${p.required ? ', REQUIRED' : ''}): ${p.description || ''}`
    ).join('\n');

    return `### ${name}\n  ${tool.description}\n  Parameters:\n${paramLines || '    (none)'}`;
  }).join('\n\n');
}

// ─────────────────────────────────────────────
//  Execute a tool by name
// ─────────────────────────────────────────────
/** ctx = { signal } — an AbortSignal that fires when the user stops the task */
async function executeTool(name, args, ctx = {}) {
  args = args || {};
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    throw new Error(`Unknown tool: "${name}". Available tools: ${available}`);
  }
  const missing = Object.entries(tool.parameters || {})
    .filter(([k, p]) => p.required && args[k] == null)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing required parameter(s) for ${name}: ${missing.join(', ')}`);
  return await tool.execute(args, ctx);
}

module.exports = { TOOLS, registerTool, executeTool, getToolDescriptions };
