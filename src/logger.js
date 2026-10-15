// src/logger.js — ANSI-colored terminal output (no dependencies)
'use strict';

const { stripVTControlCharacters } = require('util');

const A = {
  reset   : '\x1b[0m',
  bold    : '\x1b[1m',
  dim     : '\x1b[2m',
  blue    : '\x1b[34m',
  cyan    : '\x1b[36m',
  white   : '\x1b[37m',
  gray    : '\x1b[90m',
  lred    : '\x1b[91m',
  lgreen  : '\x1b[92m',
  lyellow : '\x1b[93m',
  lblue   : '\x1b[94m',
  lmagenta: '\x1b[95m',
  lcyan   : '\x1b[96m',
};

const c  = (code, text) => `${A[code]}${text}${A.reset}`;
const cb = (code, text) => `${A.bold}${A[code]}${text}${A.reset}`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function truncDisplay(str, max = 400) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max) + c('gray', `… (+${s.length - max} chars)`);
}

// ── Markdown rendering ───────────────────────────────────────────────────────
const BG_CODE = '\x1b[48;5;238m\x1b[38;5;223m';
const BG_BLOCK = '\x1b[48;5;235m';

/** Visible terminal width (ANSI stripped, emoji = 2 cells) */
function vlen(str) {
  let n = 0;
  for (const ch of stripVTControlCharacters(String(str))) {
    if (ch === '\uFE0F' || ch === '\u200D') continue; // variation selector / ZWJ: zero width
    n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return n;
}

/** Inline markup → ANSI. Styles are applied per word so wrapping never splits one. */
function inline(text) {
  const perWord = (t, open, close) => t.split(' ').map(w => (w ? open + w + close : w)).join(' ');
  return String(text)
    .replace(/`([^`]+)`/g, (_, t) => perWord(` ${t} `.replace(/ +/g, ' ').trim(), BG_CODE + '\u00a0', '\u00a0' + A.reset))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => perWord(t, A.bold, A.reset));
}

function wrapAnsi(str, width) {
  const out = [];
  let cur = '';
  for (const w of str.split(' ')) {
    if (cur && vlen(cur) + 1 + vlen(w) > width) { out.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  out.push(cur);
  return out;
}

function renderTable(rows) {
  const split = r => r.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
  const isSep = r => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(r);
  const header = split(rows[0]);
  const body   = rows.slice(1).filter(r => !isSep(r)).map(split);
  const cols   = header.length;
  const cells  = [header, ...body].map(r => Array.from({ length: cols }, (_, i) => inline(r[i] || '')));

  const avail  = Math.max(40, (process.stdout.columns || 100) - 4 - (cols + 1) * 3);
  let widths   = Array.from({ length: cols }, (_, i) => Math.max(...cells.map(r => vlen(r[i]))));
  while (widths.reduce((x, y) => x + y, 0) > avail) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 8) break;
    widths[i]--;
  }

  const line = (l, m, r) => c('gray', l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
  const out  = [line('┌', '┬', '┐')];
  cells.forEach((row, ri) => {
    const wrapped = row.map((cell, i) => wrapAnsi(cell, widths[i]));
    const h = Math.max(...wrapped.map(x => x.length));
    for (let k = 0; k < h; k++) {
      out.push(c('gray', '│') + wrapped.map((w, i) => {
        const t   = w[k] || '';
        const pad = ' '.repeat(Math.max(0, widths[i] - vlen(t)));
        return ri === 0
          ? `\x1b[48;5;236m\x1b[36m ${stripVTControlCharacters(t)}${pad} ${A.reset}`
          : ` ${t}${pad} `;
      }).join(c('gray', '│')) + c('gray', '│'));
    }
    if (ri === 0) out.push(line('├', '┼', '┤'));
  });
  out.push(line('└', '┴', '┘'));
  return out;
}

/** Terminal markdown: headings with background, tables, code blocks, inline chips */
function renderMarkdown(md) {
  const lines = String(md).split('\n');
  const out   = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const f = line.match(/^\s*```(\S*)/);
    if (f) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const w = Math.min(Math.max(...code.map(l => vlen(l)), 10), 110);
      if (f[1]) out.push(c('gray', f[1]));
      code.forEach(l => out.push(`${BG_BLOCK} ${l}${' '.repeat(Math.max(0, w - vlen(l)))} ${A.reset}`));
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      out.push(...renderTable(rows));
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const t = stripVTControlCharacters(inline(h[2]));
      out.push(h[1].length === 1 ? `\x1b[48;5;24m\x1b[97m ${t} ${A.reset}`
             : h[1].length === 2 ? `\x1b[48;5;238m\x1b[96m ${t} ${A.reset}`
             : c('cyan', t));
      continue;
    }

    out.push(inline(line.replace(/^(\s*)[-*]\s+/, '$1• ')));
  }
  return out.join('\n');
}

