// A fast drop-in reimplementation of makefun-site 1.0.0's build, written from
// its published dialect (front matter, template language, Markdown subset,
// slug rule and build report). run(input) returns the same output tree —
// path -> text, byte for byte — as the reference build, for every input.
//
// No state is kept between calls: every run builds its own caches, so each
// case is answered alone.

// ---------------------------------------------------------------- text rules

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The entity for an escapable character code, or undefined. */
function entityOf(cc) {
  switch (cc) {
    case 38: return '&amp;';
    case 60: return '&lt;';
    case 62: return '&gt;';
    case 34: return '&quot;';
    case 39: return '&#39;';
    default: return undefined;
  }
}

/** `text` with & < > " and ' replaced by their HTML entities, nothing else. */
export function escapeHtml(text) {
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const rep = entityOf(text.charCodeAt(i));
    if (rep !== undefined) {
      if (out === null) out = '';
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? text : out + text.slice(last);
}

const SLUG_MAX = 64;

/** The slug of `text`, before caching: NFKD, marks dropped, lowered, dashed. */
function slugRaw(text) {
  // A ready-made slug (or a single lowercase word) needs no work at all.
  if (text.length <= SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) return text;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set, and added to it. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is JavaScript whitespace (the \s class). */
function isSpaceCode(c) {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The number of words in `text`: runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const TRAILING_WS = /[ \t]+$/;

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A front-matter string value: quoted with \" and \\ escapes, or bare. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or the reason it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Find the closing --- line first (a missing close outranks any line error),
  // collecting the front-matter lines on the way; the body is never split.
  const fmLines = [];
  let closeBody = -1;
  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      closeBody = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeBody === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAILING_WS, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeBody) };
}

