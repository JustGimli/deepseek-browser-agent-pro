// src/ui.js — persistent bottom input box (Claude-Code style).
// Output scrolls in a DECSTBM scroll region; the input box, command menu and
// status line live in a fixed footer below it. No dependencies.
'use strict';

const readline = require('readline');

const ESC  = '\x1b';
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const gray = s => `${ESC}[90m${s}${ESC}[0m`;
const cyan = s => `${ESC}[96m${s}${ESC}[0m`;

// Terminals that report Shift+Enter distinctly send one of these; Alt+Enter is ESC+CR everywhere.
const NEWLINE_SEQ = [`${ESC}[13;2u`, `${ESC}[27;2;13~`, `${ESC}\r`, `${ESC}\n`];

class InputUI {
  constructor() {
    this.buf      = '';
    this.cur      = 0;
    this.history  = [];
    this.hIdx     = -1;
    this.draft    = '';
    this.commands = [];     // [[cmd, description], ...]
    this.sel      = -1;     // highlighted menu row
    this.status   = {};     // { busy, step, ctx, headless, dir }
    this.active   = false;
    this.fallback = false;
    this.atCaret  = false;  // cursor is parked in the input box (output position is saved by ESC 7)
    this.footer   = 0;      // current footer height in rows
    this.frame    = 0;
    this.pasting  = false;
    this._askRes  = null;

    this.onBusyInput = () => {};   // text submitted while no ask() is pending
    this.onEscape    = () => {};
    this.onInterrupt = () => {};   // Ctrl+C / Ctrl+D
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Returns false when the terminal can't host the footer (caller falls back to plain readline). */
  start() {
    const out = process.stdout, inp = process.stdin;
    if (!out.isTTY || !inp.isTTY || (out.rows || 0) < 12) { this.fallback = true; return false; }

    this.active = true;
    this._origWrite = out.write;
    this._write = out.write.bind(out);
    out.write = (chunk, enc, cb) => this._intercept(chunk, enc, cb);

    readline.emitKeypressEvents(inp);
    inp.setRawMode(true);
    inp.resume();
    this._onKey = (s, k) => this._key(s, k);
    inp.on('keypress', this._onKey);

    this._onResize = () => { this.footer = 0; this._write(`${ESC}[r`); this._paint(false); };
    out.on('resize', this._onResize);

    this._spin = setInterval(() => {
      if (!this.status.busy) return;
      this.frame++;
      this._paint(false);
    }, 100);

    this._write(`${ESC}[?2004h`);       // bracketed paste
    process.on('exit', () => this.stop());
    this._paint(true);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this._spin);
    process.stdout.off('resize', this._onResize);
    process.stdin.off('keypress', this._onKey);
    try { process.stdin.setRawMode(false); } catch {}
    const H = process.stdout.rows || 24;
    const top = H - this.footer + 1;
    process.stdout.write = this._origWrite || process.stdout.write;
    this._write(`${ESC}[r${ESC}[${top};1H${ESC}[J${ESC}[?2004l${ESC}[?25h`);
    process.stdin.pause();
  }

  setCommands(list) { this.commands = list; }
  setStatus(patch)  { Object.assign(this.status, patch); if (this.active) this._paint(false); }

  /** Resolve with the next submitted text (null if the terminal closed). */
  ask() {
    if (this.fallback) {
      this._rl = this._rl || readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise(res => {
        const onClose = () => res(null);
        this._rl.once('close', onClose);
        this._rl.question('\n\x1b[96m❯\x1b[0m ', a => { this._rl.off('close', onClose); res(a); });
      });
    }
    return new Promise(res => { this._askRes = res; });
  }

  // ── Output interception: keep program output inside the scroll region ──────

  _intercept(chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (!this.active) return this._write(chunk, enc, cb);
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    // back to the saved output position → write → save new position → repaint footer
    const seq = (this.atCaret ? `${ESC}8` : '') + text + `${ESC}7`;
    this.atCaret = true;
    this._write(seq + this._render(true));
    if (cb) cb();
    return true;
  }

  // ── Layout / rendering ─────────────────────────────────────────────────────

  _menuItems() {
    if (this.buf.includes('\n') || !this.buf.startsWith('/')) return [];
    const q = this.buf.toLowerCase();
    return this.commands.filter(([c]) => c.startsWith(q)).slice(0, 10);
  }