// ── Public logger API ─────────────────────────────────────────────────────────
const logger = {
  banner() {
    console.log(`
${c('cyan','╔══════════════════════════════════════════════════╗')}
${c('cyan','║')}   ${cb('lcyan','🤖  DeepSeek Browser Agent')}                     ${c('cyan','║')}
${c('cyan','║')}   ${c('gray','AI Coding Agent via Browser Automation')}         ${c('cyan','║')}
${c('cyan','║')}   ${c('gray','No API key needed — uses chat.deepseek.com')}     ${c('cyan','║')}
${c('cyan','╚══════════════════════════════════════════════════╝')}
`);
  },

  header(msg) {
    console.log(`\n${c('blue','▍')} ${c('white', msg)}\n`);
  },

  info(msg)    { console.log(`${c('lblue','  ℹ ')} ${msg}`); },
  success(msg) { console.log(`${c('lgreen','  ✓ ')} ${c('lgreen', msg)}`); },
  warn(msg)    { console.log(`${c('lyellow','  ⚠ ')} ${c('lyellow', msg)}`); },
  error(msg)   { console.log(`${c('lred','  ✗ ')} ${c('lred', msg)}`); },
  dim(msg)     { console.log(`${A.dim}    ${msg}${A.reset}`); },

  /** Spinner-style line (overwrites itself with \r) */
  thinking(msg) {
    process.stdout.write(`  ${c('cyan','⟳')} ${c('gray', msg)}\r`);
  },

  /** Clear the current line */
  clearLine() {
    process.stdout.write(`\r${' '.repeat(80)}\r`);
  },

  // ── Tool call display ───────────────────────────────────────────────────────
  /** Model's commentary before a tool call */
  thought(msg) {
    const text = msg.length > 1500 ? msg.slice(0, 1500) + '…' : msg;
    console.log('\n' + renderMarkdown(text).split('\n').map(l => `${c('gray', '▏')} ${l}`).join('\n'));
  },

  toolCall(name, args = {}) {
    const keys = ['path', 'command', 'url', 'query', 'pattern', 'file'];
    const key  = keys.find(k => typeof args[k] === 'string') || Object.keys(args).find(k => typeof args[k] === 'string');
    const main = key ? String(args[key]).replace(/\s+/g, ' ') : '';
    // Compact the remaining args: long/multiline values become "+N lines" / "N chars"
    const rest = Object.keys(args).filter(k => k !== key).map(k => {
      const v = typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]);
      if (v.includes('\n')) return `${k} +${v.split('\n').length}L`;
      return v.length > 24 ? `${k} ${v.length}ch` : `${k}=${v}`;
    }).join(' ');
    const shown = main.length > 60 ? main.slice(0, 60) + '…' : main;
    console.log(`\n${c('lmagenta','●')} ${name}${c('gray', '(' + shown + ')')}${rest ? c('gray', '  ' + truncDisplay(rest, 60)) : ''}`);
  },

  toolResult(result, isError = false) {
    const lines = String(result).split('\n');
    const color = isError ? 'lred' : 'gray';
    const max   = isError ? 6 : 8;
    lines.slice(0, max).forEach((l, i) => {
      const t = l.length > 110 ? l.slice(0, 110) + '…' : l;
      console.log(`  ${c('gray', i === 0 ? '⎿' : ' ')}  ${c(color, t)}`);
    });
    if (lines.length > max) console.log(`     ${c('gray', `… +${lines.length - max} lines`)}`);
  },

  // ── Final agent output ──────────────────────────────────────────────────────
  finalOutput(msg) {
    console.log(`\n${c('lgreen','●')} ${c('lgreen','Done')}\n`);
    console.log(renderMarkdown(msg).split('\n').map(l => '  ' + l).join('\n'));
    console.log('');
  },

  // ── Iteration marker ────────────────────────────────────────────────────────
  iteration(n, max) {
    console.log(`\n${c('gray', `· step ${n}/${max}`)}`);
  },
};

module.exports = logger;
