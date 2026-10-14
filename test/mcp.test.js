'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { TOOLS, executeTool } = require('../src/tools');
const { connectMcpServers, closeMcp } = require('../src/mcp');

// Tiny stdio MCP server with one "echo" tool, run via `node -e` (a file under test/ would be picked up by node --test)
const FAKE_SERVER = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

process.stdout.write('not json noise\n');
rl.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
  if (method === 'tools/list') return send({ id, result: { tools: [{
    name: 'echo', description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo' }, mode: { enum: ['plain', 'loud'] } }, required: ['text'] },
  }] } });
  if (method === 'tools/call') {
    const { text, mode } = params.arguments;
    if (text === 'fail') return send({ id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    return send({ id, result: { content: [{ type: 'text', text: mode === 'loud' ? text.toUpperCase() : text }] } });
  }
  if (id != null) send({ id, error: { code: -32601, message: 'Method not found' } });
});
`;

test('MCP stdio server tools are registered and callable', async t => {
  t.after(closeMcp);
  await connectMcpServers({
    'fake-server': { command: process.execPath, args: ['-e', FAKE_SERVER] },
    broken       : { command: 'definitely-not-a-command-xyz' },
  });

  const tool = TOOLS.mcp__fake_server__echo;
  assert.ok(tool, 'tool registered with sanitized name');
  assert.deepStrictEqual(tool.parameters.text, { type: 'string', required: true, description: 'What to echo' });
  assert.strictEqual(tool.parameters.mode.description, 'one of: plain | loud');

  assert.strictEqual(await executeTool('mcp__fake_server__echo', { text: 'hi', mode: 'loud' }), 'HI');
  await assert.rejects(executeTool('mcp__fake_server__echo', { text: 'fail' }), /boom/);
  assert.ok(!Object.keys(TOOLS).some(n => n.startsWith('mcp__broken__')), 'failed server registers nothing');
});