  _layout() {
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;
    const textW = Math.max(10, W - 4);
    const rows = [];
    let caret = { row: 0, col: 0 }, off = 0;

    this.buf.split('\n').forEach((ln, li) => {
      const n = ln.length, c = Math.max(1, Math.ceil(n / textW));
      for (let k = 0; k < c; k++) rows.push({ text: ln.slice(k * textW, (k + 1) * textW), first: li === 0 && k === 0 });
      if (this.cur >= off && this.cur <= off + n) {
        const k = Math.min(Math.floor((this.cur - off) / textW), c - 1);
        caret = { row: rows.length - c + k, col: this.cur - off - k * textW };
      }
      off += n + 1;
    });

    const maxIn = Math.max(1, Math.min(8, H - 10));
    const start = Math.min(Math.max(0, caret.row - maxIn + 1), Math.max(0, rows.length - maxIn));
    const win   = rows.slice(start, start + maxIn);
    const items = this._menuItems().slice(0, Math.max(0, H - 12));
    if (this.sel >= items.length) this.sel = -1;
    return { W, H, win, items, caretRow: caret.row - start, caretCol: caret.col, height: 1 + win.length + items.length + 1 };
  }

  _statusText(W) {
    const s = this.status;
    const parts = [
      s.busy ? `${SPIN[this.frame % SPIN.length]} working` : 'ready',
      s.step && s.busy ? `step ${s.step}` : null,
      s.ctx ? `ctx ${s.ctx}` : null,
      s.headless != null ? (s.headless ? 'headless' : 'window') : null,
      s.dir || null,
      s.busy ? 'esc stop · type to message' : '/ commands · alt+enter newline',
    ].filter(Boolean);
    const t = parts.join(' · ');
    return t.length > W - 2 ? t.slice(0, W - 3) + '…' : t;
  }

  /** Build the escape sequence that (re)paints the footer and parks the cursor in the input box. */
  _render(atOutputPos) {
    const L = this._layout();
    const { W, H } = L;
    let s = '';

    if (L.height !== this.footer) {
      if (!atOutputPos && this.footer) s += `${ESC}8`;            // return to output position first
      const oldBottom = this.footer ? H - this.footer : H;
      const newBottom = H - L.height;
      if (L.height > this.footer) s += `${ESC}[${oldBottom};1H` + '\n'.repeat(L.height - this.footer); // make room
      else if (this.footer) s += `${ESC}[${H - this.footer + 1};1H${ESC}[J`;                          // wipe the old, taller footer
      s += `${ESC}[1;${newBottom}r${ESC}[${newBottom};1H${ESC}7`;  // new region, remember output position
      this.footer = L.height;
    }

    const top = H - L.height + 1;
    s += `${ESC}[?25l${ESC}[${top};1H${ESC}[J` + gray('─'.repeat(W - 1));

    L.win.forEach((r, i) => {
      const body = this.buf === '' && r.first ? gray('Type a task…  (/ for commands)') : r.text;
      s += `${ESC}[${top + 1 + i};1H` + (r.first ? cyan('❯ ') : '  ') + body;
    });

    L.items.forEach(([c, d], i) => {
      const row = top + 1 + L.win.length + i;
      s += `${ESC}[${row};1H` + (i === this.sel
        ? `${ESC}[48;5;24m${ESC}[97m ▸ ${c.padEnd(15)} ${d} ${ESC}[0m`
        : `   ${cyan(c.padEnd(15))} ${gray(d)}`);
    });

    s += `${ESC}[${H};1H` + gray(this._statusText(W));
    s += `${ESC}[${top + 1 + L.caretRow};${3 + L.caretCol}H${ESC}[?25h`;
    return s;
  }

  _paint(atOutputPos) {
    if (!this.active) return;
    this._write(this._render(atOutputPos));
    this.atCaret = true;
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  _insert(str) {
    this.buf = this.buf.slice(0, this.cur) + str + this.buf.slice(this.cur);
    this.cur += str.length;
  }

  _lineStart() { return this.buf.lastIndexOf('\n', this.cur - 1) + 1; }
  _lineEnd()   { const i = this.buf.indexOf('\n', this.cur); return i < 0 ? this.buf.length : i; }

  _setBuf(text) { this.buf = text; this.cur = text.length; }

  _pick(run) {
    const cmd = this._menuItems()[this.sel][0];
    const hasArg = cmd.includes('<');
    this.sel = -1;
    this._setBuf(hasArg ? cmd.split(' <')[0] + ' ' : cmd);
    if (run && !hasArg) this._submit();
  }

  _submit() {
    let text = this.buf;
    if (text.endsWith('\\')) { this.buf = text.slice(0, -1) + '\n'; this.cur = this.buf.length; return; } // trailing \ = newline
    this.buf = ''; this.cur = 0; this.sel = -1; this.hIdx = -1;
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);

    // echo the submitted text into the scrollback like a chat message
    const lines = text.split('\n').map((l, i) => `${ESC}[48;5;236m ${i ? ' ' : '❯'} ${l} ${ESC}[0m`);
    process.stdout.write('\n' + lines.join('\n') + '\n');

    if (this._askRes) { const r = this._askRes; this._askRes = null; r(text); }
    else this.onBusyInput(text);
  }

