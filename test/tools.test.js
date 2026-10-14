'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const config = require('../src/config');
const { executeTool } = require('../src/tools');
const { stopProcesses } = require('../src/tools/shell');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tools-'));
config.WORKING_DIR = dir;
const file = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const read = p => fs.readFileSync(path.join(dir, p), 'utf8');
test.after(() => { stopProcesses(); fs.rmSync(dir, { recursive: true, force: true }); });

test('read_file numbers lines and pages long files by whole lines', async () => {
  file('long.txt', Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const first = await executeTool('read_file', { path: 'long.txt' });
  assert.match(first, /^\[long\.txt \| lines 1–\d+ of 5000\]\n1: line 1\n/);
  const next = Number(first.match(/start_line=(\d+)/)[1]);
  assert.ok(first.includes(`${next - 1}: line ${next - 1}`) && !first.includes('TRUNCATED'));
  const second = await executeTool('read_file', { path: 'long.txt', start_line: next, end_line: next + 1 });
  assert.match(second, new RegExp(`^\\[long\\.txt \\| lines ${next}–${next + 1} of 5000\\]`));
});

test('write_file overwrites and appends', async () => {
  await executeTool('write_file', { path: 'a/b.txt', content: 'one\n' });
  await executeTool('write_file', { path: 'a/b.txt', content: 'two\n', append: true });
  assert.strictEqual(read('a/b.txt'), 'one\ntwo\n');
});

test('replace_in_file keeps "$&" literally and requires a unique match', async () => {
  file('r.js', 'const a = X;\nconst b = Y;\nconst c = Y;\n');
  await executeTool('replace_in_file', { path: 'r.js', find: 'X', replace: '"cost $& $1"' });
  assert.strictEqual(read('r.js').split('\n')[0], 'const a = "cost $& $1";');
  await assert.rejects(executeTool('replace_in_file', { path: 'r.js', find: 'Y', replace: 'Z' }), /matches 2 times/);
  await assert.rejects(executeTool('replace_in_file', { path: 'r.js', find: 'nope', replace: 'Z' }), /No match/);
  await executeTool('replace_in_file', { path: 'r.js', find: 'Y', replace: 'Z', all_occurrences: true });
  await executeTool('replace_in_file', { path: 'r.js', find: 'const (\\w) = Z', replace: 'let $1 = Z', use_regex: true, all_occurrences: true });
  assert.strictEqual(read('r.js'), 'const a = "cost $& $1";\nlet b = Z;\nlet c = Z;\n');
});

test('list_directory / find_files / search_in_files skip node_modules and work without a shell', async () => {
  file('src/app.test.js', 'it("x")\n// TODO: fix "quotes" $(here)\n');
  file('src/app.js', 'one\ntwo\nthree\nfour\n');
  file('node_modules/pkg/index.js', '// TODO: fix');
  assert.match(await executeTool('list_directory', { recursive: true }), /^src\/$/m);
  assert.doesNotMatch(await executeTool('list_directory', { recursive: true }), /node_modules/);
  assert.strictEqual(await executeTool('find_files', { pattern: '*.test.js' }), path.join('src', 'app.test.js'));
  assert.match(await executeTool('search_in_files', { pattern: 'TODO: fix "quotes" $(here)' }), /^src\/app\.test\.js:2: \/\/ TODO/m);
  assert.strictEqual(
    await executeTool('search_in_files', { pattern: '^three$', context_lines: 1 }),
    'src/app.js:2- two\nsrc/app.js:3: three\nsrc/app.js:4- four'
  );
});

test('run_command returns stdout+stderr and reports failures', async () => {
  assert.strictEqual(await executeTool('run_command', { command: 'echo out; echo err 1>&2' }), 'out\nerr');
  await assert.rejects(executeTool('run_command', { command: 'echo bad; exit 3' }), /exit code 3[\s\S]*bad/);
});

test('run_command timeout and abort kill the process without blocking the event loop', async () => {
  await assert.rejects(executeTool('run_command', { command: 'sleep 5', timeout: 300 }), /timed out after 300 ms/);

  const ctrl  = new AbortController();
  let ticks   = 0;
  const timer = setInterval(() => ticks++, 20);
  setTimeout(() => ctrl.abort(), 300);
  const t0 = Date.now();
  await assert.rejects(executeTool('run_command', { command: 'sleep 5' }, { signal: ctrl.signal }), /stopped by user/);
  clearInterval(timer);
  assert.ok(Date.now() - t0 < 2_000 && ticks > 5, 'event loop kept running and the command died fast');
});

test('run_command background returns pid + log and keeps running', async () => {
  const out = await executeTool('run_command', { command: 'echo started; sleep 30', background: true });
  assert.match(out, /running, pid (\d+)/);
  assert.match(out, /First output:\nstarted/);
  const pid = Number(out.match(/pid (\d+)/)[1]);
  assert.doesNotThrow(() => process.kill(pid, 0));
  stopProcesses();
  await new Promise(r => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0));
});
