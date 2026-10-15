// src/parser.js — Parse DeepSeek's text responses to extract tool calls
'use strict';

const { TOOLS } = require('./tools');

const isTool = name => typeof name === 'string' && Object.hasOwn(TOOLS, name);
const call   = (name, args, raw) => ({ type: 'tool_call', name, args, raw });

/** JSON.parse, then a repaired retry (trailing commas, unquoted keys); null if neither works */
function parseJson(str) {
  try { return JSON.parse(str); } catch { return attemptJsonFix(str); }
}

/**
 * Parsed object → tool call when it names a tool ("name" / "tool" / "function").
 * knownOnly: loose strategies accept only real tool names, so a final answer that quotes
 * e.g. a package.json ({"name": "my-app"}) is not mistaken for a tool call.
 */
function asCall(obj, raw, knownOnly = false) {
  const name = obj && typeof obj === 'object' ? (obj.name || obj.tool || obj.function) : undefined;
  if (typeof name !== 'string' || (knownOnly && !isTool(name))) return null;
  return call(name, argsOf(obj), raw);
}

/**
 * Parse a raw DeepSeek response string.
 *
 * Returns one of:
 *   { type: 'tool_call', name: string, args: object, raw: string }
 *   { type: 'final',     content: string,            raw: string }
 *   { type: 'error',     message: string,            raw: string }
 */
function parseResponse(rawText) {
  const text = stripThinkingBlocks(rawText).trim();

  // ── DSML: DeepSeek's native tool-call markup ──────────────────────────────
  //  Rendered as text like:  < | DSML | invoke name="read_file"> ... parameter name="path" string="true">x</ | DSML | parameter>
  const dsml = parseDsml(text);
  if (dsml) return call(dsml.name, dsml.args, rawText);

  // ── Bare "tool_call\n{ ... }" — the ```tool_call fence got lost in the DOM ─
  const bare = text.match(/^tool_call\s*\n([\s\S]+)$/i);
  const bareCall = bare && asCall(parseJson(bare[1].trim()), rawText);
  if (bareCall) return bareCall;

  // ── Read mid-stream: a tool_call whose JSON/fence was cut off part-way ────
  //  Not the model's fault — the DOM was scraped before DeepSeek finished.
  //  Signal "incomplete" so the agent re-reads instead of reporting an error.
  if (looksIncompleteToolCall(text)) return { type: 'incomplete', raw: rawText };

  // ── PRIMARY: ```tool_call fenced block (fence rebuilt by getFullText) ─────
  //  Invalid JSON here is a real error worth reporting back to the model.
  const fenced = text.match(/```tool_call\s*([\s\S]*?)```/i);
  if (fenced) {
    const body = fenced[1].trim();
    let obj, err = '';
    try { obj = JSON.parse(body); } catch (e) { err = e.message; obj = attemptJsonFix(body); }
    if (!obj) {
      return { type: 'error', message: 'tool_call block had invalid JSON: ' + err + '\nContent: ' + body.slice(0, 300), raw: rawText };
    }
    const fencedCall = asCall(obj, rawText);
    if (fencedCall) return fencedCall;
  }

  // ── ```json block with a known tool name ─────────────────────────────────
  const jsonFence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonCall  = jsonFence && asCall(parseJson(jsonFence[1]), rawText, true);
  if (jsonCall) return jsonCall;

  // ── XML <tool_call><name>…</name><input|args>…</…></tool_call> ───────────
  const xml = text.match(
    /<tool_call[^>]*>\s*(?:<name>([\s\S]*?)<\/name>\s*)?(?:<input>([\s\S]*?)<\/input>|<args>([\s\S]*?)<\/args>)\s*<\/tool_call>/i
  );
  if (xml && (xml[1] || '').trim()) {
    const name     = xml[1].trim();
    const inputRaw = stripCodeFences((xml[2] || xml[3] || '').trim());
    const args     = parseJson(inputRaw);
    if (args) return call(name, args, rawText);
    return { type: 'error', message: `Tool "${name}" returned invalid JSON\nRaw input: ${inputRaw.slice(0, 200)}`, raw: rawText };
  }

  // ── Any JSON object with a known tool name anywhere in the text ───────────
  if (/["'](?:name|tool|function)["']\s*:\s*["'][\w_]+["']/.test(text)) {
    const anyCall = asCall(extractLargestJsonObject(text), rawText, true);
    if (anyCall) return anyCall;
  }

  // ── Python-style call in a code block:  ```read_file(path="a.js")``` ──────
  const funcMatch = text.match(/```\w*\s*([\w_]+)\(([^)]*)\)\s*```/);
  if (funcMatch && isTool(funcMatch[1])) {
    const args  = {};
    const argRe = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b))/g;
    let   m;
    while ((m = argRe.exec(funcMatch[2])) !== null) {
      const key = m[1];
      if      (m[2] !== undefined) args[key] = m[2];
      else if (m[3] !== undefined) args[key] = m[3];
      else if (m[4] !== undefined) args[key] = parseFloat(m[4]);
      else if (m[5] !== undefined) args[key] = m[5] === 'true';
    }
    if (Object.keys(args).length > 0) return call(funcMatch[1], args, rawText);
  }

  // ── No tool call detected — final prose response ──────────────────────────
  return { type: 'final', content: text, raw: rawText };
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Args of a parsed tool object; if the model flattened them next to "name", use those */
function argsOf(o) {
  const a = o.args || o.arguments || o.parameters || o.input;
  if (a) return a;
  const { name, tool, function: fn, ...rest } = o;
  return rest;
}

