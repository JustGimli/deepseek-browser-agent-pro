// src/mcp.js — Minimal MCP client (stdio transport): starts the configured servers and registers their tools
'use strict';

const { spawn }        = require('child_process');
const readline         = require('readline');
const config           = require('./config');
const logger           = require('./logger');
const { registerTool } = require('./tools');
const { truncate }     = require('./tools/util');
const { version }      = require('../package.json');

const servers = [];

// ─────────────────────────────────────────────
//  One MCP server process — newline-delimited JSON-RPC 2.0 over stdin/stdout
// ─────────────────────────────────────────────

class McpServer {
  constructor(name, { command, args = [], env = {}, cwd }) {
    this.name    = name;
    this.pending = new Map();
    this.nextId  = 1;
    this.stderr  = '';
    this.dead    = null;
    this.proc    = spawn(command, args, {
      cwd  : cwd || config.WORKING_DIR,
      env  : { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx is npx.cmd on Windows
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', line => this._onLine(line));
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-2_000); });
    this.proc.stdin.on('error', () => {}); // EPIPE after the process died — reported via 'exit'
    this.proc.on('error', err => this._failAll(err.message));
    this.proc.on('exit', code => this._failAll(`exited (code ${code})`));
  }

  _write(msg) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // non-JSON noise on stdout

    // Request / notification from the server: answer ping, refuse the rest (sampling, roots…)
    if (msg.method) {
      if (msg.id == null) return;
      if (msg.method === 'ping') this._write({ id: msg.id, result: {} });
      else this._write({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }

    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`));
    else p.resolve(msg.result || {});
  }

  _failAll(reason) {
    const tail = this.stderr.trim().split('\n').slice(-5).join('\n');
    this.dead  = new Error(`MCP server "${this.name}" ${reason}${tail ? '\n' + tail : ''}`);
    for (const p of this.pending.values()) p.reject(this.dead);
    this.pending.clear();
  }

  request(method, params = {}, timeout = config.MCP_CALL_TIMEOUT) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out after ${timeout} ms`));
      }, timeout);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject : e => { clearTimeout(timer); reject(e); },
      });
      this._write({ id, method, params });
    });
  }

  /** Handshake, then return the server's tool list */
  async start() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities   : {},
      clientInfo     : { name: 'deepseek-agent', version },
    }, config.MCP_START_TIMEOUT);
    this._write({ method: 'notifications/initialized' });

    const tools = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, config.MCP_START_TIMEOUT);
      tools.push(...(res.tools || []));
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(name, args) {
    const res  = await this.request('tools/call', { name, arguments: args });
    const text = (res.content || []).map(c =>
      c.type === 'text'  ? c.text :
      c.type === 'image' ? '[image omitted]' :
      JSON.stringify(c)
    ).join('\n');
    if (res.isError) throw new Error(text || 'MCP tool returned an error');
    return truncate(text || JSON.stringify(res.structuredContent ?? '(no output)'));
  }

  close() {
    if (!this.dead) this.dead = new Error(`MCP server "${this.name}" closed`);
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// ─────────────────────────────────────────────
//  JSON Schema → our tool parameter docs
// ─────────────────────────────────────────────

function toParameters(schema = {}) {
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, p]) => [key, {
    type       : [].concat(p.type || (p.enum ? typeof p.enum[0] : 'any')).join('|'),
    required   : required.has(key),
    description: [
      p.description,
      p.enum && `one of: ${p.enum.join(' | ')}`,
      p.default !== undefined && `default: ${JSON.stringify(p.default)}`,
    ].filter(Boolean).join('. '),
  }]));
}

const safe = s => String(s).replace(/\W/g, '_');

// ─────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────

/**
 * Start every configured server (in parallel) and register its tools as mcp__<server>__<tool>.
 * Optional "tools": ["a", "b"] in a server entry keeps only those tools (shorter prompt). Failures only warn.
 */
async function connectMcpServers(list = config.mcpServers) {
  const started = await Promise.all(Object.entries(list || {}).map(async ([name, def]) => {
    if (!def || !def.command) {
      logger.warn(`MCP ${name}: skipped — only stdio servers ("command") are supported`);
      return null;
    }
    logger.info(`MCP ${name}: starting...`);
    const server = new McpServer(name, def);
    servers.push(server);
    try {
      const tools = (await server.start()).filter(t => !Array.isArray(def.tools) || def.tools.includes(t.name));
      return { name, server, tools };
    } catch (err) {
      logger.warn(`MCP ${name} failed: ${err.message}`);
      server.close();
      return null;
    }
  }));

  // Register in config order so the prompt is the same on every run
  for (const { name, server, tools } of started.filter(Boolean)) {
    for (const t of tools) {
      registerTool(`mcp__${safe(name)}__${safe(t.name)}`, {
        description: String(t.description || t.name).replace(/\s+/g, ' ').trim().slice(0, 500),
        parameters : toParameters(t.inputSchema),
        execute    : args => server.call(t.name, args),
      });
    }
    logger.success(`MCP ${name}: ${tools.length} tools`);
  }
}

function closeMcp() {
  servers.splice(0).forEach(s => s.close());
}

module.exports = { connectMcpServers, closeMcp, toParameters };
