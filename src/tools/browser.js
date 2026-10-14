// src/tools/browser.js — Agent-controlled browser tab (+ optional attach to an external browser over CDP)
'use strict';

const config       = require('../config');
const { truncate } = require('./util');

// host = the DeepSeekBrowser (its context is read lazily, so /headless relaunch just works)
// tab  = the page the browser_* tools act on
// cdp  = external browser attached with browser_connect (AdsPower profile, Chrome with --remote-debugging-port…)
const web = { host: null, tab: null, cdp: null };

/** Give the tools access to the DeepSeek browser */
function bind(host) {
  web.host = host;
}

function context() {
  if (web.cdp) return web.cdp.contexts()[0] || null;
  return web.host?.context || null;
}

/** Pages the agent may use: everything in the context except the DeepSeek chat */
function tabs() {
  const ctx = context();
  return ctx ? ctx.pages().filter(p => p !== web.host?.page && !p.isClosed()) : [];
}

async function page() {
  if (web.tab && !web.tab.isClosed()) return web.tab;
  const ctx = context() || (web.cdp && await web.cdp.newContext());
  if (!ctx) throw new Error('Browser is not running');
  web.tab = await ctx.newPage();
  web.tab.setDefaultTimeout(config.WEB_TIMEOUT);
  return web.tab;
}

/** Run fn on the agent tab; the DeepSeek tab goes back to front afterwards so its streaming is never backgrounded */
async function withTab(fn) {
  const p = await page();
  await p.bringToFront().catch(() => {});
  try {
    return await fn(p);
  } finally {
    if (!web.cdp && web.host?.page) await web.host.page.bringToFront().catch(() => {});
  }
}

async function settle(p) {
  await p.waitForTimeout(300);
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  await p.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
}

/** If the last action opened a popup / target=_blank tab, continue in it */
function followNewTab(before) {
  const all = tabs();
  if (all.length <= before) return '';
  web.tab = all[all.length - 1];
  web.tab.setDefaultTimeout(config.WEB_TIMEOUT);
  return 'A new tab was opened — switched to it.\n';
}

// ─────────────────────────────────────────────
//  Snapshot: page text + numbered interactive elements
// ─────────────────────────────────────────────

// Runs inside the page. Marks visible interactive elements with data-dsa-ref="N".
function snapshotInPage(maxItems) {
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
    '[role=radio]', '[role=option]', '[role=switch]', '[role=combobox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]',
  ].join(',');
  const clean   = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  document.querySelectorAll('[data-dsa-ref]').forEach(el => el.removeAttribute('data-dsa-ref'));
  const items = [];
  let more = false;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    if (items.length >= maxItems) { more = true; break; }
    const n     = items.length + 1;
    const tag   = el.tagName.toLowerCase();
    const kind  = el.getAttribute('role') || el.getAttribute('type') || '';
    const label = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') ||
                        el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name'));
    const value = ['input', 'textarea', 'select'].includes(tag) && el.value && kind !== 'password'
      ? ` value="${clean(el.value)}"` : '';
    const href  = tag === 'a' ? ` → ${el.getAttribute('href')}` : '';
    el.setAttribute('data-dsa-ref', n);
    items.push(`[${n}] ${tag}${kind ? ' ' + kind : ''} "${label}"${value}${href}`);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { url: location.href, title: document.title, text, items, more };
}

// Actions (click/type/press/wait) pass a small textChars: the element list is what matters there, and every
// snapshot stays in the chat — full snapshots after each step would eat the context fast
const ACTION_TEXT = 800;

async function snapshot(p, textChars = 3_000) {
  const s    = await p.evaluate(snapshotInPage, 80);
  const text = s.text.length > textChars
    ? s.text.slice(0, textChars) + `\n… (${s.text.length} chars total — use browser_read for the full text)`
    : s.text;
  return truncate([
    `[${s.title || 'untitled'}] ${s.url}`,
    '',
    'TEXT:',
    text || '(no text)',
    '',
    `INTERACTIVE ELEMENTS (${s.items.length}${s.more ? '+, first shown' : ''}) — pass "ref" to browser_click / browser_type:`,
    s.items.join('\n') || '(none)',
  ].join('\n'));
}

/** Locator from ref (snapshot number), CSS selector or visible text */
async function locate(p, { ref, selector, text }) {
  let loc;
  if (ref != null)    loc = p.locator(`[data-dsa-ref="${Number(ref)}"]`);
  else if (selector)  loc = p.locator(String(selector)).first();
  else if (text)      loc = p.getByText(String(text)).first();
  else throw new Error('Pass "ref" (from the last snapshot), "selector" or "text"');
  if (ref != null && await loc.count() === 0) {
    throw new Error(`ref ${ref} not found — the page changed, call browser_snapshot again`);
  }
  return loc;
}

