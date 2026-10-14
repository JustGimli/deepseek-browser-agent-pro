// src/tools/net.js — Plain HTTP fetching (no JavaScript execution)
'use strict';

const { truncate } = require('./util');

module.exports.tools = {

  // ── Fetch URL ───────────────────────────────────────────────────────────────
  read_url: {
    description: 'Fetch the text content of a URL over plain HTTP (no JavaScript). Good for static pages, raw files and JSON APIs. For JS-rendered sites use browser_open.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL to fetch (http or https)' },
    },
    async execute({ url }) {
      let parsed;
      try { parsed = new URL(url); } catch {}
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        throw new Error(`Invalid URL "${url}" — pass an absolute http(s):// URL`);
      }

      let res;
      try {
        // fetch follows redirects (including relative Location headers) by itself
        res = await fetch(parsed, {
          redirect: 'follow',
          signal  : AbortSignal.timeout(15_000),
          headers : {
            'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekAgent/1.0)',
            'Accept'    : 'text/html,text/plain,application/json',
          },
        });
      } catch (err) {
        throw new Error(`Fetch failed for ${url}: ${err.cause?.message || err.message}`);
      }

      // Strip HTML tags for readability
      const text = (await res.text())
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n\n')
        .trim();

      const head = `[HTTP ${res.status} ${res.url}]\n`;
      const hint = res.ok && text.length < 200
        ? '\n\n⚠ Almost no text — the page is probably rendered by JavaScript. Use browser_open to read it.'
        : '';
      return head + truncate(text) + hint;
    },
  },

};
