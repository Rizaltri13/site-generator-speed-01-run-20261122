// solve.js — a fast drop-in for makefun-site 1.0.0 (make.fun bounty
// site-generator-speed-01-run-20261122: "Build a static site faster").
//
// Same answers as makefun-site 1.0.0 for every input, produced with less work. The reference
// pipeline is kept — sources, front matter, permalinks, Markdown, collections, tags, layouts,
// report — but its hot paths are rewritten from scratch:
//
//   * Inline Markdown is scanned for its next special character with one native regex search
//     instead of being escaped one character at a time (the reference calls a regex escape per
//     character, which is where most of its time goes).
//   * The Markdown lexer and renderer are a single pass over the lines: no token objects, no
//     re-splitting the body, and paragraph continuation is decided from the line's first
//     character instead of four regex tests per line.
//   * Slugs and long dates are memoised per case (titles and tag names repeat constantly).
//   * Word counting runs over the body lines with no allocation.
//   * The template renderer reuses one scope frame per loop instead of one per element, and
//     renders straight into a shared string array.
//   * Code blocks are escaped in one pass over the joined body.
//
// No dependencies, no I/O, no clock, no randomness. run(input) answers one case alone; nothing
// is kept from one call to the next.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped, in one native pass (unchanged when nothing needs it). */
function escHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/**
 * The slug of `text`, exactly as the reference defines it. NFKD + combining-mark removal are
 * the identity on ASCII, so ASCII input skips both and runs the same loop directly.
 */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
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
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
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
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter from its lines: { data, bodyStart } (bodyStart is the first body
 * line's index), or { error } with the first reason it is refused.
 */
function parseFM(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue; // blank, or a '#' comment
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- words

/** Whether code unit `c` is whitespace, by JavaScript's \s. */
function isWs(c) {
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return (
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** The words of the body lines from `from`: runs of characters other than whitespace, counted with no allocation. */
function countWords(lines, from) {
  let n = 0;
  for (let i = from; i < lines.length; i++) {
    const s = lines[i];
    let inWord = false;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (isWs(c)) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_NEXT = /[\\`*\[]/g;
const WS_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    // A `what` at j is escaped exactly when the run of backslashes before it is odd: the
    // reference scan pairs backslashes left to right from `from`, and the run starts at or
    // after `from` (the opener before it is never a backslash).
    let b = 0;
    for (let p = j - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let p = j - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, its pieces appended to `out`; `link(target)` resolves a link's href.
 * Plain runs are flushed through escHtml in bulk; only the four characters that open a
 * construct (`\`, backtick, `*`, `[`) interrupt a run.
 */
function inline(s, link, out) {
  const n = s.length;
  let i = 0;
  let start = 0;
  while (i < n) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // Backslash: an escapable character after it is written escaped ('>' is the only one
      // the HTML table touches); anything else leaves the backslash in the plain run.
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out.push(escHtml(s.slice(start, j)));
        out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(escHtml(s.slice(start, j)));
        out.push('<code>', escHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(escHtml(s.slice(start, j)));
          out.push('<strong>');
          inline(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
          start = i;
          continue;
        }
        i = j + 2; // no closer: '**' stays literal, inside the plain run
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out.push(escHtml(s.slice(start, j)));
        out.push('<em>');
        inline(s.slice(j + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    // '[': a link only when an unescaped ']' is followed at once by '(' and a ')' closes a
    // non-empty target holding no whitespace.
    const k = findUnesc(s, ']', j + 1);
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      const m2 = s.indexOf(')', k + 2);
      if (m2 !== -1) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !WS_RE.test(target)) {
          if (j > start) out.push(escHtml(s.slice(start, j)));
          out.push('<a href="', escHtml(link(target)), '">');
          inline(s.slice(j + 1, k), link, out);
          out.push('</a>');
          i = m2 + 1;
          start = i;
          continue;
        }
      }
    }
    i = j + 1;
  }
  if (n > start) out.push(escHtml(s.slice(start, n)));
}

/** Spaces and tabs trimmed at both ends of a line. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  const n = line.length;
  let lang = '';
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else break;
  }
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === n ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  let j = i;
  while (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === i) return null;
  let e = n;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: i, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break (`---` or `***`, then spaces or tabs only). */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A list item's marker, or null: { ordered, start, text }. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i > 0 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
    return null;
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  return !isWs(c);
}

/**
 * The body lines from `from` rendered: its HTML, its table of contents (level 2 and 3
 * headings) and its excerpt (the first paragraph's HTML, or "").
 */
function renderMd(lines, from, link, slugify) {
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = from;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '' || isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ` class="language-${escHtml(lang)}"`;
        code += '>';
        if (body.length > 0) code += `${escHtml(body.join('\n'))}\n`;
        code += '</code></pre>';
        blocks.push(code);
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const out = [];
        inline(h.text, link, out);
        const html = out.join('');
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.startsWith('> ') ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimST(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const out = [];
        inline(kept.join('\n'), link, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const start = marker.start;
      const items = [];
      while (i < n) {
        const m = listMarker(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimST(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimST(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) {
        const out = [];
        inline(parts.join('\n'), link, out);
        html += `<li>${out.join('')}</li>\n`;
      }
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimST(lines[i++]));
    const out = [];
    inline(body.join('\n'), link, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INC = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TplError extends Error {}

/** The path `text` names, split at its dots, or a TplError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TplError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces or tabs. */
function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }} / {{{ }}} values and {% %} tags; a standalone tag's line is taken with it. */
function tokenizeTpl(name, src) {
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
      if (close === -1) throw new TplError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'x', s: text });
      text = '';
      tokens.push({ t: raw ? 'r' : 'v', p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'x', s: text });
    text = '';
    tokens.push({ t: 'g', g: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'x', s: text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TplError when it does not parse). */
function parseTpl(name, src) {
  const root = { k: 'root', b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'x') {
      body.push({ k: 'x', s: tok.s });
      continue;
    }
    if (tok.t === 'v' || tok.t === 'r') {
      body.push({ k: tok.t, p: tok.p });
      continue;
    }
    const tag = tok.g;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { k: 'f', name: m[1], p: pathOf(name, m[2]), b: [] };
      body.push(node);
      stack.push(node);
      body = node.b;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = { k: 'i', not: m[1] !== undefined, p: pathOf(name, m[2]), t: [], e: null };
      body.push(node);
      stack.push(node);
      body = node.t;
    } else if (tag === 'else') {
      if (top.k !== 'i' || top.e !== null) throw new TplError(`template "${name}": an else outside an if`);
      top.e = [];
      body = top.e;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 'f' : 'i')) {
        throw new TplError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.b : parent.k === 'f' ? parent.b : (parent.e ?? parent.t);
    } else if ((m = TPL_INC.exec(tag)) !== null) {
      body.push({ k: 'c', n: m[1] });
    } else throw new TplError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TplError(`template "${name}": a ${top.k === 'f' ? 'for' : 'if'} is not closed`);
  }
  return root.b;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
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

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), its pieces appended to `out`. A for loop
 * reuses one scope frame (and one `loop` record) for all of its elements, mutating them per
 * element; each rendering of the loop makes its own frame, so an include that re-enters the
 * same loop cannot clobber the frame it is already rendering through.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.k) {
      case 'x':
        out.push(n.s);
        break;
      case 'v':
        out.push(escHtml(textOf(lookup(scope, n.p))));
        break;
      case 'r':
        out.push(textOf(lookup(scope, n.p)));
        break;
      case 'i': {
        const v = truthy(lookup(scope, n.p));
        const br = v !== n.not ? n.t : n.e;
        if (br !== null) renderNodes(br, scope, ctx, depth, out);
        break;
      }
      case 'f': {
        const xs = lookup(scope, n.p);
        if (!Array.isArray(xs) || xs.length === 0) break;
        const vars = Object.create(null);
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars.loop = loop;
        const frame = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.b, frame, ctx, depth, out);
        }
        break;
      }
      case 'c': {
        const t = ctx.templates.get(n.n);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const out = slugifyRaw(text);
    slugCache.set(text, out);
    return out;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    const hit = dateCache.get(date);
    if (hit !== undefined) return hit;
    const out = longDateRaw(date);
    dateCache.set(date, out);
    return out;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCU(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft. The checks run
  // in order, and the first one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFM(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.bodyStart = fm.bodyStart;
    s.words = countWords(lines, fm.bodyStart);
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

  // Permalinks: each page's output directory and url, its slug made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMd(s.lines, s.bodyStart, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // What templates see.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
