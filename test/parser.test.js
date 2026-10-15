'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { parseResponse, extractCommentary, endsInUnterminatedString } = require('../src/parser');

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

// ── Mid-stream reads: truncated tool calls are "incomplete", not "error" ─────

test('tool_call read mid-stream (unterminated string) is incomplete, not an error', () => {
  // Captured before DeepSeek finished streaming a large content field.
  const r = parseResponse('tool_call\n{"name":"write_files","args":{"files":[{"path":"a.c","content":"/* start of a long file');
  assert.strictEqual(r.type, 'incomplete');
});

test('unclosed tool_call fence is incomplete', () => {
  const r = parseResponse(`${FENCE}tool_call\n{"name":"write_files","args":{"files":[`);
  assert.strictEqual(r.type, 'incomplete');
});

test('complete-but-malformed JSON (not mid-stream) stays an error', () => {
  // `{nope` is unbalanced but never inside an open string → a real model mistake.
  assert.strictEqual(parseResponse(`${FENCE}tool_call\n{nope\n${FENCE}`).type, 'error');
});

test('complete valid tool_call still parses (regression)', () => {
  const r = parseResponse(`${FENCE}tool_call\n{"name":"read_file","args":{"path":"a.js"}}\n${FENCE}`);
  assert.deepStrictEqual([r.type, r.name], ['tool_call', 'read_file']);
});

test('endsInUnterminatedString distinguishes truncation from malformed/complete', () => {
  assert.strictEqual(endsInUnterminatedString('{"a":"oops'), true);   // cut inside a string
  assert.strictEqual(endsInUnterminatedString('{nope'), false);       // malformed, no open string
  assert.strictEqual(endsInUnterminatedString('{"a":"ok"}'), false);  // balanced & complete
  assert.strictEqual(endsInUnterminatedString('{"a":"has \\" escaped"}'), false); // escaped quote
});

// ── ``` inside a JSON string must not end the tool_call block ───────────────

const README = `# app\n\n${FENCE}bash\nnpm i\n${FENCE}\n\nDone.`;
const writeReadme = JSON.stringify({ name: 'write_file', args: { path: 'README.md', content: README } });

test('tool_call whose content contains ``` parses (fenced)', () => {
  const r = parseResponse(`${FENCE}tool_call\n${writeReadme}\n${FENCE}`);
  assert.deepStrictEqual([r.type, r.name, r.args.content], ['tool_call', 'write_file', README]);
});

test('tool_call whose content contains ``` parses (bare)', () => {
  const r = parseResponse(`tool_call\n${writeReadme}`);
  assert.deepStrictEqual([r.type, r.args.content], ['tool_call', README]);
});

test('mid-stream read cut after an inner ``` is incomplete', () => {
  const cut = writeReadme.slice(0, writeReadme.indexOf('npm'));
  assert.strictEqual(parseResponse(`${FENCE}tool_call\n${cut}`).type, 'incomplete');
});
