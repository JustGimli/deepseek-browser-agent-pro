// src/tools/fs.js — File and directory tools
// (mkdir / move / copy / stat go through run_command — no point in a tool per shell one-liner)
'use strict';

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const { truncate, resolve, formatBytes, rel, walk } = require('./util');

/** Show a find/replace snippet in messages without dumping the whole thing */
const preview = s => JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s);

function writeFile(filePath, content, append = false) {
  const abs = resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(abs, String(content), 'utf8');
}

module.exports.tools = {

  // ── File Reading ────────────────────────────────────────────────────────────
  read_file: {
    description: 'Read a file with line numbers. Long files come in chunks — the result says which start_line to use next.',
    parameters: {
      path        : { type: 'string',  required: true,  description: 'Path to the file' },
      start_line  : { type: 'number',  required: false, description: 'First line to read (1-indexed, default 1)' },
      end_line    : { type: 'number',  required: false, description: 'Last line to read (inclusive)' },
    },
    async execute({ path: filePath, start_line, end_line }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs))            throw new Error(`File not found: ${filePath}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} is a directory`);

      const lines  = fs.readFileSync(abs, 'utf8').split('\n');
      const first  = Math.max(1, Number(start_line) || 1);
      const last   = Math.min(lines.length, Number(end_line) || lines.length);
      const budget = config.MAX_OUTPUT_LENGTH * 2; // code reads need more room than command output

      // Whole lines only, so the model never edits around a silently cut middle
      const out = [];
      let size  = 0;
      let shown = first - 1;
      for (let i = first; i <= last; i++) {
        const line = `${i}: ${lines[i - 1]}`;
        if (out.length && size + line.length > budget) break;
        out.push(line.length > budget ? truncate(line, budget) : line);
        size += line.length + 1;
        shown = i;
      }

      const more = shown < last ? `\n… more: call read_file with start_line=${shown + 1}` : '';
      return `[${filePath} | lines ${first}–${shown} of ${lines.length}]\n${out.join('\n')}${more}`;
    },
  },

  // ── File Writing ────────────────────────────────────────────────────────────
  write_file: {
    description: 'Create or overwrite a file (parent directories are created), or append to it. For changing part of an existing file use replace_in_file.',
    parameters: {
      path    : { type: 'string',  required: true,  description: 'Destination file path' },
      content : { type: 'string',  required: true,  description: 'Full file content (or the text to append)' },
      append  : { type: 'boolean', required: false, description: 'Append instead of overwriting (default: false)' },
    },
    async execute({ path: filePath, content, append = false }) {
      writeFile(filePath, content, append);
      const bytes = formatBytes(Buffer.byteLength(String(content), 'utf8'));
      return append
        ? `✓ Appended ${bytes} to ${filePath}`
        : `✓ Wrote ${bytes} (${String(content).split('\n').length} lines) → ${filePath}`;
    },
  },

  // ── Write Multiple Files (batch) ────────────────────────────────────────────
  write_files: {
    description: 'Write multiple files at once — useful for scaffolding projects.',
    parameters: {
      files: { type: 'array', required: true, description: 'Array of {path, content} objects' },
    },
    async execute({ files }) {
      if (!Array.isArray(files)) throw new Error('"files" must be an array of {path, content}');
      for (const f of files) writeFile(f.path, f.content);
      return `Wrote ${files.length} files:\n${files.map(f => `✓ ${f.path}`).join('\n')}`;
    },
  },

  // ── Find & Replace in File ──────────────────────────────────────────────────
  replace_in_file: {
    description: 'Edit a file by replacing text. "find" must match EXACTLY ONCE (copy it from read_file without line numbers, add surrounding lines to make it unique) unless all_occurrences=true.',
    parameters: {
      path           : { type: 'string',  required: true,  description: 'File path' },
      find           : { type: 'string',  required: true,  description: 'Exact text to find (or a JS regex with use_regex)' },
      replace        : { type: 'string',  required: true,  description: 'Replacement text (with use_regex, $1… refer to groups)' },
      use_regex      : { type: 'boolean', required: false, description: 'Treat "find" as a JS regex (default: false)' },
      all_occurrences: { type: 'boolean', required: false, description: 'Replace every match instead of requiring exactly one (default: false)' },
    },
    async execute({ path: filePath, find, replace, use_regex = false, all_occurrences = false }) {
      if (find === '') throw new Error('"find" must not be empty');
      const abs     = resolve(filePath);
      const content = fs.readFileSync(abs, 'utf8');
      const re      = use_regex ? new RegExp(find, 'g') : null;
      const count   = re ? (content.match(re) || []).length : content.split(find).length - 1;

      if (count === 0) {
        throw new Error(`No match for ${preview(find)} in ${filePath} — read the file and copy the exact text (whitespace included)`);
      }
      if (count > 1 && !all_occurrences) {
        throw new Error(`${preview(find)} matches ${count} times in ${filePath} — include more surrounding lines to make it unique, or set all_occurrences=true`);
      }

      // split/join: no "$&"-style substitution in plain replacements
      const updated = re ? content.replace(re, replace) : content.split(find).join(replace);
      fs.writeFileSync(abs, updated, 'utf8');
      return `✓ Replaced ${count} occurrence(s) in ${filePath}`;
    },
  },

  // ── Delete File ─────────────────────────────────────────────────────────────
  delete_file: {
    description: 'Permanently delete a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'File to delete' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
      fs.unlinkSync(abs);
      return `✓ Deleted ${filePath}`;
    },
  },

  // ── List Directory ──────────────────────────────────────────────────────────
  list_directory: {
    description: 'List files and folders in a directory, optionally recursive (node_modules, .git, dist, build are skipped).',
    parameters: {
      path        : { type: 'string',  required: false, description: 'Directory to list (default: working dir)' },
      recursive   : { type: 'boolean', required: false, description: 'Recurse into sub-directories (default: false)' },
      show_hidden : { type: 'boolean', required: false, description: 'Include hidden files starting with . (default: false)' },
    },
    async execute({ path: dirPath = '.', recursive = false, show_hidden = false }) {
      const abs = resolve(dirPath);
      if (!fs.existsSync(abs))             throw new Error(`Directory not found: ${dirPath}`);
      if (!fs.statSync(abs).isDirectory()) throw new Error(`${dirPath} is not a directory`);

      if (recursive) {
        const all = walk(abs, { hidden: show_hidden });
        return all.map(p => rel(p) + (p.endsWith(path.sep) ? '/' : '')).join('\n') || '(empty)';
      }

      // One level: show everything (node_modules too — tells the model deps are installed)
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => show_hidden || !e.name.startsWith('.'))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      if (entries.length === 0) return `(empty directory: ${dirPath})`;

      const lines = entries.map(e => {
        if (e.isDirectory()) return `📁  ${e.name}/`;
        try { return `📄  ${e.name}  ${formatBytes(fs.statSync(path.join(abs, e.name)).size)}`; }
        catch { return `📄  ${e.name}`; }
      });
      return `[${dirPath}] — ${entries.length} items\n${lines.join('\n')}`;
    },
  },

};