// ---------------------------------------------------------------- markdown

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_WS_TEST = /\s/;

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null: 1-6 '#', a space or tab, then text. */
function scanHeading(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  let start = n;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === start) return null;
  return { depth: n, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHrLine(line) {
  const c = line[0];
  if ((c !== '-' && c !== '*') || line[1] !== c || line[2] !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** A fence line's language, or null: three backticks, a language, then spaces or tabs only. */
function scanFenceOpen(line) {
  if (!line.startsWith('```')) return null;
  const m = MD_FENCE_OPEN.exec(line);
  return m === null ? null : m[1];
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item's text, or null: '- ' or '* ', then the rest of the line. */
function scanBullet(line) {
  const c = line[0];
  return (c === '-' || c === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's { num, text }, or null: 1-9 digits, '. ', then the rest. */
function scanOrdered(line) {
  let n = 0;
  while (n < line.length && line[n] >= '0' && line[n] <= '9') n++;
  if (n === 0 || n > 9 || line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { num: line.slice(0, n), text: line.slice(n + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinuation(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n >= 2 && n < line.length && !MD_WS_TEST.test(line[n]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlankLine(line);
  if (c === '`') return scanFenceOpen(line) !== null;
  if (c === '#') return scanHeading(line) !== null;
  if (c === '-' || c === '*') return isHrLine(line);
  return false;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The escapable characters as a code table (the same set as ESCAPABLE). */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ESCAPABLE) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;
const isEscapableAt = (s, i) => {
  const cc = s.charCodeAt(i);
  return cc < 128 && ESCAPABLE_CODE[cc] === 1;
};

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one not part of a ** run), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` resolves a link's href. */
function renderInline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // A plain run up to the next character that can open an inline construct,
    // written escaped as it is scanned (the escapable characters are met on
    // the way, so the run takes one pass, not two).
    let j = i;
    let seg = i;
    while (j < n) {
      const cc = s.charCodeAt(j);
      if (cc === 92 || cc === 96 || cc === 42 || cc === 91) break; // \ ` * [
      const rep = cc === 38 || cc === 60 || cc === 62 || cc === 34 || cc === 39 ? entityOf(cc) : undefined;
      if (rep !== undefined) {
        out += s.slice(seg, j) + rep;
        j++;
        seg = j;
        continue;
      }
      j++;
    }
    if (j > seg) out += s.slice(seg, j);
    i = j;
    if (i >= n) break;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out += ESCAPE_MAP[s[i + 1]] ?? s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${renderInline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${renderInline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${renderInline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    out += ESCAPE_MAP[c] ?? c;
    i++;
  }
  return out;
}

/**
 * `src` rendered to HTML: { html, toc, excerpt }. toc holds every level 2 and
 * 3 heading ({ level, id, html }); excerpt is the first paragraph's HTML.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined || ((c0 === ' ' || c0 === '\t') && isBlankLine(line))) {
      i++;
      continue;
    }
    if (c0 === '`') {
      const lang = scanFenceOpen(line);
      if (lang !== null) {
        let body = '';
        i++;
        while (i < lines.length && !isFenceClose(lines[i])) {
          body += `${escapeHtml(lines[i])}\n`;
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        html += `<pre><code${cls}>${body}</code></pre>\n`;
        continue;
      }
    }
    if (c0 === '#') {
      const heading = scanHeading(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const h = renderInline(heading.text, env);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    }
    if ((c0 === '-' || c0 === '*') && isHrLine(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === '>') {
      const kept = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        const l = lines[i];
        const t = trimLine(l[1] === ' ' ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bulletText = c0 === '-' || c0 === '*' ? scanBullet(line) : null;
    const orderedScan = bulletText === null && c0 >= '0' && c0 <= '9' ? scanOrdered(line) : null;
    if (bulletText !== null || orderedScan !== null) {
      const isOrdered = orderedScan !== null;
      const start = isOrdered ? Number(orderedScan.num) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lc = l[0];
        const text = isOrdered
          ? (lc >= '0' && lc <= '9' ? scanOrdered(l)?.text ?? null : null)
          : (lc === '-' || lc === '*' ? scanBullet(l) : null);
        if (text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (isContinuation(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      html += `${open}\n${items.map((parts) => `<li>${renderInline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      text += `\n${trimLine(lines[i])}`;
      i++;
    }
    const p = renderInline(text, env);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a lone {% %} line is taken whole. */
function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `nodes` with adjacent text nodes run together (they render as one), recursively. */
function mergeTextNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'for') out.push({ kind: 'for', name: n.name, path: n.path, body: mergeTextNodes(n.body) });
    else if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: mergeTextNodes(n.then),
        else: n.else === null ? null : mergeTextNodes(n.else),
      });
    } else if (n.kind === 'text' && out.length > 0 && out[out.length - 1].kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: out[out.length - 1].text + n.text };
    } else out.push(n);
  }
  return out;
}

/** `src` parsed into a tree of nodes; a TemplateError when it does not parse. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return mergeTextNodes(root.body);
}

/**
 * A copy of `nodes` with every include spliced in, as rendering from this
 * template as a root (depth 0) would meet it: an include met at nesting level
 * L renders its template at depth L + 1 while L < INCLUDE_DEPTH, and renders
 * nothing at or past it, so expansion drops those. for and if bodies keep the
 * level (they do not change the render depth). A root whose expansion grows
 * past the cap keeps its parsed tree instead; rendering it still resolves
 * includes the ordinary way, so both forms answer the same.
 */
const EXPAND_NODE_CAP = 20000;

function expandIncludes(nodes, templates, level, st) {
  const out = [];
  for (const n of nodes) {
    if (++st.count > EXPAND_NODE_CAP) throw new Error('expansion cap');
    if (n.kind === 'include') {
      if (level >= INCLUDE_DEPTH) continue;
      const t = templates.get(n.name);
      if (t === undefined) continue;
      out.push(...expandIncludes(t, templates, level + 1, st));
    } else if (n.kind === 'for') {
      out.push({ kind: 'for', name: n.name, path: n.path, body: expandIncludes(n.body, templates, level, st) });
    } else if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: expandIncludes(n.then, templates, level, st),
        else: n.else === null ? null : expandIncludes(n.else, templates, level, st),
      });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Every template with its includes spliced in (see above), keyed as `templates` is. */
function expandTemplates(templates) {
  const expanded = new Map();
  for (const [name, nodes] of templates) {
    try {
      expanded.set(name, expandIncludes(nodes, templates, 0, { count: 0 }));
    } catch {
      expanded.set(name, nodes);
    }
  }
  return expanded;
}

/** The value at `path`: first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as template text: strings as-is, numbers and booleans in JS form, arrays joined by ", ". */
function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); ctx holds the templates. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const v = tplLookup(scope, n.path);
        out += typeof v === 'string' ? escapeHtml(v) : escapeHtml(tplText(v));
        break;
      }
      case 'raw': {
        const v = tplLookup(scope, n.path);
        out += typeof v === 'string' ? v : tplText(v);
        break;
      }
      case 'if': {
        const v = tplTruthy(tplLookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = tplLookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly as the reference build's. */
export function run(input) {
  // Per-build caches (slugs and long dates repeat across a site's pages).
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let s = dateCache.get(date);
    if (s === undefined) {
      s = longDateRaw(date);
      dateCache.set(date, s);
    }
    return s;
  };

  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const expanded = expandTemplates(templates);

  // Sources in code-unit path order; .md files are sources, the rest static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in their fixed order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slugs made unique per directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown bodies, with links resolved against pages and static files.
  // Resolutions are cached per (directory, target): the same links recur
  // across a site's pages, and only the broken-link note is per source.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirCache = linkCache.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      linkCache.set(dir, dirCache);
    }
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        let href = dirCache.get(target);
        if (href === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else href = null;
          dirCache.set(target, href);
        }
        if (href === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts collection: newest date first, ties by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags grouped by slug, named as first met in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => tagBySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tagList = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The records templates read.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: pages, index pages, tag pages, the tags page, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = expanded.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every noted line sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
