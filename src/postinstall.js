// src/postinstall.js — Runs after `npm install -g deepseek-browser-agent-pro`
// Automatically downloads the Playwright Chromium browser.
'use strict';

const { execFileSync } = require('child_process');
const path             = require('path');

// Skip in CI environments where a display isn't available
if (process.env.CI || process.env.SKIP_PLAYWRIGHT_INSTALL) {
  console.log('[deepseek-agent] Skipping Playwright browser install (CI detected).');
  process.exit(0);
}

console.log('');
console.log('╔══════════════════════════════════════════════════╗');
console.log('║   🤖  DeepSeek Browser Agent — Setup             ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log('');
console.log('  Downloading Playwright Chromium browser...');
console.log('  (This only happens once — ~150 MB)\n');

try {
  // Resolve playwright's CLI wherever npm put it (nested or hoisted)
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');

  execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });

  console.log('');
  console.log('  ✓ Browser installed successfully!');
  console.log('');
  console.log('  Get started:');
  console.log('    deepseek-agent --interactive');
  console.log('    deepseek-agent "build a REST API in Express"');
  console.log('');
} catch (err) {
  console.warn('');
  console.warn('  ⚠  Could not auto-install Chromium.');
  console.warn('  Run this manually to complete setup:');
  console.warn('');
  console.warn('    npx playwright install chromium');
  console.warn('');
  // Don't exit(1) — don't break the install if browser download fails
}