/** Parse DeepSeek-native DSML invoke/parameter markup. Returns {name,args} or null. */
function parseDsml(text) {
  const inv = text.match(/DSML[^>]*?invoke\s+name="([\w.-]+)"\s*>([\s\S]*)/i);
  if (!inv) return null;

  const args = {};
  const re   = /parameter\s+name="([\w.-]+)"([^>]*)>([\s\S]*?)<\/[^>]*parameter>/gi;
  let m;
  while ((m = re.exec(inv[2])) !== null) {
    const [, key, attrs, body] = m;
    const isString = /string="true"/i.test(attrs);
    let val = body;
    if (!isString) { try { val = JSON.parse(body); } catch { val = body.trim(); } }
    // A single "args" parameter holding a JSON object is the whole argument set
    if (key === 'args' && val && typeof val === 'object' && !Array.isArray(val)) return { name: inv[1], args: val };
    args[key] = val;
  }
  // Fallback: closing tags mangled by the DOM — take the first JSON object after the invoke
  if (!Object.keys(args).length) {
    const obj = extractLargestJsonObject(inv[2]);
    if (obj) return { name: inv[1], args: obj.args && typeof obj.args === 'object' ? obj.args : obj };
  }
  // Last resort: "name=..." parameters whose value runs up to the next tag / DSML marker
  const loose = /parameter\s+name="([\w.-]+)"[^>]*>([\s\S]*?)(?=\s*(?:<|[|｜]?\s*DSML|$))/gi;
  while ((m = loose.exec(inv[2])) !== null) if (m[2].trim()) args[m[1]] = m[2].trim();
  return { name: inv[1], args };
}

/** Strip ```json ... ``` or ``` ... ``` fences */
function stripCodeFences(str) {
  return str
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** Remove DeepSeek R1 thinking blocks */
function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
    .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
    .trim();
}

/** Attempt to fix common LLM JSON mistakes */
function attemptJsonFix(str) {
  try {
    const fixed = str
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * True if the text (from its first '{') ends inside an unterminated JSON string.
 * This is the signature of a response scraped while the model was still streaming
 * a large string value (e.g. a file's content) — distinct from complete-but-malformed
 * JSON like `{nope`, which is never inside an open string.
 */
function endsInUnterminatedString(str) {
  const start = str.indexOf('{');
  if (start < 0) return false;
  let inStr = false, escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape)               { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true;  continue; }
    if (ch === '"')             inStr = !inStr;
  }
  return inStr;
}

/**
 * True if `text` looks like a tool call that was captured mid-stream (incomplete):
 *   - an opening ```tool_call fence with no closing fence yet, or
 *   - a tool-call object whose JSON ends inside an unterminated string.
 */
function looksIncompleteToolCall(text) {
  const openFence = /```tool_call/i.test(text);
  if (openFence && !/```tool_call\s*[\s\S]*?```/i.test(text)) return true;
  if (/["'](?:name|tool|function)["']\s*:/.test(text) && endsInUnterminatedString(text)) return true;
  return false;
}

/**
 * Extract the largest valid JSON object from a string.
 * Uses a bracket-counting approach rather than regex to handle nested objects.
 */
function extractLargestJsonObject(text) {
  let best = null;
  let bestLen = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth   = 0;
    let inStr   = false;
    let escape  = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape)          { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"')      { inStr = !inStr; continue; }
      if (inStr)           { continue; }
      if (ch === '{')      { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          const parsed = candidate.length > bestLen ? parseJson(candidate) : null;
          if (parsed) {
            best    = parsed;
            bestLen = candidate.length;
          }
          break;
        }
      }
    }
  }

  return best;
}

/** Prose the model wrote before its tool call (its running commentary). */
function extractCommentary(rawText) {
  const text = stripThinkingBlocks(rawText);
  const m = text.match(/(^|\n)[ \t]*(```tool_call|tool_call[ \t]*\n|[<｜|\s]*DSML|```(?:json)?\s*\n?\s*\{\s*"name")/i);
  return (m ? text.slice(0, m.index) : '').trim();
}

module.exports = {
  parseResponse,
  extractCommentary,
  stripThinkingBlocks,
  looksIncompleteToolCall,
  endsInUnterminatedString,
};
