'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { parseResponse, extractCommentary } = require('../src/parser');

const FENCE = '```';

test('fenced tool_call block', () => {
  const r = parseResponse(`${FENCE}tool_call\n{"name":"read_file","args":{"path":"a.js"}}\n${FENCE}`);
  assert.deepStrictEqual([r.type, r.name, r.args], ['tool_call', 'read_file', { path: 'a.js' }]);
});

test('bare tool_call text (DOM-stripped fence)', () => {
  const r = parseResponse('tool_call\n{"name":"list_directory","args":{"path":"."}}');
  assert.strictEqual(r.name, 'list_directory');
});

test('trailing comma is repaired', () => {
  const r = parseResponse(`${FENCE}tool_call\n{"name":"read_file","args":{"path":"a",},}\n${FENCE}`);
  assert.strictEqual(r.type, 'tool_call');
});

test('invalid JSON in tool_call fence is a parse error', () => {
  assert.strictEqual(parseResponse(`${FENCE}tool_call\n{nope\n${FENCE}`).type, 'error');
});

test('final answer quoting a package.json is NOT a tool call', () => {
  const r = parseResponse(`Done. Your package:\n${FENCE}json\n{"name":"my-app","version":"1.0.0"}\n${FENCE}`);
  assert.strictEqual(r.type, 'final');
});

test('loose json block with a real tool name still works', () => {
  const r = parseResponse(`${FENCE}json\n{"name":"run_command","args":{"command":"ls"}}\n${FENCE}`);
  assert.strictEqual(r.name, 'run_command');
});

test('thinking blocks are stripped', () => {
  const r = parseResponse('<think>hmm {"name":"delete_file"}</think>All done.');
  assert.deepStrictEqual([r.type, r.content], ['final', 'All done.']);
});

test('commentary before a tool call is extracted', () => {
  const t = `Reading the file first.\n${FENCE}tool_call\n{"name":"read_file","args":{"path":"a"}}\n${FENCE}`;
  assert.strictEqual(extractCommentary(t), 'Reading the file first.');
});

test('browser tool via loose json block', () => {
  const r = parseResponse(`${FENCE}json\n{"name":"browser_click","args":{"ref":3}}\n${FENCE}`);
  assert.deepStrictEqual([r.type, r.name, r.args], ['tool_call', 'browser_click', { ref: 3 }]);
});

test('registered MCP tool is recognised, unknown one is not', () => {
  require('../src/tools').registerTool('mcp__demo__ping', { description: 'x', parameters: {}, execute: async () => 'pong' });
  assert.strictEqual(parseResponse(`${FENCE}json\n{"name":"mcp__demo__ping","args":{}}\n${FENCE}`).name, 'mcp__demo__ping');
  assert.strictEqual(parseResponse(`${FENCE}json\n{"name":"mcp__nope__x","args":{}}\n${FENCE}`).type, 'final');
});