  _key(str, key) {
    if (!this.active || !key) return;
    const n = key.name, seq = key.sequence || str || '';

    if (n === 'paste-start') { this.pasting = true;  return; }
    if (n === 'paste-end')   { this.pasting = false; this._paint(false); return; }

    const items = this._menuItems();
    const menu  = items.length > 0;

    if (NEWLINE_SEQ.includes(seq) || ((n === 'return' || n === 'enter') && (key.shift || key.meta || this.pasting))) {
      this._insert('\n');
    } else if (n === 'return' || n === 'enter') {
      if (menu && this.sel >= 0) this._pick(true); else this._submit();
    } else if (n === 'escape') {
      if (this.sel >= 0) this.sel = -1; else this.onEscape();
    } else if (key.ctrl && n === 'c') {
      if (this.buf && !this.status.busy) { this._setBuf(''); this.sel = -1; } else this.onInterrupt();
    } else if (key.ctrl && n === 'd') {
      if (!this.buf) this.onInterrupt();
    } else if (n === 'tab') {
      if (menu) { if (this.sel < 0) this.sel = 0; this._pick(false); }
    } else if (n === 'up' || n === 'down') {
      const d = n === 'up' ? -1 : 1;
      if (menu) this.sel = (this.sel + d + items.length) % items.length;
      else if (this.buf.includes('\n')) this._moveLine(d);
      else this._historyStep(d);
    } else if (n === 'left')  { this.cur = Math.max(0, this.cur - 1); }
    else if (n === 'right')   { this.cur = Math.min(this.buf.length, this.cur + 1); }
    else if (n === 'home' || (key.ctrl && n === 'a')) { this.cur = this._lineStart(); }
    else if (n === 'end'  || (key.ctrl && n === 'e')) { this.cur = this._lineEnd(); }
    else if (n === 'backspace') {
      if (this.cur > 0) { this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur); this.cur--; }
      this.sel = -1;
    } else if (n === 'delete') {
      this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
    } else if (key.ctrl && n === 'u') {
      const ls = this._lineStart(); this.buf = this.buf.slice(0, ls) + this.buf.slice(this.cur); this.cur = ls;
    } else if (key.ctrl && n === 'k') {
      this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this._lineEnd());
    } else if (key.ctrl && n === 'w') {
      const head = this.buf.slice(0, this.cur).replace(/\s*\S*$/, '');
      this.buf = head + this.buf.slice(this.cur); this.cur = head.length;
    } else if (str && !key.ctrl && !key.meta && str >= ' ') {
      this._insert(str); this.sel = -1;
    } else {
      return;
    }
    if (!this.pasting) this._paint(false);
  }

  _moveLine(d) {
    const ls = this._lineStart(), col = this.cur - ls;
    if (d < 0) {
      if (ls === 0) return;
      const ps = this.buf.lastIndexOf('\n', ls - 2) + 1;
      this.cur = ps + Math.min(col, ls - 1 - ps);
    } else {
      const le = this._lineEnd();
      if (le >= this.buf.length) return;
      const ne = this.buf.indexOf('\n', le + 1), end = ne < 0 ? this.buf.length : ne;
      this.cur = le + 1 + Math.min(col, end - le - 1);
    }
  }

  _historyStep(d) {
    if (!this.history.length) return;
    if (this.hIdx === -1) { if (d > 0) return; this.draft = this.buf; this.hIdx = this.history.length; }
    this.hIdx += d;
    if (this.hIdx >= this.history.length) { this.hIdx = -1; this._setBuf(this.draft); return; }
    this.hIdx = Math.max(0, this.hIdx);
    this._setBuf(this.history[this.hIdx]);
  }
}

module.exports = InputUI;
