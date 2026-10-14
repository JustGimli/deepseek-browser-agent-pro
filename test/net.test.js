'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const { executeTool } = require('../src/tools');

test('read_url follows a relative redirect (was "Invalid URL")', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/final?x=1' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Final page</h1><p>' + 'docs text '.repeat(30) + '</p></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const out = await executeTool('read_url', { url: `http://127.0.0.1:${server.address().port}/start` });
  assert.match(out, /^\[HTTP 200 http:\/\/127\.0\.0\.1:\d+\/final\?x=1\]/);
  assert.match(out, /Final page/);
});

test('read_url rejects a relative URL with a clear message', async () => {
  await assert.rejects(executeTool('read_url', { url: '/docs/x' }), /Invalid URL "\/docs\/x"/);
});

test('missing required parameter is reported by name', async () => {
  await assert.rejects(executeTool('read_url', {}), /Missing required parameter\(s\) for read_url: url/);
});