// ─────────────────────────────────────────────
//  Tools
// ─────────────────────────────────────────────

const REF = { type: 'number', required: false, description: 'Element number from the last snapshot' };
const CSS = { type: 'string', required: false, description: 'CSS selector (if no ref)' };

const tools = {

  browser_open: {
    description: 'Open a URL in the agent browser tab (runs JavaScript, keeps cookies). Returns page text + numbered interactive elements.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to open, or "back" / "forward"' },
    },
    async execute({ url }) {
      return withTab(async p => {
        let status = 0;
        if (url === 'back')         await p.goBack();
        else if (url === 'forward') await p.goForward();
        else {
          const target = /^[a-z][\w+.-]*:/i.test(url) ? url : 'https://' + url;
          const res    = await p.goto(target, { waitUntil: 'domcontentloaded' });
          status       = res ? res.status() : 0;
        }
        await settle(p);
        return (status >= 400 ? `⚠ HTTP ${status}\n` : '') + await snapshot(p);
      });
    },
  },

  browser_snapshot: {
    description: 'Show the current page: URL, title, visible text and numbered interactive elements (refs). Refs change after every snapshot.',
    parameters: {},
    async execute() {
      return withTab(p => snapshot(p));
    },
  },

  browser_read: {
    description: 'Read the full visible text of the page (or one element), in chunks. Use for long docs/articles.',
    parameters: {
      selector : { type: 'string', required: false, description: 'CSS selector of the element to read (default: whole page)' },
      offset   : { type: 'number', required: false, description: 'Character offset to start from (default: 0)' },
    },
    async execute({ selector, offset = 0 }) {
      return withTab(async p => {
        const text  = selector
          ? await p.locator(String(selector)).first().innerText()
          : await p.evaluate(() => (document.body ? document.body.innerText : ''));
        const start = Math.max(0, Number(offset) || 0);
        const chunk = text.slice(start, start + config.MAX_OUTPUT_LENGTH);
        const end   = start + chunk.length;
        return `[${p.url()} | chars ${start}–${end} of ${text.length}]\n${chunk}` +
          (end < text.length ? `\n\n… more text: call browser_read with offset=${end}` : '');
      });
    },
  },

  browser_click: {
    description: 'Click an element (by ref from the snapshot, CSS selector or visible text). Returns the new snapshot.',
    parameters: {
      ref      : REF,
      selector : CSS,
      text     : { type: 'string', required: false, description: 'Visible text of the element (if no ref/selector)' },
    },
    async execute(args) {
      return withTab(async p => {
        const before = tabs().length;
        await (await locate(p, args)).click();
        await settle(p);
        const note = followNewTab(before);
        return note + await snapshot(web.tab, ACTION_TEXT);
      });
    },
  },

  browser_type: {
    description: 'Type text into an input / textarea / editable element. Optionally press Enter. Returns the new snapshot.',
    parameters: {
      ref      : REF,
      selector : CSS,
      text     : { type: 'string',  required: true,  description: 'Text to type' },
      submit   : { type: 'boolean', required: false, description: 'Press Enter after typing (default: false)' },
      clear    : { type: 'boolean', required: false, description: 'Replace the current value (default: true); false appends' },
    },
    async execute({ ref, selector, text, submit = false, clear = true }) {
      return withTab(async p => {
        const loc   = await locate(p, { ref, selector });
        const value = String(text);
        try {
          if (clear) await loc.fill(value);
          else       await loc.pressSequentially(value);
        } catch {
          // Custom widgets that are not fillable: focus and type like a user
          await loc.click();
          await p.keyboard.type(value);
        }
        if (submit) await loc.press('Enter');
        await settle(p);
        return await snapshot(p, ACTION_TEXT);
      });
    },
  },

  browser_press: {
    description: 'Press a keyboard key (Enter, Escape, Tab, ArrowDown, PageDown, Control+A…), optionally on an element.',
    parameters: {
      key : { type: 'string', required: true, description: 'Key name, Playwright syntax' },
      ref : REF,
    },
    async execute({ key, ref }) {
      return withTab(async p => {
        if (ref != null) await (await locate(p, { ref })).press(key);
        else             await p.keyboard.press(key);
        await settle(p);
        return await snapshot(p, ACTION_TEXT);
      });
    },
  },

  browser_wait: {
    description: 'Wait for an element or text to appear, or just pause. Returns the new snapshot.',
    parameters: {
      selector : { type: 'string', required: false, description: 'CSS selector to wait for' },
      text     : { type: 'string', required: false, description: 'Visible text to wait for' },
      ms       : { type: 'number', required: false, description: 'Max wait in ms (default 10000, max 30000); alone = plain pause' },
    },
    async execute({ selector, text, ms }) {
      return withTab(async p => {
        const timeout = Math.min(Number(ms) || 10_000, 30_000);
        if (selector)  await p.locator(String(selector)).first().waitFor({ timeout });
        else if (text) await p.getByText(String(text)).first().waitFor({ timeout });
        else           await p.waitForTimeout(timeout);
        return await snapshot(p, ACTION_TEXT);
      });
    },
  },

  browser_eval: {
    description: 'Run JavaScript in the page and return the result as JSON. An expression ("document.title") or a function body with return.',
    parameters: {
      script: { type: 'string', required: true, description: 'JS expression or function body (await allowed)' },
    },
    async execute({ script }) {
      return withTab(async p => {
        let result;
        try {
          result = await p.evaluate(script);
        } catch (err) {
          if (!/SyntaxError|Illegal return/i.test(err.message)) throw err;
          result = await p.evaluate(`(async () => { ${script} })()`);
        }
        return truncate(typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'undefined'));
      });
    },
  },

  browser_tab: {
    description: 'Manage agent browser tabs: list, switch to one, open a new one, or close one.',
    parameters: {
      action : { type: 'string', required: true,  description: 'list | switch | new | close' },
      index  : { type: 'number', required: false, description: 'Tab index from "list" (switch/close; close defaults to the current tab)' },
      url    : { type: 'string', required: false, description: 'URL to open in the new tab (action "new")' },
    },
    async execute({ action, index, url }) {
      const list = () => tabs().map((t, i) => `${t === web.tab ? '*' : ' '} [${i}] ${t.url()}`).join('\n') || '(no tabs)';
      switch (action) {
        case 'list':
          return list();
        case 'new':
          web.tab = null;
          return url ? tools.browser_open.execute({ url }) : withTab(p => snapshot(p));
        case 'switch': {
          const t = tabs()[index];
          if (!t) throw new Error(`No tab ${index}. Tabs:\n${list()}`);
          web.tab = t;
          return withTab(p => snapshot(p));
        }
        case 'close': {
          const t = index != null ? tabs()[index] : web.tab;
          if (!t || t.isClosed()) throw new Error(`No tab ${index ?? '(current)'}. Tabs:\n${list()}`);
          await t.close();
          if (web.tab === t) web.tab = tabs().pop() || null;
          return 'Closed.\n' + list();
        }
        default:
          throw new Error('action must be one of: list, switch, new, close');
      }
    },
  },

  browser_connect: {
    description: 'Attach the browser tools to an external Chromium over CDP (e.g. the ws endpoint returned when an AdsPower profile starts). Next browser_* calls open a tab there.',
    parameters: {
      endpoint: { type: 'string', required: true, description: 'ws://… or http://host:port CDP endpoint' },
    },
    async execute({ endpoint }) {
      await disconnect();
      const { chromium } = require('playwright');
      const browser = await chromium.connectOverCDP(endpoint, { timeout: config.WEB_TIMEOUT });
      browser.on('disconnected', () => {
        if (web.cdp === browser) { web.cdp = null; web.tab = null; }
      });
      web.cdp = browser;
      web.tab = null;
      return `Connected to ${endpoint}. ${tabs().length} tab(s) already open — browser_tab list/switch to use one, ` +
        'or any browser_* call opens a new tab.';
    },
  },

  browser_close: {
    description: 'Close the agent tab. If attached with browser_connect, also detach (the external browser keeps running).',
    parameters: {},
    async execute() {
      if (web.tab && !web.tab.isClosed()) await web.tab.close().catch(() => {});
      web.tab = null;
      if (!web.cdp) return 'Closed the agent tab.';
      await disconnect();
      return 'Closed the agent tab and detached from the external browser.';
    },
  },

};

async function disconnect() {
  const browser = web.cdp;
  web.cdp = null;
  web.tab = null;
  if (browser) await browser.close().catch(() => {});
}

// closeWeb (shutdown): detach from CDP, never kills the external browser; the DeepSeek context closes our own tabs
module.exports = { tools, bind, closeWeb: disconnect };
