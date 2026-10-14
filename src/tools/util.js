// src/tools/util.js — Shared helpers for tool implementations
'use strict';

const fs     = require('fs');
const path   = require('path');
const config = require('../config');

// Directories never worth walking into
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/** Truncate long strings so they don't blow up the context window */
function truncate(str, max = config.MAX_OUTPUT_LENGTH) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n\n⚠ [OUTPUT TRUNCATED — ${s.length.toLocaleString()} chars total, showing first & last ${half} chars]\n\n` +
    s.slice(-half)
  );
}

/** Resolve a path relative to the working directory */
function resolve(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(config.WORKING_DIR, filePath);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Path as the agent should pass it back to tools (relative to the working directory) */
function rel(abs) {
  return path.relative(config.WORKING_DIR, abs) || '.';
}

/**
 * Recursive directory listing in pure Node (no shell, works on Windows).
 * Returns absolute paths (directories end with path.sep), directories first per level, sorted; stops at `limit`.
 */
function walk(root, { hidden = false, maxDepth = Infinity, limit = 300, files = true, dirs = true } = {}) {
  const out = [];
  (function visit(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(e.name) || (!hidden && e.name.startsWith('.'))) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (dirs) out.push(abs + path.sep);
        if (depth < maxDepth) visit(abs, depth + 1);
      } else if (files) {
        out.push(abs);
      }
    }
  })(root, 1);
  return out;
}

/** Glob for a file name ("*.test.js", "test_?.py") → RegExp */
function globToRegExp(glob) {
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

module.exports = { truncate, resolve, formatBytes, rel, walk, globToRegExp };
