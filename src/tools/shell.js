// src/tools/shell.js — Shell commands and code search
'use strict';

const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const { spawn } = require('child_process');
const config    = require('../config');
const { truncate, resolve, rel, walk, globToRegExp } = require('./util');

const isWin   = process.platform === 'win32';
const running = new Set(); // foreground + background children, killed on shutdown

/** Kill the command with everything it spawned (npm → node …): detached children lead their own process group */
function killTree(child, signal = 'SIGKILL') {
  try {
    if (isWin) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function track(child) {
  running.add(child);
  child.on('exit', () => running.delete(child));
  child.on('error', () => running.delete(child));
}

/** Start a never-ending command (dev server, watcher), return its first output after a few seconds */
function startBackground(command, opts) {
  const log = path.join(os.homedir(), '.deepseek-agent', 'logs', `bg-${Date.now()}.log`);
  const fd  = fs.openSync(log, 'a');
  const child = spawn(command, { ...opts, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  track(child);

  return new Promise(done => setTimeout(() => {
    const head  = fs.readFileSync(log, 'utf8').trim();
    const state = child.exitCode !== null ? `already exited (code ${child.exitCode})` : `running, pid ${child.pid}`;
    const kill  = isWin ? `taskkill /PID ${child.pid} /T /F` : `kill -- -${child.pid}`;
    done([
      `Started in background — ${state}.`,
      `Log : ${log} (read it with read_file)`,
      `Stop: run_command "${kill}" (also stopped when the agent exits)`,
      '',
      'First output:',
      truncate(head || '(none yet)', 3_000),
    ].join('\n'));
  }, 3_000));
}

const tools = {

  // ── Run Command ─────────────────────────────────────────────────────────────
  run_command: {
    description: 'Execute a shell command and return its combined stdout+stderr. Runs in the working directory by default. For servers / watchers that never exit set background=true.',
    parameters: {
      command    : { type: 'string',  required: true,  description: 'Shell command to run' },
      cwd        : { type: 'string',  required: false, description: 'Working directory for the command' },
      timeout    : { type: 'number',  required: false, description: 'Timeout in milliseconds (default: 60000)' },
      env        : { type: 'object',  required: false, description: 'Extra environment variables as key-value pairs' },
      background : { type: 'boolean', required: false, description: 'Start it detached: returns pid, log file and first output after ~3 s (default: false)' },
    },
    async execute({ command, cwd, timeout = 60_000, env = {}, background = false }, { signal } = {}) {
      const opts = {
        cwd     : cwd ? resolve(cwd) : config.WORKING_DIR,
        env     : { ...process.env, ...env },
        shell   : true,
        detached: !isWin,
      };
      if (background) return startBackground(command, opts);

      // spawn, not execSync: keeps the event loop free so Esc / stop can kill it
      return new Promise((done, fail) => {
        const child = spawn(command, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        track(child);

        let out    = '';
        let reason = null;
        let ended  = false;
        const collect = chunk => {
          out += chunk;
          if (out.length > 20e6) out = out.slice(-10e6); // runaway output: keep the tail
        };
        const kill    = why => { reason = reason || why; killTree(child); };
        const onAbort = () => kill('stopped by user');
        const timer   = setTimeout(() => kill(`timed out after ${timeout} ms and was killed — use background=true for long-running processes`), timeout);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();

        const finish = (code, error) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const text = out.trim();
          if (reason || error || code !== 0) {
            const why = reason || (error ? error.message : `failed (exit code ${code})`);
            return fail(new Error(`Command ${why}:\n${truncate(text || '(no output)')}`));
          }
          done(truncate(text || '(command completed with no output)'));
        };

        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', err => finish(null, err));
        child.on('close', code => finish(code));
      });
    },
  },

  // ── Find Files ──────────────────────────────────────────────────────────────
  find_files: {
    description: 'Find files by name (glob like "*.js", "test_*"; a pattern with "/" matches the relative path). Skips node_modules, .git, dist, build.',
    parameters: {
      pattern   : { type: 'string', required: true,  description: 'Filename pattern (e.g. "*.ts")' },
      directory : { type: 'string', required: false, description: 'Directory to search (default: working dir)' },
      exclude   : { type: 'string', required: false, description: 'Skip paths containing this text' },
    },
    async execute({ pattern, directory = '.', exclude }) {
      const re     = globToRegExp(pattern);
      const byPath = String(pattern).includes('/');
      const hits   = walk(resolve(directory), { hidden: true, dirs: false, limit: 20_000 })
        .map(rel)
        .filter(p => re.test(byPath ? p : path.basename(p)) && !(exclude && p.includes(exclude)));
      if (!hits.length) return `No files matching "${pattern}" in ${directory}`;
      return hits.slice(0, 100).join('\n') + (hits.length > 100 ? `\n… ${hits.length - 100} more` : '');
    },
  },

  // ── Search in Files (grep) ───────────────────────────────────────────────────
  search_in_files: {
    description: 'Search text inside files (like grep -rn). "pattern" matches as a JS regex OR as plain text, so code like "foo($x)" works as typed. Matches are "file:line:", context lines "file:line-".',
    parameters: {
      pattern       : { type: 'string',  required: true,  description: 'Text or regex to search for' },
      directory     : { type: 'string',  required: false, description: 'Directory to search (default: working dir)' },
      file_pattern  : { type: 'string',  required: false, description: 'Only search files matching this glob (e.g. "*.js")' },
      case_sensitive: { type: 'boolean', required: false, description: 'Case-sensitive search (default: false)' },
      context_lines : { type: 'number',  required: false, description: 'Lines of context around each match (default: 2)' },
    },
    async execute({ pattern, directory = '.', file_pattern, case_sensitive = false, context_lines = 2 }) {
      const flags   = case_sensitive ? '' : 'i';
      const literal = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      let re = null;
      try { re = new RegExp(pattern, flags); } catch {}
      const isMatch = line => literal.test(line) || (re !== null && re.test(line));
      const nameRe = file_pattern && globToRegExp(file_pattern);
      const ctx    = Math.max(0, Number(context_lines) || 0);

      const out = [];
      let matches = 0;
      files: for (const file of walk(resolve(directory), { hidden: true, dirs: false, limit: 20_000 })) {
        if (nameRe && !nameRe.test(path.basename(file))) continue;
        let text;
        try {
          if (fs.statSync(file).size > 1_000_000) continue;
          text = fs.readFileSync(file, 'utf8');
        } catch { continue; }
        if (text.includes('\u0000')) continue; // binary

        const lines = text.split('\n');
        const hits  = [];
        lines.forEach((line, i) => { if (isMatch(line)) hits.push(i); });
        if (!hits.length) continue;

        const name   = rel(file);
        const isHit  = new Set(hits);
        let printed  = -1;
        for (const i of hits) {
          const from = Math.max(i - ctx, printed + 1);
          const to   = Math.min(i + ctx, lines.length - 1);
          if (out.length && from > printed + 1) out.push('--');
          for (let j = from; j <= to; j++) out.push(`${name}:${j + 1}${isHit.has(j) ? ':' : '-'} ${lines[j].slice(0, 300)}`);
          printed = Math.max(printed, to);
          if (++matches >= 150) { out.push('… stopped at 150 matches — narrow the search'); break files; }
        }
      }
      return out.length ? truncate(out.join('\n')) : `No matches found for: ${pattern}`;
    },
  },

};

/** Shutdown: kill every command still running (incl. background servers) */
function stopProcesses() {
  for (const child of running) killTree(child, 'SIGTERM');
  running.clear();
}

module.exports = { tools, stopProcesses };
