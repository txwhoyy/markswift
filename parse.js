// markswift: a from-scratch Markdown renderer.
//
// parse(markdown) returns the HTML that marked 18.1.3's marked.parse()
// returns with default options (gfm true, breaks false, pedantic false).
// The implementation is a line-oriented block parser producing a small
// block tree, plus a scanner-based inline parser with a delimiter stack
// for emphasis and links. No dependencies, no imports.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isAsciiPunct(code) {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  if (ch === undefined || ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 0x80) return isAsciiPunct(code);
  return PUNCT_RE.test(ch);
}

function isSpaceChar(ch) {
  if (
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
  ) {
    return true;
  }
  // The reference's regex whitespace class also covers these.
  const code = ch.charCodeAt(0);
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

// ---------------------------------------------------------------------------
// HTML escaping (mirrors the reference renderer's escaping behaviour)
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape every special character; used for code, autolink text/hrefs.
function escapeFull(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPES[s[i]];
    if (rep !== undefined) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape like the above, except an ampersand that begins something shaped
// like a character reference (&#123; &#x1f; &name;) is left alone.
// Used for ordinary text and for link destinations and titles.
const ENTITY_SHAPE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z0-9_]+);/y;
function escapeText(s) {
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      ENTITY_SHAPE.lastIndex = i;
      if (ENTITY_SHAPE.test(s)) {
        i = ENTITY_SHAPE.lastIndex;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = ++i;
      continue;
    }
    const rep = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : undefined;
    if (rep !== undefined) {
      out += s.slice(start, i) + rep;
      start = ++i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode a numeric character reference body (the part between &# and ;).
// Returns the decoded string, or null when it is not a decodable reference.
function decodeNumericRef(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    if (body.length < 2 || body.length > 7) return null;
    cp = parseInt(body.slice(1), 16);
    if (Number.isNaN(cp)) return null;
  } else {
    if (body.length < 1 || body.length > 7) return null;
    cp = parseInt(body, 10);
    if (Number.isNaN(cp)) return null;
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return String.fromCodePoint(cp);
}

// Resolve backslash escapes of ASCII punctuation in a string (used for
// link destinations, titles and labels).
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Normalise a reference label for lookup: trim, collapse internal
// whitespace runs to a single space, fold case.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Block tree
// ---------------------------------------------------------------------------

function newBlock(type) {
  return {
    type, // document | blockquote | list | item | paragraph | heading | code | html | hr | table
    children: [],
    parent: null,
    open: true,
    lastLineBlank: false,
    text: '', // paragraph / heading / code / html raw content
    level: 0, // heading level
    info: '', // fenced code info string
    fenced: false,
    fenceChar: '',
    fenceLen: 0,
    fenceIndent: 0,
    htmlType: 0,
    listKind: '', // 'bullet' | 'ordered'
    bulletChar: '',
    delimChar: '',
    start: 1,
    tight: true,
    aligns: null, // table column alignments
    header: null, // table header cell texts
    rows: null, // table body rows (arrays of cell texts)
    checked: null, // task list state for items: null | true | false
    lineCount: 0, // lines accumulated in text so far
    lastLineIndex: -1, // html blocks: source line index of the last content line
    endedByBlank: false, // html blocks: closed by a blank line, not a terminator/EOF
    prevLazyQuote: false, // paragraphs: last line joined while a block quote ancestor did not match
    noSetext: false, // paragraphs: a continuation line rules out a setext conversion
    codePending: false, // paragraphs (item content): last chunk was merged indented code
    // List items collect their content lines first and parse them when
    // the item closes, mirroring how the reference tokeniser gathers an
    // item's raw text before lexing it.
    lines: null, // item: gathered content lines (already dedented)
    itemR: 0, // item: content indent, relative to the list's frame
    prevBlank: false, // item: previous gathered line was blank / first line empty
    prevDedent: '', // item: previous line, dedented by itemR
    firstLineEmpty: false, // item: the marker line had no content
    endEarly: false, // item: empty item closed by an immediate blank line
    ended: false, // item: no further lines are gathered
    endBlank: false, // item: the last gathered line is blank
    task: false, // item: content starts with a task marker
    midBlank: false, // item: content has a block-separating blank line
    startLine: 0, // first line of this block's raw in the current parse
    endLine: 0, // last line of this block's raw in the current parse
  };
}

function canContain(parentType, childType) {
  switch (parentType) {
    case 'document':
    case 'blockquote':
    case 'item':
      return childType !== 'item';
    case 'list':
      return childType === 'item';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Parser state and line cursor machinery
//
// The parser walks the source one line at a time. P.line is the current
// line (it may be rewritten when a tab is partially consumed), P.pos the
// byte index into it and P.col the absolute column of P.pos.
// ---------------------------------------------------------------------------

function computeFirstNonspace(P) {
  const s = P.line;
  let i = P.pos;
  let col = P.col;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') {
      i++;
      col++;
    } else if (c === '\t') {
      i++;
      col += 4 - (col % 4);
    } else {
      break;
    }
  }
  P.firstNonspace = i;
  P.firstNonspaceCol = col;
  P.indent = col - P.col;
  P.blank = i >= s.length;
}

// Advance the cursor n columns, consuming spaces and tabs. A tab that is
// only partially consumed is replaced by the spaces it still covers, so
// later slicing of the line sees the remainder as spaces.
function advanceCols(P, n) {
  const s = P.line;
  while (n > 0 && P.pos < s.length) {
    const c = s[P.pos];
    if (c === '\t') {
      const w = 4 - (P.col % 4);
      if (w <= n) {
        P.pos++;
        P.col += w;
        n -= w;
      } else {
        P.line = s.slice(0, P.pos) + '    '.slice(0, w) + s.slice(P.pos + 1);
        P.pos += n;
        P.col += n;
        n = 0;
      }
    } else if (c === ' ') {
      P.pos++;
      P.col++;
      n--;
    } else {
      break;
    }
  }
}

// Expand the leading whitespace run of a string to spaces, with tabs
// advancing to the next multiple of 4 columns counted from startCol.
// The rest of the string is returned unchanged.
function detabLeadingStr(text, startCol) {
  let i = 0;
  let col = startCol;
  let out = '';
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    if (text[i] === ' ') {
      out += ' ';
      col++;
    } else {
      const w = 4 - (col % 4);
      out += '    '.slice(0, w);
      col += w;
    }
    i++;
  }
  return i === 0 ? text : out + text.slice(i);
}

// The reference detabs the whitespace run after a block quote
// marker before stripping the marker: tabs expand to the next
// multiple-of-four column, counted from the start of the marker
// prefix (the frame-relative index of the '>' plus one). Rewrite
// P.line accordingly (only the run after the '>' at
// P.firstNonspace is affected).
function detabQuoteRun(P) {
  const line = P.line;
  const gt = P.firstNonspace;
  let runEnd = gt + 1;
  while (runEnd < line.length && (line[runEnd] === ' ' || line[runEnd] === '\t')) {
    runEnd++;
  }
  if (runEnd === gt + 1) return;
  const run = line.slice(gt + 1, runEnd);
  if (run.indexOf('\t') === -1) return;
  let col = gt - P.pos + 1;
  let out = '';
  for (let k = 0; k < run.length; k++) {
    if (run[k] === '\t') {
      const w = 4 - (col % 4);
      out += '    '.slice(0, w);
      col += w;
    } else {
      out += ' ';
      col++;
    }
  }
  P.line = line.slice(0, gt + 1) + out + line.slice(runEnd);
}

// Index of the first character that is not a space, or -1.
function firstNonspaceIdx(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') return i;
  }
  return -1;
}

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

function lastOpenChild(block) {
  const ch = block.children;
  for (let i = ch.length - 1; i >= 0; i--) {
    if (ch[i].open) return ch[i];
  }
  return null;
}

function finalizeBlock(P, block) {
  block.open = false;
  if (P.trackSpans && block.parent === P.doc) {
    // Record the last line of this block's raw text (item contents use
    // the spans to detect block-separating blank lines). Blocks consume
    // contiguous lines; a block closed by a later line ends just
    // before it, and a list's raw is trimmed of trailing blank lines.
    let e;
    if (P.eofFinalize) e = P.totalLines - 1;
    else if (block.startLine === P.lineIndex) e = P.lineIndex;
    else e = P.lineIndex - 1;
    if (block.type === 'list') {
      while (e > block.startLine && isBlankStr(P.allLines[e])) e--;
    }
    block.endLine = e;
  }
  if (P.tip === block) P.tip = block.parent;
  if (block.type === 'paragraph') {
    block.text = stripLinkDefs(P, block.text);
    if (block.text.trim() === '') {
      // A paragraph that held only definitions renders as nothing,
      // but it still counts as a block (a blank line next to it can
      // make a list loose), so it stays in the tree, flagged.
      block.defOnly = true;
    }
  } else if (block.type === 'code' && !block.fenced) {
    // Indented code: trailing blank lines are not part of the block.
    const lines = block.text.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    block.text = lines.length ? lines.join('\n') + '\n' : '';
  } else if (block.type === 'code' && block.fenced) {
    // The reference's fence match leaves one line terminator after the
    // content for the closing fence (or end of input) to consume.
    if (block.text.endsWith('\n')) block.text = block.text.slice(0, -1);
  } else if (block.type === 'item') {
    // The gathered content lines are parsed into child blocks now.
    parseItemContent(block, P.links);
  } else if (block.type === 'list') {
    // Loose when an item's content is split into blocks by a blank
    // line, or when an item's raw text ends with a blank line and a
    // later item follows.
    const items = block.children;
    let loose = false;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (it.midBlank) loose = true;
      if (idx < items.length - 1 && it.endBlank) loose = true;
    }
    block.tight = !loose;
  } else if (block.type === 'html') {
    // An HTML block keeps the newline that ended its last line when
    // more content follows on the next line (or the input ends with a
    // newline); the reference's raw match sheds trailing blank lines.
    if (!block.endedByBlank) {
      const nextIdx = block.lastLineIndex + 1;
      if (nextIdx < P.totalLines) {
        // Blocks that end at their own closing condition (types
        // 1-5) shed the newline only before a completely empty
        // line; a whitespace-only line keeps it. Blocks that end
        // at a blank line (types 6 and 7) treat whitespace-only
        // lines as blank.
        const nextLine = P.allLines[nextIdx];
        const sheds =
          block.htmlType <= 5 ? nextLine === '' : isBlankStr(nextLine);
        if (!sheds) block.text += '\n';
      } else if (P.endsWithNewline) {
        block.text += '\n';
      }
    }
  }
}

function closeBlocksAbove(P, ancestor) {
  while (P.tip !== ancestor && P.tip !== null) {
    finalizeBlock(P, P.tip);
  }
}

function addChild(P, type) {
  while (!canContain(P.tip.type, type)) finalizeBlock(P, P.tip);
  const block = newBlock(type);
  block.parent = P.tip;
  block.startLine = P.lineIndex;
  P.tip.children.push(block);
  P.tip = block;
  return block;
}



// ---------------------------------------------------------------------------
// Link reference definitions, stripped from the front of a paragraph's
// text when the paragraph closes. A definition is:
//   [label]: <dest or bare dest> (optional title) (end of line)
// and may span several lines. Returns the remaining paragraph text.
// ---------------------------------------------------------------------------

function stripLinkDefs(P, text) {
  let rest = text;
  for (;;) {
    const def = parseLinkDef(rest);
    if (def === null) break;
    const key = normalizeLabel(def.label);
    if (key !== '' && !P.links.has(key)) {
      P.links.set(key, { href: def.href, title: def.title });
    }
    rest = rest.slice(def.consumed);
  }
  return rest;
}

// Balanced-parentheses check for a bare definition destination: a
// backslash escapes the next character; the depth may never go
// negative and must return to zero.
function parensBalanced(s) {
  let depth = 0;
  let hasParens = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      hasParens = true;
    } else if (c === ')') {
      depth--;
      hasParens = true;
      if (depth < 0) return false;
    }
  }
  return !hasParens || depth === 0;
}

function isWsChar(c) {
  return c === ' ' || c === '\t' || c === '\n';
}

// Try to parse one link reference definition at the start of s.
// The shape mirrors the reference grammar:
//   [label]: <spaces> (one optional newline + indent)
//   (<dest> or a bare non-whitespace run with balanced parentheses)
//   (separator + title)? <spaces> (newlines or end)
// Returns {label, href, title, consumed} or null.
function parseLinkDef(s) {
  let i = 0;
  // Up to 3 leading spaces on the first line.
  let spaces = 0;
  while (s[i] === ' ' && spaces < 4) {
    i++;
    spaces++;
  }
  if (spaces > 3 || s[i] !== '[') return null;
  const labelEnd = scanLabelEnd(s, i);
  if (labelEnd === -1) return null;
  const label = s.slice(i + 1, labelEnd);
  if (label.trim() === '' || /\n[ \t]*\n/.test(label)) return null;
  i = labelEnd + 1;
  if (s[i] !== ':') return null;
  i++;
  // Spaces (not tabs), then at most one newline plus indentation.
  while (s[i] === ' ') i++;
  if (s[i] === '\n') {
    i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
  }
  // Destination.
  let href;
  if (s[i] === '<') {
    const gt = s.indexOf('>', i + 1);
    if (gt === -1) return null;
    const nl = s.indexOf('\n', i + 1);
    if (nl !== -1 && nl < gt) return null;
    href = unescapeBackslash(s.slice(i + 1, gt));
    i = gt + 1;
  } else {
    if (i >= s.length || s[i] === '<' || isWsChar(s[i])) return null;
    let j = i;
    while (j < s.length && !isWsChar(s[j])) j++;
    const rawDest = s.slice(i, j);
    if (!parensBalanced(rawDest)) return null;
    href = unescapeBackslash(rawDest);
    i = j;
  }
  // Optional title, which needs a separator before it: spaces (with
  // an optional newline) or a newline, plus indentation.
  let title = null;
  let k = i;
  let sawSep = false;
  if (s[k] === ' ') {
    sawSep = true;
    while (s[k] === ' ') k++;
    if (s[k] === '\n') {
      k++;
      while (s[k] === ' ' || s[k] === '\t') k++;
    }
  } else if (s[k] === '\n') {
    sawSep = true;
    k++;
    while (s[k] === ' ' || s[k] === '\t') k++;
  }
  if (sawSep) {
    const t = parseLinkTitle(s, k);
    if (t !== null) {
      let m = t.end;
      while (s[m] === ' ') m++;
      if (m >= s.length || s[m] === '\n') {
        title = t.value;
        i = m;
      }
    }
  }
  if (title === null) {
    // No title: only spaces may follow the destination on this line.
    let m = i;
    while (s[m] === ' ') m++;
    if (m < s.length && s[m] !== '\n') return null;
    i = m;
  }
  // The definition's raw text runs through the line ending(s).
  while (s[i] === '\n') i++;
  return { label, href, title, consumed: i };
}

// Whitespace between the parts of a definition: spaces, tabs and at
// most newlines (the caller validates the final shape).
function skipDefWhitespace(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

function skipInlineSpaces(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// Find the ']' closing a label that starts at s[start] === '['.
// Backslash-escaped characters do not count. Returns -1 on failure.
function scanLabelEnd(s, start) {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') return i;
    i++;
  }
  return -1;
}

// Parse a link destination at s[i]: either <...> or a bare run with
// balanced parentheses. Returns {href, end} with escapes resolved.
function parseLinkDestination(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
        out += s[j + 1];
        j += 2;
        continue;
      }
      if (c === '>') return { href: out, end: j + 1 };
      if (c === '<' || c === '\n') return null;
      out += c;
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      out += c;
      j++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      out += c;
      j++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
    out += c;
    j++;
  }
  if (depth !== 0) return null;
  return { href: out, end: j };
}

// Parse a link title at s[i]: "..." or '...' or (...).
// Returns {value, end} with escapes resolved, or null.
function parseLinkTitle(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === close) return { value: out, end: j + 1 };
    if (open === '(' && c === '(') return null;
    j++;
    out += c === '\n' ? '\n' : c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML tag scanning (shared by block-level HTML and inline raw HTML)
// ---------------------------------------------------------------------------

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/;
const ATTR_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;
const ATTR_VALUE_UNQUOTED_RE = /^[^\s"'=<>`]+/;
const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col colgroup dd details ' +
  'dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option ' +
  'p param search section summary table tbody td tfoot th thead title tr track ul'
).split(' '));

// Scan a complete HTML tag at s[i] === '<'. Returns the end index
// (one past '>') or -1 when the text at i is not a complete tag.
function scanHtmlTag(s, i) {
  let j = i + 1;
  if (s[j] === '/') j++;
  const nameMatch = TAG_NAME_RE.exec(s.slice(j, j + 64));
  if (nameMatch === null) return -1;
  j += nameMatch[0].length;
  if (s[i + 1] === '/') {
    // Closing tag: optional whitespace, then '>'.
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n') j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  // Open tag: attributes, then optional '/', then '>'.
  for (;;) {
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    if (k === j) break; // attributes must be preceded by whitespace
    if (s[k] === '>' || (s[k] === '/' && s[k + 1] === '>')) {
      j = k;
      break;
    }
    const attr = ATTR_NAME_RE.exec(s.slice(k, k + 128));
    if (attr === null) return -1;
    k += attr[0].length;
    // Optional = value.
    let m = k;
    while (s[m] === ' ' || s[m] === '\t' || s[m] === '\n') m++;
    if (s[m] === '=') {
      m++;
      while (s[m] === ' ' || s[m] === '\t' || s[m] === '\n') m++;
      const q = s[m];
      if (q === '"' || q === "'") {
        const closeQuote = s.indexOf(q, m + 1);
        if (closeQuote === -1) return -1;
        k = closeQuote + 1;
      } else {
        const val = ATTR_VALUE_UNQUOTED_RE.exec(s.slice(m, m + 256));
        if (val === null) return -1;
        k = m + val[0].length;
      }
    }
    j = k;
  }
  if (s[j] === '/' && s[j + 1] === '>') return j + 2;
  return s[j] === '>' ? j + 1 : -1;
}

// Which HTML block type a line starts, per the seven start conditions.
// Returns 0 when the line does not start an HTML block.
function htmlBlockStart(P, inParagraph) {
  const s = P.line;
  const i = P.firstNonspace;
  if (s[i] !== '<') return 0;
  const rest = s.slice(i, i + 12).toLowerCase();
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-z]/.test(rest) && /[A-Z]/.test(s[i + 2] || '')) return 4;
  if (s.slice(i, i + 9) === '<![CDATA[') return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s.slice(i, i + 40));
  if (m === null) return 0;
  const tag = m[1].toLowerCase();
  const afterIdx = i + m[0].length;
  const after = s[afterIdx];
  const afterOk =
    after === undefined || after === ' ' || after === '\t' || after === '>' ||
    (after === '/' && s[afterIdx + 1] === '>');
  if (
    s[i + 1] !== '/' &&
    (tag === 'pre' || tag === 'script' || tag === 'style' || tag === 'textarea') &&
    afterOk
  ) return 1;
  if (BLOCK_TAGS.has(tag) && afterOk) return 6;
  if (!inParagraph) {
    const end = scanHtmlTag(s, i);
    if (end !== -1) {
      // The tag must be the whole line apart from trailing whitespace.
      let j = end;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (j >= s.length) return 7;
    }
  }
  return 0;
}

function htmlBlockEnded(block, lineText) {
  switch (block.htmlType) {
    case 1: return /<\/(?:pre|script|style|textarea)/i.test(lineText);
    case 2: return lineText.includes('-->');
    case 3: return lineText.includes('?>');
    case 4: return lineText.includes('>');
    case 5: return lineText.includes(']]>');
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Table helpers (GFM): split a row line into cell texts.
// Pipes escaped as \| or inside code spans do not split. The row's
// leading and trailing pipes (when present) are dropped, and each cell
// is trimmed of spaces and tabs.
// ---------------------------------------------------------------------------

function splitCells(line) {
  // Mirror the reference's row splitting: a pipe preceded by an odd
  // number of backslashes is a literal pipe (and its backslash is
  // removed from the cell text, even inside code spans); any other
  // pipe is a separator. There is no code-span awareness.
  const marked = line.replace(/\|/g, (m, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(' |');
  // Drop the empty artefacts of a leading or trailing pipe.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

const DELIM_CELL_RE = /^:?-+:?$/;
function parseDelimiterRow(line) {
  if (line.indexOf('|') === -1) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!DELIM_CELL_RE.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// List marker parsing and item line gathering
//
// The reference tokeniser works on raw text: a list consumes its items
// one at a time, and each item gathers the lines that belong to it into
// a single string (dedented by the item's content indent) which is then
// lexed on its own. The functions below reproduce that gathering logic
// line by line, in the coordinate frame of the list itself (frame
// column 0 = the start of the text the list sees on each line).
// ---------------------------------------------------------------------------

// Try to read a list marker at the line's first nonspace position.
// Returns a descriptor or null. All columns in the descriptor are
// relative to the current frame origin (P.col / P.pos).
function parseListMarker(P, inParagraph) {
  const s = P.line;
  const i = P.firstNonspace;
  const indent = P.firstNonspaceCol - P.col;
  if (indent > 3) return null;
  const c = s[i];
  let kind;
  let bulletChar = '';
  let delimChar = '';
  let start = 1;
  let markerWidth = 0;
  let j = i;
  if (c === '-' || c === '+' || c === '*') {
    kind = 'bullet';
    bulletChar = c;
    markerWidth = 1;
    j = i + 1;
  } else if (c >= '0' && c <= '9') {
    let num = 0;
    let digits = 0;
    while (j < s.length && digits < 9 && s[j] >= '0' && s[j] <= '9') {
      num = num * 10 + (s.charCodeAt(j) - 48);
      j++;
      digits++;
    }
    if (digits === 0 || (s[j] !== '.' && s[j] !== ')')) return null;
    kind = 'ordered';
    delimChar = s[j];
    start = num;
    markerWidth = digits + 1;
    j++;
  } else {
    return null;
  }
  if (j < s.length && s[j] !== ' ' && s[j] !== '\t') return null;
  // The remainder of the line after the marker, with its leading
  // whitespace detabbed (tabs count from the end of the marker).
  const m = detabLeadingStr(s.slice(j), indent + markerWidth);
  const fn = firstNonspaceIdx(m);
  const empty = fn === -1;
  if (inParagraph && empty) return null;
  if (inParagraph && kind === 'ordered' && start !== 1) return null;
  let firstIndent;
  let content;
  if (empty) {
    firstIndent = 1;
    content = '';
  } else if (fn > 4) {
    // Five or more spaces after the marker: the content is indented
    // code, and the item's content indent is marker + 1.
    firstIndent = 1;
    content = m.slice(1);
  } else {
    firstIndent = fn;
    content = m.slice(fn);
  }
  return {
    kind,
    bulletChar,
    delimChar,
    start,
    contentIndent: indent + markerWidth + firstIndent,
    content,
    m,
    empty,
  };
}

function sameListKind(list, marker) {
  if (list.listKind !== marker.kind) return false;
  return marker.kind === 'bullet'
    ? list.bulletChar === marker.bulletChar
    : list.delimChar === marker.delimChar;
}

// Count leading spaces of a frame line (tabs are not spaces here: the
// reference patterns only allow literal spaces before the construct).
function leadSpaces(s) {
  let n = 0;
  while (n < s.length && s[n] === ' ') n++;
  return n;
}

// Does the frame line start a fence, heading, HTML block, block quote
// or thematic break, allowing up to `maxSp` leading spaces? These are
// the constructs that stop an item gathering its lines.
function beginBlockMatch(frame, maxSp, includeQuote) {
  const sp = leadSpaces(frame);
  if (sp > maxSp) return false;
  const s = frame.slice(sp);
  if (s === '') return false;
  const c = s[0];
  if (c === '`' || c === '~') {
    return s.length >= 3 && s[1] === c && s[2] === c;
  }
  if (c === '#') {
    let n = 0;
    while (n < s.length && s[n] === '#') n++;
    return n <= 6 && (n >= s.length || s[n] === ' ' || s[n] === '\t');
  }
  if (c === '>') return includeQuote;
  if (c === '<') return htmlBeginMatch(s);
  if (c === '-' || c === '_' || c === '*') {
    // Thematic break: at least three of the same character, with only
    // spaces/tabs mixed in.
    let count = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === c) count++;
      else if (s[k] !== ' ' && s[k] !== '\t') return false;
    }
    return count >= 3;
  }
  return false;
}

// The HTML block beginning patterns (shared by several checks).
function htmlBeginMatch(s) {
  // s starts with '<'.
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[')) return true;
  if (s.length >= 3 && s[1] === '!' && isAsciiLetter(s.charCodeAt(2))) return true;
  let j = 1;
  if (s[j] === '/') j++;
  const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(s.slice(j));
  if (nameMatch === null) return false;
  const name = nameMatch[0].toLowerCase();
  const after = s[j + nameMatch[0].length];
  if (
    s[1] !== '/' &&
    (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')
  ) {
    return after === undefined || after === ' ' || after === '\t' || after === '>' || after === '\n';
  }
  if (BLOCK_TAGS.has(name)) {
    return (
      after === undefined ||
      after === ' ' ||
      after === '>' ||
      (after === '/' && s[j + nameMatch[0].length + 1] === '>')
    );
  }
  return false;
}

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Does the frame line look like a new list item (any marker), allowing
// up to `maxSp` leading spaces? A marker must be followed by a space,
// a tab, or the end of the line.
function nextBulletMatch(frame, maxSp) {
  const sp = leadSpaces(frame);
  if (sp > maxSp) return false;
  const s = frame.slice(sp);
  if (s === '') return false;
  const c = s[0];
  let j;
  if (c === '-' || c === '+' || c === '*') {
    j = 1;
  } else if (c >= '0' && c <= '9') {
    j = 0;
    let digits = 0;
    while (j < s.length && digits < 9 && s[j] >= '0' && s[j] <= '9') {
      j++;
      digits++;
    }
    if (s[j] !== '.' && s[j] !== ')') return false;
    j++;
  } else {
    return false;
  }
  return j >= s.length || s[j] === ' ' || s[j] === '\t';
}

// Is this frame line a setext underline (up to 3 leading spaces, then
// only = or only -, then only spaces)?
function isSetextUnderlineLine(frame) {
  let i = 0;
  let sp = 0;
  while (frame[i] === ' ' && sp < 4) {
    i++;
    sp++;
  }
  if (sp > 3) return false;
  const c = frame[i];
  if (c !== '=' && c !== '-') return false;
  while (frame[i] === c) i++;
  while (frame[i] === ' ') i++;
  return i >= frame.length;
}

// Decide what an open list item does with the current line (given in
// the list's frame at P.pos). Returns 'consumed' when the line joins
// the item, 'sibling' when the line ends the item but may start the
// next one, and 'outside' when the line ends the item and the list.
// Pure: does not mutate anything.
function itemGatherCheck(P, item) {
  const frame = P.line.slice(P.pos);
  if (item.ended) {
    return nextBulletMatch(frame, 3) ? 'sibling' : 'outside';
  }
  if (isBlankStr(frame)) return 'consumed';
  // The reference computes its "begin" patterns with an indent budget
  // of min(R - 1, 3), where R is the item's content indent.
  const budget = Math.max(0, Math.min(3, item.itemR - 1));
  if (nextBulletMatch(frame, budget)) return 'sibling';
  if (beginBlockMatch(frame, budget, true)) return 'outside';
  const z = detabLeadingStr(frame, 0);
  const zi = firstNonspaceIdx(z);
  if (zi >= item.itemR) return 'consumed';
  // The line is not indented enough: it can still join the item as a
  // lazy continuation, unless the previous line rules that out.
  if (item.prevBlank) return 'outside';
  const prev = item.prevDedent;
  if (firstNonspaceIdx(prev.replace(/\t/g, '    ')) >= 4) return 'outside';
  if (beginBlockMatch(prev, budget, false)) return 'outside';
  return 'consumed';
}

// Apply a 'consumed' decision: append the current line (in the list's
// frame at P.pos) to the item's gathered content lines.
function itemGatherApply(P, item) {
  const frame = P.line.slice(P.pos);
  const r = item.itemR;
  if (isBlankStr(frame)) {
    if (item.firstLineEmpty && item.lines.length === 1 && !item.ended) {
      // An empty item followed immediately by a blank line ends at
      // once; the blank line is part of its raw text but not its text.
      item.ended = true;
      item.endEarly = true;
      item.endBlank = true;
      item.prevBlank = true;
      return;
    }
    const z = detabLeadingStr(frame, 0);
    const dedented = z.slice(r);
    item.lines.push(dedented);
    item.endBlank = true;
    item.prevBlank = true;
    item.prevDedent = dedented;
    return;
  }
  const z = detabLeadingStr(frame, 0);
  const zi = firstNonspaceIdx(z);
  if (zi >= r) {
    item.lines.push(z.slice(r));
  } else if (isSetextUnderlineLine(frame) && item.prevDedent.trim() !== '') {
    // A setext underline arriving as a lazy continuation is defused
    // with four spaces of indentation, so it stays literal text when
    // the item's content is lexed.
    item.lines.push('    ' + z.replace(/^ {0,3}/, ''));
  } else {
    item.lines.push(frame);
  }
  item.endBlank = false;
  item.prevBlank = false;
  item.prevDedent = z.slice(r);
}

// ---------------------------------------------------------------------------
// Block-start attempts. Each returns 'leaf' when the line was consumed by
// a leaf block, 'container' when a container was opened (and the caller
// should try for further starts on the rest of the line), or null.
// On null the parser cursor is restored by the caller.
// ---------------------------------------------------------------------------

function snapshotCursor(P) {
  return { line: P.line, pos: P.pos, col: P.col };
}
function restoreCursor(P, snap) {
  P.line = snap.line;
  P.pos = snap.pos;
  P.col = snap.col;
}

function tryBlockStart(P, inParagraph) {
  const s = P.line;
  const i = P.firstNonspace;
  const c = s[i];
  const tip = P.tip;

  // Block quote.
  if (c === '>' && P.indent <= 3) {
    detabQuoteRun(P);
    P.pos = i;
    P.col = P.firstNonspaceCol;
    P.pos++;
    P.col++;
    const after = P.line[P.pos];
    if (after === ' ' || after === '\t') advanceCols(P, 1);
    addChild(P, 'blockquote');
    return 'container';
  }

  // ATX heading.
  if (c === '#' && P.indent <= 3) {
    let j = i;
    let level = 0;
    while (j < s.length && s[j] === '#' && level < 7) {
      j++;
      level++;
    }
    if (level <= 6 && (j >= s.length || s[j] === ' ' || s[j] === '\t')) {
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      let content = s.slice(j).replace(/[ \t]+$/, '');
      // Optional closing sequence of #s, preceded by whitespace or
      // making up the whole content.
      const closeMatch = /(?:^|[ \t])#+$/.exec(content);
      if (closeMatch !== null) {
        content = content.slice(0, content.length - closeMatch[0].length).replace(/[ \t]+$/, '');
      }
      const h = addChild(P, 'heading');
      h.level = level;
      h.text = content;
      finalizeBlock(P, h);
      return 'leaf';
    }
  }

  // Fenced code.
  if ((c === '`' || c === '~') && P.indent <= 3) {
    let j = i;
    while (j < s.length && s[j] === c) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      const info = s.slice(j).trim();
      if (c !== '`' || info.indexOf('`') === -1) {
        const code = addChild(P, 'code');
        code.fenced = true;
        code.fenceChar = c;
        code.fenceLen = runLen;
        // The indent is measured in characters: content lines lose
        // up to this many leading whitespace characters each. Tilde
        // fences never dedent their content in the reference.
        code.fenceIndent = c === '~' ? 0 : i - P.pos;
        code.info = unescapeBackslash(info);
        return 'leaf';
      }
    }
  }

  // HTML block.
  if (c === '<' && P.indent <= 3) {
    const type = htmlBlockStart(P, inParagraph && !P.nonTop);
    if (type !== 0) {
      const html = addChild(P, 'html');
      html.htmlType = type;
      html.text = s.slice(P.pos);
      html.lineCount = 1;
      html.lastLineIndex = P.lineIndex;
      if (type <= 5 && htmlBlockEnded(html, html.text)) finalizeBlock(P, html);
      return 'leaf';
    }
  }

  // Setext heading underline (the open paragraph becomes a heading).
  if (
    tip.type === 'paragraph' &&
    !tip.noSetext &&
    !P.defuseLine &&
    P.indent <= 3 &&
    (c === '=' || c === '-')
  ) {
    const rest = s.slice(i);
    if (/^=+[ \t]*$/.test(rest) || /^-+[ \t]*$/.test(rest)) {
      // Leading link definitions are separate blocks, not part of
      // the heading text; if nothing else remains there is no
      // heading at all and the underline is just a paragraph line.
      const stripped = stripLinkDefs(P, tip.text);
      if (stripped.trim() === '') {
        const parent = tip.parent;
        parent.children.splice(parent.children.indexOf(tip), 1);
        tip.open = false;
        P.tip = parent;
        return null;
      }
      tip.type = 'heading';
      tip.level = c === '=' ? 1 : 2;
      tip.text = stripped.trim();
      finalizeBlock(P, tip);
      return 'leaf';
    }
  }

  // Table: the line is a delimiter row and the open paragraph's last
  // line is the header.
  if (tip.type === 'paragraph' && s.indexOf('|', P.pos) !== -1) {
    const aligns = parseDelimiterRow(s.slice(P.pos));
    if (aligns !== null) {
      const paraLines = tip.text.split('\n');
      const headerCells = splitCells(paraLines[paraLines.length - 1]);
      if (headerCells.length === aligns.length) {
        paraLines.pop();
        if (paraLines.length === 0) {
          const parent = tip.parent;
          parent.children.splice(parent.children.indexOf(tip), 1);
          tip.open = false;
          P.tip = parent;
        } else {
          tip.text = paraLines.join('\n');
          finalizeBlock(P, tip);
        }
        const table = addChild(P, 'table');
        table.startLine = P.lineIndex - 1; // the header is the line above
        table.header = headerCells;
        table.aligns = aligns;
        table.rows = [];
        return 'leaf';
      }
    }
  }

  // Thematic break.
  if (P.indent <= 3 && (c === '-' || c === '_' || c === '*')) {
    const rest = s.slice(i);
    let count = 0;
    let ok = true;
    for (let j = 0; j < rest.length; j++) {
      const ch = rest[j];
      if (ch === c) count++;
      else if (ch !== ' ' && ch !== '\t') {
        ok = false;
        break;
      }
    }
    if (ok && count >= 3) {
      const hr = addChild(P, 'hr');
      finalizeBlock(P, hr);
      return 'leaf';
    }
  }

  // List item. The item collects its content lines (starting with the
  // rest of this line) and parses them when it closes, so the line is
  // fully consumed here.
  if (P.indent <= 3 && (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9'))) {
    const snap = snapshotCursor(P);
    const marker = parseListMarker(P, inParagraph && !P.nonTop);
    if (marker !== null) {
      let list;
      if (tip.type === 'list' && sameListKind(tip, marker)) {
        list = tip;
      } else {
        list = addChild(P, 'list');
        list.listKind = marker.kind;
        list.bulletChar = marker.bulletChar;
        list.delimChar = marker.delimChar;
        list.start = marker.start;
      }
      const item = addChild(P, 'item');
      item.lines = [marker.content];
      item.itemR = marker.contentIndent;
      item.prevBlank = marker.empty;
      item.prevDedent = marker.m;
      item.firstLineEmpty = marker.empty;
      item.task = /^\[[ xX]\][ \t]+\S/.test(marker.content);
      item.checked = marker.content[1] !== ' ';
      P.tip = item;
      return 'leaf';
    }
    restoreCursor(P, snap);
  }

  // Indented code (cannot interrupt a paragraph).
  if (P.indent >= 4 && tip.type !== 'paragraph' && !inParagraph) {
    advanceCols(P, 4);
    const code = addChild(P, 'code');
    code.fenced = false;
    code.text = P.line.slice(P.pos) + '\n';
    P.tip = code;
    return 'leaf';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Line incorporation: the block-structure state machine.
// ---------------------------------------------------------------------------

function fenceCloseMatches(P, block) {
  const s = P.line;
  let j = P.firstNonspace;
  let run = 0;
  while (s[j] === block.fenceChar) {
    j++;
    run++;
  }
  if (run < block.fenceLen) return false;
  while (j < s.length) {
    if (s[j] !== ' ' && s[j] !== '\t') return false;
    j++;
  }
  return true;
}

function addTextLine(P, block, prefix) {
  const text = (prefix || '') + P.line.slice(P.pos);
  if (block.lineCount > 0) block.text += '\n' + text;
  else block.text = text;
  block.lineCount++;
}

// Would this line (in the current frame) continue a paragraph inside a
// block quote whose '>' marker it lacks? The reference captures lazy
// lines into a quote only when they are paragraph continuations: they
// must not be blank and must not themselves start a block (rule,
// heading, quote, fence, list, or HTML block).
function quoteLazyParaOk(P) {
  const frame = P.line.slice(P.pos);
  if (isBlankStr(frame)) return false;
  const sp = leadSpaces(frame);
  if (sp > 3) return true;
  const s = frame.slice(sp);
  const c = s[0];
  if (c === '>') return false;
  if (c === '#') {
    let n = 0;
    while (n < s.length && s[n] === '#') n++;
    if (n <= 6 && (n >= s.length || s[n] === ' ' || s[n] === '\t')) return false;
  }
  if (c === '`' || c === '~') {
    let n = 0;
    while (n < s.length && s[n] === c) n++;
    if (n >= 3 && (c === '~' || s.indexOf('`', n) === -1)) return false;
  }
  if (c === '-' || c === '_' || c === '*') {
    // Thematic break?
    let count = 0;
    let ok = true;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === c) count++;
      else if (s[k] !== ' ' && s[k] !== '\t') {
        ok = false;
        break;
      }
    }
    if (ok && count >= 3) return false;
  }
  if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
    // A list marker followed by whitespace or end of line interrupts.
    let j = 0;
    if (c >= '0' && c <= '9') {
      let digits = 0;
      while (j < s.length && digits < 9 && s[j] >= '0' && s[j] <= '9') {
        j++;
        digits++;
      }
      if (s[j] === '.' || s[j] === ')') {
        j++;
        if (j >= s.length || s[j] === ' ' || s[j] === '\t') return false;
      }
    } else {
      j = 1;
      if (j >= s.length || s[j] === ' ' || s[j] === '\t') return false;
    }
  }
  if (c === '<' && htmlBeginMatch(s)) return false;
  return true;
}

// Can a block quote that this line does not carry a '>' for still
// absorb the line? It can when the quote's open content would take the
// line anyway: a paragraph continuation, or a line an open list item
// inside the quote gathers (including a sibling item).
function quoteLazyAbsorb(P, quote) {
  // A blank line is never a lazy continuation: the reference's
  // quote extent covers only '>'-prefixed lines and paragraph
  // continuation lines, so a blank line always ends the quote.
  if (P.blank) return false;
  const tip = P.tip;
  if (tip === null || tip === quote) return false;
  if (tip.type === 'paragraph') return quoteLazyParaOk(P);
  if (tip.type === 'item') {
    // The quote may absorb a line through a collecting item only
    // while the item's gathered content is still open-ended (its
    // last gathered line is not blank): once a blank line has been
    // gathered, the item's content is closed, and the reference's
    // quote extent no longer grows — even for lines the item would
    // gather at the top level.
    const lines = tip.lines;
    if (lines.length > 0 && isBlankStr(lines[lines.length - 1])) return false;
    return itemGatherCheck(P, tip) === 'consumed';
  }
  return false;
}

// In the reference's setext (lheading) matching, the heading text may
// not contain a continuation line that starts a list, is indented
// code, is shaped like a table delimiter row, or is a lone HTML tag.
// Paragraphs record that here so a later underline stays literal.
function continuationBlocksSetext(P) {
  if (P.indent >= 4) return true;
  const frame = P.line.slice(P.pos);
  const sp = leadSpaces(frame);
  if (sp > 3) return false;
  const s = frame.slice(sp);
  if (s === '') return false;
  const c = s[0];
  if (c === '-' || c === '+' || c === '*') return true;
  if (c >= '0' && c <= '9') {
    let j = 0;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (s[j] === '.' || s[j] === ')') return true;
  }
  if (c === '<') {
    const gt = s.indexOf('>');
    if (gt > 0 && gt === s.length - 1) return true;
  }
  if (c === '|' || c === ':') {
    let hasPipe = false;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === '|') hasPipe = true;
      else if (ch !== ':' && ch !== '-' && ch !== ' ') return false;
    }
    if (hasPipe) return true;
  }
  return false;
}

// Does this line continue an open table as another body row? Rows stop
// at blank lines and at lines that start another block.
function tableRowContinues(P) {
  const frame = P.line.slice(P.pos);
  // A row ends at a blank line, which for the reference's table
  // pattern means an empty or spaces-only line (a tab-only line is
  // a row of empty cells), and at an indented line: four columns of
  // indentation with any character after them.
  if (/^ *$/.test(frame)) return false;
  {
    let i = 0;
    let col = 0;
    while (i < frame.length && col < 4) {
      if (frame[i] === ' ') {
        col++;
        i++;
      } else if (frame[i] === '\t') {
        col += 4 - (col % 4);
        i++;
      } else {
        break;
      }
    }
    if (col >= 4 && i < frame.length) return false;
  }
  const sp = leadSpaces(frame);
  if (sp > 3) return true;
  const s = frame.slice(sp);
  const c = s[0];
  if (c === '>') return false;
  if (c === '#') {
    let n = 0;
    while (n < s.length && s[n] === '#') n++;
    if (n <= 6 && (n >= s.length || s[n] === ' ' || s[n] === '\t')) return false;
  }
  if (c === '`' || c === '~') {
    let n = 0;
    while (n < s.length && s[n] === c) n++;
    if (n >= 3 && (c === '~' || s.indexOf('`', n) === -1)) return false;
  }
  if (c === '-' || c === '_' || c === '*') {
    let count = 0;
    let ok = true;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === c) count++;
      else if (s[k] !== ' ' && s[k] !== '\t') {
        ok = false;
        break;
      }
    }
    if (ok && count >= 3) return false;
  }
  if (c === '-' || c === '+' || c === '*') {
    if (s.length === 1 || s[1] === ' ' || s[1] === '\t') return false;
  }
  if (c === '1' && (s[1] === '.' || s[1] === ')') && (s.length === 2 || s[2] === ' ' || s[2] === '\t')) {
    return false;
  }
  if (c === '<' && htmlBeginMatch(s)) return false;
  return true;
}

function incorporateLine(P, line) {
  P.line = line;
  P.pos = 0;
  P.col = 0;
  P.lineLazyQuote = false;
  P.defuseLine = false;
  let codeMatched = false;

  // The parsing mode is set by the nearest enclosing boundary: list
  // item content is lexed line-by-line (text tokens), everything else
  // with whole-paragraph matching.
  {
    let b = P.tip;
    P.nonTop = false;
    while (b !== null) {
      if (b.type === 'item') {
        P.nonTop = true;
        break;
      }
      if (b.type === 'blockquote' || b.type === 'document') break;
      b = b.parent;
    }
  }

  // Descend through the open blocks, matching each container against
  // this line (a block quote needs its '>', a list item gathers it).
  let container = P.doc;
  for (;;) {
    const child = lastOpenChild(container);
    if (child === null) break;
    if (child.type === 'blockquote') {
      computeFirstNonspace(P);
      if (!P.blank && P.indent <= 3 && P.line[P.firstNonspace] === '>') {
        detabQuoteRun(P);
        P.pos = P.firstNonspace;
        P.col = P.firstNonspaceCol;
        P.pos++;
        P.col++;
        const after = P.line[P.pos];
        if (after === ' ' || after === '\t') advanceCols(P, 1);
        container = child;
      } else if (quoteLazyAbsorb(P, child)) {
        P.lineLazyQuote = true;
        container = child;
      } else {
        break;
      }
    } else if (child.type === 'item') {
      const decision = itemGatherCheck(P, child);
      if (decision === 'consumed') {
        itemGatherApply(P, child);
        return;
      }
      // The item ends here: parse its gathered content, then let the
      // line be processed at the list level (sibling item or beyond).
      const list = child.parent;
      finalizeBlock(P, child);
      if (child.endEarly && isBlankStr(P.line.slice(P.pos))) {
        // One more blank line after an early-ended item ends the list.
        finalizeBlock(P, list);
        container = list.parent;
      } else {
        container = list;
      }
      break;
    } else if (child.type === 'list') {
      container = child;
    } else if (child.type === 'code' && !child.fenced) {
      computeFirstNonspace(P);
      if (P.blank) {
        // Blank lines inside indented code keep whatever indentation
        // they have beyond the four code columns.
        advanceCols(P, 4);
        container = child;
        codeMatched = true;
      } else if (P.indent >= 4) {
        advanceCols(P, 4);
        container = child;
        codeMatched = true;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  const lastMatched = container;
  const oldTip = P.tip;
  const frameStart = P.pos;
  // Everything matched when the descent reached the tip itself, or
  // when the tip is a leaf block whose parent container matched (leaf
  // blocks do not match lines during the descent).
  const allMatched =
    lastMatched === oldTip ||
    (oldTip.parent === lastMatched &&
      (oldTip.type === 'paragraph' ||
        oldTip.type === 'code' ||
        oldTip.type === 'html' ||
        oldTip.type === 'table'));
  computeFirstNonspace(P);

  // Leaf blocks that simply continue when everything matched.
  if (allMatched) {
    if (oldTip.type === 'code' && oldTip.fenced) {
      if (!P.blank && P.indent <= 3 && fenceCloseMatches(P, oldTip)) {
        finalizeBlock(P, oldTip);
      } else {
        // Content lines lose up to fenceIndent leading whitespace
        // characters (a tab counts as one character, as in the
        // reference's dedent).
        let fp = P.pos;
        let strip = oldTip.fenceIndent;
        const fl = P.line;
        while (strip > 0 && (fl[fp] === ' ' || fl[fp] === '\t')) {
          fp++;
          strip--;
        }
        oldTip.text += fl.slice(fp) + '\n';
      }
      return;
    }
    if (oldTip.type === 'html' && oldTip.htmlType <= 5) {
      oldTip.text += '\n' + P.line.slice(P.pos);
      oldTip.lineCount++;
      oldTip.lastLineIndex = P.lineIndex;
      if (htmlBlockEnded(oldTip, P.line.slice(P.pos))) finalizeBlock(P, oldTip);
      return;
    }
    if (oldTip.type === 'code' && !oldTip.fenced && codeMatched) {
      oldTip.text += P.line.slice(P.pos) + '\n';
      return;
    }
    if (oldTip.type === 'table' && tableRowContinues(P)) {
      oldTip.rows.push(splitCells(P.line.slice(P.pos)));
      return;
    }
    if (oldTip.type === 'html' && !P.blank) {
      // HTML blocks of type 6 and 7 continue until a blank line.
      oldTip.text += '\n' + P.line.slice(P.pos);
      oldTip.lineCount++;
      oldTip.lastLineIndex = P.lineIndex;
      return;
    }
    if (oldTip.type === 'table' || oldTip.type === 'html') {
      // A blank line (or a block start) ends the table / HTML block.
      if (oldTip.type === 'html' && P.blank) oldTip.endedByBlank = true;
      finalizeBlock(P, oldTip);
    }
  }

  // A blank line closes whatever it does not continue.
  if (P.blank) {
    if (oldTip.type === 'paragraph' && wsLineJoinsParagraph(P, lastMatched, frameStart)) {
      // A whitespace-only line at the very end of the text being
      // lexed joins the paragraph as a text line instead of
      // separating blocks.
      const savePos = P.pos;
      P.pos = frameStart;
      if (oldTip.codePending) {
        oldTip.text += '\n';
        oldTip.codePending = false;
      }
      addTextLine(P, oldTip);
      oldTip.prevLazyQuote = P.lineLazyQuote;
      P.pos = savePos;
      return;
    }
    if (oldTip.type === 'paragraph') oldTip.codePending = false;
    closeBlocksAbove(P, lastMatched);
    return;
  }

  // In item content, an indented line that follows paragraph text is
  // an indented code block whose text merges into the paragraph (the
  // reference lexes both as one text token). The same merge happens
  // for an indented lazy line absorbed into a block quote's
  // paragraph: the reference lexes it as a separate chunk whose code
  // token merges the same way.
  if (
    allMatched &&
    (P.nonTop || P.lineLazyQuote) &&
    oldTip.type === 'paragraph' &&
    P.indent >= 4
  ) {
    advanceCols(P, 4);
    if (oldTip.lineCount > 0) oldTip.text += '\n';
    oldTip.text += P.line.slice(P.pos);
    oldTip.lineCount++;
    oldTip.noSetext = true;
    oldTip.codePending = true;
    return;
  }

  if (!allMatched) closeBlocksAbove(P, lastMatched);
  const openPara = P.tip.type === 'paragraph' ? P.tip : null;
  // A setext underline that joins a paragraph lazily through a block
  // quote, right after another lazy line, is defused instead of
  // converting the paragraph (the reference indents it by four).
  P.defuseLine = !!(
    openPara !== null &&
    P.lineLazyQuote &&
    openPara.prevLazyQuote &&
    isSetextUnderlineLine(P.line.slice(P.pos))
  );
  let inParagraph = openPara !== null;
  let started = null;
  for (;;) {
    computeFirstNonspace(P);
    if (P.blank) break;
    const snap = snapshotCursor(P);
    const r = tryBlockStart(P, inParagraph);
    if (r === null) {
      restoreCursor(P, snap);
      break;
    }
    started = r;
    if (r === 'leaf') break;
    // A freshly opened container is a new lexing context: a
    // paragraph open outside it does not gate what starts inside
    // (the reference lexes the container's content separately).
    inParagraph = false;
  }
  if (openPara !== null && openPara.codePending) {
    // A block start won over a paragraph whose last chunk was merged
    // code: the code chunk's text ends with a newline.
    if (started !== null) openPara.text += '\n';
    openPara.codePending = false;
  }
  if (started === 'leaf') return;
  computeFirstNonspace(P);
  if (P.blank) return;

  // What remains is a text line: continue the open paragraph or open one.
  if (P.tip.type === 'paragraph') {
    let prefix = '';
    if (P.tip.codePending) {
      prefix += '\n';
      P.tip.codePending = false;
    }
    if (P.defuseLine) prefix += '    ';
    addTextLine(P, P.tip, prefix);
    if (continuationBlocksSetext(P)) P.tip.noSetext = true;
    P.tip.prevLazyQuote = P.lineLazyQuote;
  } else {
    addTextLine(P, addChild(P, 'paragraph'));
  }
}

// Whether a whitespace-only line joins the open paragraph as a
// text line: the reference's paragraph pattern only breaks on such
// a line when a newline follows it in the text being lexed. That
// is the case at the end of the input, at the end of a list item's
// gathered text, and for the last line of a block quote's content
// (the quote raw is trimmed of its final newline, and the quote
// does not continue past this line).
function wsLineJoinsParagraph(P, lastMatched, frameStart) {
  // The line must actually contain whitespace in the current frame
  // (an empty line always separates).
  if (P.line.slice(frameStart) === '') return false;
  if (P.lineIndex === P.totalLines - 1 && !P.endsWithNewline && P.line !== '') {
    return true;
  }
  let quote = null;
  for (let b = P.tip; b !== null; b = b.parent) {
    if (b.type === 'blockquote') {
      quote = b;
      break;
    }
  }
  if (quote === null) return false;
  let inside = false;
  for (let m = lastMatched; m !== null; m = m.parent) {
    if (m === quote) {
      inside = true;
      break;
    }
  }
  if (!inside) return false;
  const next = P.allLines[P.lineIndex + 1];
  if (next !== undefined && /^ {0,3}>/.test(next)) return false;
  return true;
}

function parseBlocks(P, src) {
  const lines = src.split('\n');
  P.endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (P.endsWithNewline) lines.pop();
  P.totalLines = lines.length;
  P.allLines = lines;
  for (let i = 0; i < lines.length; i++) {
    P.lineIndex = i;
    incorporateLine(P, lines[i]);
  }
  P.eofFinalize = true;
  closeBlocksAbove(P, P.doc);
}

// Parse a list item's gathered content lines into child blocks of the
// item, sharing the document's link definitions. Whether the content
// is split into blocks by a blank line (which makes the list loose)
// is derived from the child blocks' line spans afterwards.
function parseItemContent(item, links) {
  // The reference lexes the item's text with trailing blank lines
  // removed (they belong to the list's raw text, not the item's).
  const lines = item.lines.slice();
  while (lines.length > 0 && isBlankStr(lines[lines.length - 1])) lines.pop();
  const sub = {
    doc: item,
    tip: item,
    links,
    line: '',
    pos: 0,
    col: 0,
    firstNonspace: 0,
    firstNonspaceCol: 0,
    indent: 0,
    blank: false,
    lineIndex: 0,
    totalLines: lines.length,
    allLines: lines,
    endsWithNewline: false,
    nonTop: true,
    lineLazyQuote: false,
    defuseLine: false,
    trackSpans: true,
    eofFinalize: false,
  };
  for (let i = 0; i < lines.length; i++) {
    sub.lineIndex = i;
    incorporateLine(sub, lines[i]);
  }
  sub.eofFinalize = true;
  closeBlocksAbove(sub, item);
  // A blank line between two child blocks (or two before the first)
  // means the reference produced a space token inside this item.
  const kids = item.children;
  let mid = false;
  if (kids.length > 0) {
    let blanks = 0;
    for (let i = 0; i < kids[0].startLine; i++) {
      if (isBlankStr(lines[i])) blanks++;
    }
    if (blanks >= 2) mid = true;
    for (let k = 1; k < kids.length && !mid; k++) {
      blanks = 0;
      for (let i = kids[k - 1].endLine + 1; i < kids[k].startLine; i++) {
        if (isBlankStr(lines[i])) blanks++;
      }
      if (blanks >= 1) mid = true;
    }
  }
  item.midBlank = mid;
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// The scanner walks the block's text once, building a list of nodes.
// Emphasis and strikethrough are resolved with a delimiter stack, links
// and images with a bracket stack, in the usual two-part arrangement:
// a link is formed when its ']' is reached, after the emphasis inside
// it has been processed.
// ---------------------------------------------------------------------------

function makeNode(k) {
  return {
    k, // text | ent | raw | code | br | delim | em | strong | del | link | img | root
    v: '',
    ch: '',
    n: 0,
    href: null,
    title: null,
    autolink: false,
    escFull: false,
    first: null,
    last: null,
    prev: null,
    next: null,
    parent: null,
  };
}

function appendNode(parent, node) {
  node.parent = parent;
  node.prev = parent.last;
  node.next = null;
  if (parent.last !== null) parent.last.next = node;
  else parent.first = node;
  parent.last = node;
}

function detachNode(node) {
  const parent = node.parent;
  if (parent !== null) {
    if (node.prev !== null) node.prev.next = node.next;
    else parent.first = node.next;
    if (node.next !== null) node.next.prev = node.prev;
    else parent.last = node.prev;
  }
  node.parent = null;
  node.prev = null;
  node.next = null;
}

// Plain-text content of a node range (for link labels and image alt text).
function textOfNode(node) {
  switch (node.k) {
    case 'text':
    case 'code':
      return node.v;
    case 'ent':
      return node.v;
    case 'raw':
      return '';
    case 'br':
      return '\n';
    case 'delim':
      return node.ch.repeat(node.n);
    default: {
      let out = '';
      for (let c = node.first; c !== null; c = c.next) out += textOfNode(c);
      return out;
    }
  }
}

function textOfRange(first, last) {
  let out = '';
  for (let c = first; c !== null; c = c.next) {
    out += textOfNode(c);
    if (c === last) break;
  }
  return out;
}

// Wrap the nodes strictly between openerNode and closerNode in a new
// container node inserted where they were.
function wrapNodes(openerNode, closerNode, wrap) {
  const parent = openerNode.parent;
  const first = openerNode.next;
  wrap.parent = parent;
  if (first === closerNode) {
    wrap.first = null;
    wrap.last = null;
  } else {
    let last = first;
    while (last.next !== closerNode) last = last.next;
    wrap.first = first;
    wrap.last = last;
    first.prev = null;
    last.next = null;
    for (let n = first; n !== null; n = n.next) n.parent = wrap;
  }
  wrap.prev = openerNode;
  wrap.next = closerNode;
  openerNode.next = wrap;
  closerNode.prev = wrap;
}

// ---------------------------------------------------------------------------
// Emphasis and strikethrough matching.
//
// The reference resolves emphasis left to right: at each delimiter
// run that may open, it scans forward over the following runs,
// classifying each by its surrounding characters. Runs that can
// only open add their length to the amount the opener still needs;
// runs that can close subtract theirs; a match completes at the
// first closer that brings the balance to zero, subject to a
// rule-of-three skip. The content of a match is resolved as its own
// range before wrapping, so delimiters inside a matched pair never
// pair with runs outside it.
// ---------------------------------------------------------------------------

const PUNCT_CH_RE = /[\p{P}\p{S}]/u;
const ALNUM_CH_RE = /[\p{L}\p{N}]/u;

function isPunctCh(ch) {
  return ch !== '' && PUNCT_CH_RE.test(ch);
}

function isPunctSpaceCh(ch) {
  return ch !== '' && (isSpaceChar(ch) || PUNCT_CH_RE.test(ch));
}

// The character right after a run's full extent in the source.
function emphAfterChar(I, entry) {
  const end = entry.origIdx + entry.origN;
  return end < I.src.length ? I.src[end] : '';
}

// Whether a run may open emphasis, per the reference's opener gate:
// the character after the run must not be whitespace or the end;
// when it is punctuation, the character before the run must be
// absent or whitespace/punctuation-like; an underscore followed by
// a word character cannot open after an alphanumeric.
function emphEligible(I, op, startPrev) {
  const N = emphAfterChar(I, op);
  if (N === '' || isSpaceChar(N)) return false;
  const P =
    startPrev !== null && startPrev !== undefined
      ? startPrev
      : op.origIdx > 0
        ? I.src[op.origIdx - 1]
        : '';
  if (op.ch === '~') {
    return P === '' || (isPunctSpaceCh(P) && P !== '*' && P !== '_');
  }
  if (op.ch === '_' && !isPunctCh(N) && P !== '' && ALNUM_CH_RE.test(P)) {
    return false;
  }
  if (isPunctCh(N) && P !== '' && !(isPunctSpaceCh(P) && P !== '*' && P !== '_')) {
    return false;
  }
  return true;
}

// The reference's R flag for an opener: it makes every closer
// candidate subject to the rule-of-three skip.
function emphRFlag(I, op) {
  const P = op.origIdx > 0 ? I.src[op.origIdx - 1] : '';
  if (P === '' || isSpaceChar(P)) return false;
  return isPunctCh(emphAfterChar(I, op)) || (op.ch === '*' && !isPunctSpaceCh(P));
}

// Classify a run by its neighbours: 0 = cannot take part, 1 = can
// close, 2 = can only open (adds to the balance), 3 = can close but
// is subject to the rule-of-three skip and the shrunk-opener break.
function emphClass(I, entry) {
  const src = I.src;
  const P = entry.idx > 0 ? src[entry.idx - 1] : '\n';
  const nIdx = entry.idx + entry.n;
  const N = nIdx < src.length ? src[nIdx] : '';
  const pPunct = isPunctCh(P);
  const pSpace = isPunctSpaceCh(P);
  const pWord = !pSpace;
  const nPunct = isPunctCh(N);
  const nWs = N === '' || isSpaceChar(N);
  const nSpace = N === '' || isPunctSpaceCh(N);
  const nWord = N !== '' && !isPunctSpaceCh(N);
  if (entry.ch === '_') {
    if (pPunct && nPunct) return 3;
    if (pPunct && nWs) return 1;
    if (pWord && nSpace) return 1;
    if (pSpace && nWord) return 2;
    if (isSpaceChar(P) && nPunct) return 2;
    return 0;
  }
  if (entry.ch === '~') {
    if (pSpace && nWord) return 2;
    if (isSpaceChar(P) && nPunct) return 2;
    if (pPunct && nWs) return 1;
    if (pWord && nSpace) return 1;
    if (pPunct && nPunct) return 1;
    if (pWord && nWord) return 1;
    return 0;
  }
  // '*'
  if (pPunct && nPunct) return 3;
  if (pWord && nWord) return 3;
  if (pPunct && nWs) return 1;
  if (pWord && nSpace) return 1;
  if (pSpace && nWord) return 2;
  if (isSpaceChar(P) && nPunct) return 2;
  return 0;
}

// Scan forward from the opener at stack index oi for its match,
// following the balance accounting described above. The scan stops
// before the hiEntry entry (or at the end of the stack). Returns
// {entry, use, bUsed} or null.
function emphScan(I, oi, hiEntry, op) {
  const stack = I.delimStack;
  const ch = op.ch;
  let m = op.n;
  let f = 0;
  // The rule-of-three position: characters of this delimiter given
  // up by shortening plus the trial run length.
  const y = op.idx - op.origIdx + op.n;
  const R = emphRFlag(I, op);
  // The scan pattern has a dedicated alternative that skips a
  // complete strong span of the other delimiter kind when it comes
  // first (a __..*..__ span in a '*' scan, a **.._..** span in a
  // '_' scan): the runs inside such a span do not count.
  let startCi = oi + 1;
  if (ch === '*' || ch === '_') {
    const other = ch === '*' ? '_' : '*';
    let j0 = oi + 1;
    while (
      j0 < stack.length &&
      stack[j0] !== hiEntry &&
      (stack[j0].ch === '~' || stack[j0].n === 0 || entryHidden(I, stack[j0]))
    ) {
      j0++;
    }
    const e1 = stack[j0];
    if (e1 !== undefined && e1 !== hiEntry && e1.ch === other && e1.n >= 2) {
      let seenCh = false;
      for (let j = j0 + 1; j < stack.length && stack[j] !== hiEntry; j++) {
        const e = stack[j];
        if (e.ch === '~' || e.n === 0 || entryHidden(I, e)) continue;
        if (!seenCh && e.ch === ch && e.n === 1) {
          seenCh = true;
          continue;
        }
        if (seenCh && e.ch === other && e.n >= 2) startCi = j;
        break;
      }
    }
  }
  for (let ci = startCi; ci < stack.length && stack[ci] !== hiEntry; ci++) {
    const cl = stack[ci];
    if (cl.ch !== ch || cl.n === 0 || entryHidden(I, cl)) continue;
    // A strikethrough candidate must have the opener's run length.
    if (ch === '~' && cl.n !== op.n) continue;
    const cls = emphClass(I, cl);
    if (cls === 0) continue;
    if (cls === 2) {
      m += cl.n;
      continue;
    }
    if (ch !== '~' && (cls === 3 || R)) {
      // A special closer after a shortened opener breaks the scan.
      if (op.shrunk && cls === 3) return null;
      if (y % 3 !== 0 && (y + cl.n) % 3 === 0) {
        f += cl.n;
        continue;
      }
    }
    m -= cl.n;
    if (m > 0) continue;
    const bUsed = Math.min(cl.n, cl.n + m + f);
    const use =
      ch === '~' ? op.n : Math.min(op.n, bUsed) % 2 === 1 ? 1 : 2;
    return { entry: cl, use, bUsed };
  }
  return null;
}

// Resolve the delimiter entries in stack[lo, hi) (hi given as the
// entry that bounds the range, or null for the end of the stack).
// firstEntry, when given, is an entry whose preceding character for
// the opener gate is firstPrev instead of the source character
// (used when the range is lexed as its own text, like link text or
// emphasis content).
function emphRange(I, lo, hiEntry, firstEntry, firstPrev) {
  const stack = I.delimStack;
  let i = lo;
  while (i < stack.length && stack[i] !== hiEntry) {
    const op = stack[i];
    if (
      op.n === 0 ||
      entryHidden(I, op) ||
      !emphEligible(I, op, op === firstEntry ? firstPrev : null)
    ) {
      i++;
      continue;
    }
    const m = emphScan(I, i, hiEntry, op);
    if (m === null) {
      // The reference retries the opener one character shorter (the
      // dropped character becomes plain text), but only when the
      // character after the run is a word character: with a
      // punctuation character there, its gate rejects the shorter
      // run as well.
      if (op.n > 1 && !isPunctCh(emphAfterChar(I, op))) {
        op.n--;
        op.idx++;
        op.shrunk = true;
        continue;
      }
      i++;
      continue;
    }
    const cl = m.entry;
    // The match's raw text spans the opener's whole trial run and
    // bUsed characters of the closer; the characters not used as
    // delimiters (opener excess before the content's start, closer
    // excess at its end) are part of the content in the reference's
    // model, so they re-enter the range as fresh delimiter entries
    // before the content is resolved.
    let innerFirst = null;
    if (op.n > m.use) {
      const extraNode = makeNode('delim');
      extraNode.ch = op.ch;
      extraNode.n = op.n - m.use;
      extraNode.parent = op.node.parent;
      extraNode.prev = op.node;
      extraNode.next = op.node.next;
      if (op.node.next !== null) op.node.next.prev = extraNode;
      op.node.next = extraNode;
      const extra = {
        node: extraNode, ch: op.ch, n: op.n - m.use,
        canOpen: true, canClose: true,
        idx: op.idx + m.use, origIdx: op.idx + m.use, origN: op.n - m.use,
        shrunk: false,
      };
      stack.splice(i + 1, 0, extra);
      innerFirst = extra;
    }
    if (m.bUsed > m.use) {
      const extraNode = makeNode('delim');
      extraNode.ch = op.ch;
      extraNode.n = m.bUsed - m.use;
      extraNode.parent = cl.node.parent;
      extraNode.prev = cl.node.prev;
      extraNode.next = cl.node;
      if (cl.node.prev !== null) cl.node.prev.next = extraNode;
      else if (cl.node.parent !== null) cl.node.parent.first = extraNode;
      cl.node.prev = extraNode;
      const extra = {
        node: extraNode, ch: op.ch, n: m.bUsed - m.use,
        canOpen: true, canClose: true,
        idx: cl.idx, origIdx: cl.idx, origN: m.bUsed - m.use,
        shrunk: false,
      };
      stack.splice(stack.indexOf(cl), 0, extra);
    }
    if (innerFirst === null) {
      const cand = stack[i + 1];
      if (cand !== undefined && cand !== cl && cand.node === op.node.next) {
        innerFirst = cand;
      }
    }
    // Resolve the content's own emphasis; its first entry, when it
    // starts the content, sees an empty preceding character.
    emphRange(I, i + 1, cl, innerFirst, '');
    const ci = stack.indexOf(cl);
    const wrap = makeNode(op.ch === '~' ? 'del' : m.use === 2 ? 'strong' : 'em');
    wrapNodes(op.node, cl.node, wrap);
    // Only the characters given up by shortening stay outside as
    // text; the whole trial run went into the match.
    op.node.n = op.origN - op.n;
    if (op.node.n === 0) detachNode(op.node);
    cl.node.n -= m.bUsed;
    cl.idx += m.bUsed;
    cl.n = cl.node.n;
    if (cl.node.n === 0) detachNode(cl.node);
    // The opener entry and everything between the pair leave the
    // stack (their nodes are inside the wrap now); the closer entry
    // stays when it has leftover characters.
    stack.splice(i, ci - i + 1);
    if (cl.n > 0) stack.splice(i, 0, cl);
  }
}

// Whether a delimiter entry is invisible to the current emphasis
// pass: entries inside a masked link shape do not participate. A
// link-text pass judges entries against the mask of the text alone
// (the reference lexes link text as its own string); the outer pass
// uses the mask of the whole text.
function entryHidden(I, e) {
  if (I.passMask !== null && I.passMask !== undefined) {
    return (
      I.passMask.length !== 0 &&
      inMaskRange(I.passMask, e.idx - I.passMaskBase)
    );
  }
  return I.masked.length !== 0 && inMaskRange(I.masked, e.idx);
}

function processEmphasis(I, bottom, bracket) {
  const stack = I.delimStack;
  let firstEntry = null;
  if (bracket !== undefined && bracket !== null) {
    const e = stack[bottom];
    if (e !== undefined && e.node === bracket.node.next) firstEntry = e;
  }
  emphRange(I, bottom, null, firstEntry, '');
}

// Flanking rules for a delimiter run at src[i] of the given length.
function flanking(src, i, runLen, ch) {
  const before = i > 0 ? src[i - 1] : '';
  const after = i + runLen < src.length ? src[i + runLen] : '';
  const beforeWs = before === '' || isSpaceChar(before);
  const afterWs = after === '' || isSpaceChar(after);
  const beforePunct = !beforeWs && isPunctChar(before);
  const afterPunct = !afterWs && isPunctChar(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  if (ch === '*') return { canOpen: leftFlanking, canClose: rightFlanking };
  if (ch === '_') {
    return {
      canOpen: leftFlanking && (!rightFlanking || beforePunct),
      canClose: rightFlanking && (!leftFlanking || afterPunct),
    };
  }
  // '~': strikethrough opens with a left-flanking run, closes with a
  // right-flanking one.
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

const NUMERIC_REF_RE = /&#([0-9]{1,7}|[xX][0-9a-fA-F]{1,6});/y;
const NAMED_REF_RE = /&[A-Za-z0-9_]+;/y;
const AUTOLINK_URI_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/y;
const AUTOLINK_EMAIL_RE =
  /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/y;

// ---------------------------------------------------------------------------
// Extended autolinks (GFM): www., scheme://, ftp:// and bare emails
// appearing in plain text.
// ---------------------------------------------------------------------------

// The reference trims a would-be URL by repeatedly keeping the
// longest prefix made of plain runs, balanced parenthesis groups,
// ampersands that do not end an entity reference, and punctuation
// runs that are not at the very end.
const BACKPEDAL_RE =
  /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

function backpedal(s) {
  let cur = s;
  for (;;) {
    const m = BACKPEDAL_RE.exec(cur);
    const next = m === null ? '' : m[0];
    if (next === cur) return cur;
    cur = next;
  }
}

function isAlnumChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Email local-part characters: [A-Za-z0-9._+-]
function isEmailLocalChar(ch) {
  return isAlnumChar(ch) || ch === '.' || ch === '_' || ch === '+' || ch === '-';
}

// Email domain characters: [A-Za-z0-9-_]
function isEmailDomainChar(ch) {
  return isAlnumChar(ch) || ch === '-' || ch === '_';
}

// Match an email domain at src[i]: a first label, then one or more
// dot-groups each ending in an alphanumeric, the whole thing not
// followed by a word character or hyphen. Dot-groups are dropped
// from the end when the tail lookahead fails. The match is bounded
// by `limit` (the end of the current text run): the reference
// matches emails inside a single text chunk, so the limit acts as
// the end of the string for the tail lookahead. Returns the end
// index or -1.
function matchEmailDomain(src, i, limit) {
  let j = i;
  while (j < limit && isEmailDomainChar(src[j])) j++;
  if (j === i) return -1;
  const groupEnds = [];
  let p = j;
  while (p < limit && src[p] === '.') {
    let q = p + 1;
    let lastAlnum = -1;
    while (q < limit && isEmailDomainChar(src[q])) {
      if (isAlnumChar(src[q])) lastAlnum = q;
      q++;
    }
    if (lastAlnum === -1) break;
    groupEnds.push(lastAlnum + 1);
    p = lastAlnum + 1;
  }
  for (let k = groupEnds.length; k >= 1; k--) {
    const end = groupEnds[k - 1];
    if (end >= limit || !isEmailDomainChar(src[end])) return end;
  }
  return -1;
}

// Consume a URL body: everything up to whitespace, '<', or the
// given bound (the closing bracket of an enclosing link, whose text
// extent the reference fixes before lexing the text).
function consumeUrlBody(src, i, bound) {
  let j = i;
  while (j < src.length && j < bound && !isSpaceChar(src[j]) && src[j] !== '<') j++;
  return j;
}

// Find the first extended autolink whose start lies in [from, to).
// Matches are computed against the whole source: a URL body may run
// past `to` (it stops only at whitespace or '<').
// Returns {start, end, href, text} or null. getBound supplies the
// bracket bound for URL bodies, computed lazily by the caller.
function findAutolink(src, from, to, getBound, startPrevOk) {
  for (let j = from; j < to; j++) {
    const c = src[j];
    // mailto: / xmpp: followed by an email address (and, for xmpp,
    // an optional /path). The preceding character must not be
    // alphanumeric.
    if (
      (c === 'm' || c === 'x') &&
      (j === 0 || !isAlnumChar(src[j - 1]))
    ) {
      const isMailto = src.startsWith('mailto:', j);
      const isXmpp = !isMailto && src.startsWith('xmpp:', j);
      if (isMailto || isXmpp) {
        let k = j + 7;
        const localStart = k;
        while (k < src.length && isEmailLocalChar(src[k])) k++;
        if (k > localStart && src[k] === '@') {
          let end = matchEmailDomain(src, k + 1, to);
          if (end !== -1) {
            if (
              isXmpp &&
              src[end] === '/' &&
              end + 1 < src.length &&
              /[A-Za-z0-9@.]/.test(src[end + 1])
            ) {
              end++;
              while (end < src.length && /[A-Za-z0-9@.]/.test(src[end])) end++;
            }
            const text = backpedal(src.slice(j, end));
            return { start: j, end: j + text.length, href: text, text, kind: 'mailto' };
          }
        }
      }
    }
    // www. — the preceding character must be the start, whitespace,
    // or one of *_~( (a lookbehind in the reference grammar).
    if (
      c === 'w' &&
      src.startsWith('www.', j) &&
      (j === 0 ||
        isSpaceChar(src[j - 1]) ||
        src[j - 1] === '*' ||
        src[j - 1] === '_' ||
        src[j - 1] === '~' ||
        src[j - 1] === '(')
    ) {
      const body = j + 4;
      if (body < src.length && (isAlnumChar(src[body]) || src[body] === '-')) {
        const text = backpedal(src.slice(j, consumeUrlBody(src, body, getBound(j))));
        return { start: j, end: j + text.length, href: 'http://' + text, text, kind: 'url' };
      }
    }
    // http://, https://, ftp:// — the scheme is case-insensitive and
    // may follow any character.
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      const head = src.slice(j, j + 8).toLowerCase();
      let prefixLen = 0;
      if (head.startsWith('https://')) prefixLen = 8;
      else if (head.startsWith('http://')) prefixLen = 7;
      else if (head.startsWith('ftp://')) prefixLen = 6;
      if (prefixLen > 0) {
        const body = j + prefixLen;
        if (body < src.length && (isAlnumChar(src[body]) || src[body] === '-')) {
          const text = backpedal(src.slice(j, consumeUrlBody(src, body, getBound(j))));
          return { start: j, end: j + text.length, href: text, text, kind: 'url' };
        }
      }
    }
    // Bare email: a local part starting here (the preceding
    // character is not itself a local-part character).
    if (
      isEmailLocalChar(c) &&
      (j === 0 || !isEmailLocalChar(src[j - 1]) || (j === from && startPrevOk))
    ) {
      let k = j;
      while (k < src.length && isEmailLocalChar(src[k])) k++;
      if (src[k] === '@') {
        const end = matchEmailDomain(src, k + 1, to);
        if (end !== -1) {
          const text = src.slice(j, end);
          return { start: j, end, href: 'mailto:' + text, text, kind: 'email' };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The inline scanner
// ---------------------------------------------------------------------------

// The reference lexer's emphasis and strikethrough matchers work on a
// masked copy of the text where certain constructs are blanked out:
// inline link shapes "[label](...)" (with a label grammar of plain
// characters plus code spans) are replaced by "[aaa...]", so delimiter
// runs inside them are invisible to emphasis matching even when the
// construct never becomes a link. Code spans and tags are masked too,
// but those are already single nodes in this scanner; only the link
// shape needs explicit ranges.
function maskCodeSpanEnd(src, j) {
  // A code span as the masker sees it: a backtick run, content that
  // starts and ends with a non-backtick, and a closing run of exactly
  // the same length. Returns the index just past the span, or -1.
  const n = src.length;
  let run = 0;
  while (src[j + run] === '`') run++;
  let k = j + run;
  while (k < n) {
    if (src[k] === '`') {
      let r2 = 0;
      while (src[k + r2] === '`') r2++;
      if (r2 === run && k > j + run) return k + r2;
      k += r2;
    } else {
      k++;
    }
  }
  return -1;
}

function maskLinkShapeEnd(src, i) {
  // Matches the masker's link shape starting at src[i] === '[':
  // a label of plain characters (no brackets or backticks) and code
  // spans, then a parenthesized part whose content may hold escapes
  // and one level of nested parentheses. Returns the end index or -1.
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isPunctChar(src[j + 1])) { j += 2; continue; }
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      const end = maskCodeSpanEnd(src, j);
      if (end === -1) return -1;
      j = end;
      continue;
    }
    j++;
  }
  if (src[j] !== ']') return -1;
  j++;
  if (src[j] !== '(') return -1;
  j++;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') {
      j++;
      while (j < n && src[j] !== ')') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '(') return -1;
        j++;
      }
      if (j >= n) return -1;
      j++;
      continue;
    }
    if (c === ')') return j + 1;
    j++;
  }
  return -1;
}

function computeMaskRanges(src) {
  // The mask only matters when the text can hold both a link shape
  // and delimiter runs; without a '[' there is no link shape, and
  // without delimiters there is nothing to hide.
  if (src.indexOf('[') === -1) return [];
  if (
    src.indexOf('*') === -1 &&
    src.indexOf('_') === -1 &&
    src.indexOf('~') === -1
  ) {
    return [];
  }
  const ranges = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && isPunctChar(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      const end = maskCodeSpanEnd(src, i);
      if (end === -1) {
        // No span starts here; the masker consumes the whole run
        // and moves on.
        while (src[i] === '`') i++;
      } else {
        // A code span is itself a masked region: the masker blanks
        // the backticks inside it before blanking link shapes, so a
        // span whose content contains shorter backtick runs hides
        // the delimiters in between even when the span is not a
        // code span in the final token stream (for example when a
        // link consumes its opening run).
        ranges.push([i, end]);
        i = end;
      }
      continue;
    }
    if (c === '<' && src[i + 1] !== ' ') {
      let j = i + 1;
      while (j < n && src[j] !== '>' && src[j] !== '<') j++;
      i = src[j] === '>' ? j + 1 : i + 1;
      continue;
    }
    if (c === '[') {
      const end = maskLinkShapeEnd(src, i);
      if (end !== -1) {
        ranges.push([i, end]);
        i = end;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

function inMaskRange(ranges, pos) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < ranges[mid][0]) hi = mid - 1;
    else if (pos >= ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function parseInline(src, links, state) {
  const root = makeNode('root');
  const I = {
    src,
    links,
    state,
    root,
    delimStack: [],
    bracketStack: [],
    pending: '',
    masked: computeMaskRanges(src),
  };
  let i = 0;
  const n = src.length;

  const flushText = () => {
    if (I.pending !== '') {
      const t = makeNode('text');
      t.v = I.pending;
      I.pending = '';
      appendNode(root, t);
    }
  };
  I.flushText = flushText;

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\n' && !/^\s*$/.test(src.slice(i + 2))) {
        // A hard break; the reference's break pattern also consumes
        // the indentation of the following line.
        flushText();
        appendNode(root, makeNode('br'));
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else if (next !== undefined && isAsciiPunct(next.charCodeAt(0))) {
        I.pending += next;
        i += 2;
      } else {
        I.pending += '\\';
        i += 1;
      }
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      // Look for a closing run of exactly the same length.
      let j = i + run;
      let closeAt = -1;
      let closeEnd = -1;
      while (j < n) {
        const idx = src.indexOf('`', j);
        if (idx === -1) break;
        let r = 0;
        while (src[idx + r] === '`') r++;
        if (r === run) {
          closeAt = idx;
          closeEnd = idx + r;
          break;
        }
        j = idx + r;
      }
      if (closeAt !== -1 && I.bracketStack.length > 0) {
        // A code span may not swallow the closing bracket of a
        // bracket that forms a link or image: the reference matches
        // the whole link construct at its opening bracket, before
        // any inner scanning. If the innermost open bracket closes
        // inside this span (with no nested opener or escape
        // intervening) and forms a link there, confine the closing
        // run search to the text before that bracket.
        let p = i + run;
        let crossPos = -1;
        while (p < closeAt) {
          if (src[p] === '\\') { p += 2; continue; }
          if (src[p] === '[') break;
          if (src[p] === ']') { crossPos = p; break; }
          p++;
        }
        if (
          crossPos !== -1 &&
          bracketFormsLink(I, I.bracketStack[I.bracketStack.length - 1], crossPos)
        ) {
          closeAt = -1;
          closeEnd = -1;
          let j2 = i + run;
          while (j2 < crossPos) {
            const idx = src.indexOf('`', j2);
            if (idx === -1 || idx >= crossPos) break;
            let r = 0;
            while (src[idx + r] === '`') r++;
            if (r === run) {
              closeAt = idx;
              closeEnd = idx + r;
              break;
            }
            j2 = idx + r;
          }
        }
      }
      if (closeAt === -1) {
        I.pending += '`'.repeat(run);
        i += run;
      } else {
        flushText();
        let content = src.slice(i + run, closeAt).replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content[0] === ' ' &&
          content[content.length - 1] === ' ' &&
          /[^ ]/.test(content)
        ) {
          content = content.slice(1, -1);
        }
        const node = makeNode('code');
        node.v = content;
        appendNode(root, node);
        i = closeEnd;
      }
      continue;
    }

    if (c === '<') {
      const matched = matchAngle(I, i);
      if (matched !== null) {
        i = matched;
        continue;
      }
      I.pending += '<';
      i++;
      continue;
    }

    if (c === '&') {
      NUMERIC_REF_RE.lastIndex = i;
      const num = NUMERIC_REF_RE.exec(src);
      if (num !== null) {
        I.pending += decodeNumericRef(num[1]);
        i = NUMERIC_REF_RE.lastIndex;
        continue;
      }
      NAMED_REF_RE.lastIndex = i;
      const named = NAMED_REF_RE.exec(src);
      if (named !== null) {
        flushText();
        const node = makeNode('ent');
        node.v = named[0];
        appendNode(root, node);
        i = NAMED_REF_RE.lastIndex;
        continue;
      }
      I.pending += '&';
      i++;
      continue;
    }

    if (c === '*' || c === '~' || c === '_') {
      let run = 0;
      while (src[i + run] === c) run++;
      if (c === '~' && run >= 3) {
        // Strikethrough uses runs of one or two tildes only.
        I.pending += src.slice(i, i + run);
        i += run;
        continue;
      }
      if (c === '_' && !underscoreIsStructural(src, i)) {
        // An underscore run that can neither open nor close emphasis
        // is plain text (keeping it whole also keeps emails and
        // identifiers scannable for autolinks).
        I.pending += src.slice(i, i + run);
        i += run;
        continue;
      }
      flushText();
      const node = makeNode('delim');
      node.ch = c;
      node.n = run;
      appendNode(root, node);
      const f = flanking(src, i, run, c);
      I.delimStack.push({
        node, ch: c, n: run, canOpen: f.canOpen, canClose: f.canClose,
        idx: i, origIdx: i, origN: run, shrunk: false,
      });
      i += run;
      continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      flushText();
      const node = makeNode('text');
      node.v = '![';
      appendNode(root, node);
      I.bracketStack.push({ node, isImage: true, active: true, delimLen: I.delimStack.length, contentStart: i + 2, hasLink: false });
      i += 2;
      continue;
    }

    if (c === '[') {
      flushText();
      const node = makeNode('text');
      node.v = '[';
      appendNode(root, node);
      I.bracketStack.push({ node, isImage: false, active: true, delimLen: I.delimStack.length, contentStart: i + 1, hasLink: false });
      i += 1;
      continue;
    }

    if (c === ']') {
      flushText();
      i = closeBracket(I, i);
      continue;
    }

    if (c === '\n') {
      // A hard break when the source line ends with two or more
      // spaces (and something other than whitespace follows).
      let spaces = 0;
      while (src[i - 1 - spaces] === ' ') spaces++;
      if (spaces >= 2 && !/^\s*$/.test(src.slice(i + 1))) {
        I.pending = I.pending.replace(/ +$/, '');
        flushText();
        appendNode(root, makeNode('br'));
        i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else {
        I.pending += '\n';
        i++;
      }
      continue;
    }

    // Plain text run: consume until the next structural character,
    // then let the autolink scan split it further.
    let j = i;
    while (j < n) {
      const ch = src[j];
      if (
        ch === '\\' || ch === '`' || ch === '<' || ch === '&' || ch === ']' ||
        ch === '[' || ch === '*' || ch === '~' || ch === '\n'
      ) {
        break;
      }
      if (ch === '!' && src[j + 1] === '[') break;
      // Only a run-start underscore can be structural; a mid-run one
      // belongs to a run already judged as plain text.
      if (ch === '_' && src[j - 1] !== '_' && underscoreIsStructural(src, j)) break;
      j++;
    }
    i = appendTextWithAutolinks(I, i, j);
  }
  flushText();
  processEmphasis(I, 0);
  reviseEmailAutolinks(I);
  return root;
}

// Email autolinks are matched against the current text run, but the
// reference matches them against a text chunk whose boundaries are
// the emphasis constructs that actually formed. After emphasis is
// resolved: an email directly followed by an underscore run that
// stayed literal text was not an email at all (its domain tail
// check sees the underscores), and an email directly preceded by
// an underscore run that stayed literal includes those underscores
// in its local part.
function reviseEmailAutolinks(I) {
  const leftover = new Map();
  for (const e of I.delimStack) leftover.set(e.node, e);
  if (leftover.size === 0) return;
  const visit = (container) => {
    let n = container.first;
    while (n !== null) {
      const next = n.next;
      if (n.k === 'link' && n.extAutolink && (n.akind === 'email' || n.akind === 'mailto')) {
        if (n.akind === 'email') {
          const prev = n.prev;
          if (prev !== null && prev.k === 'delim' && prev.ch === '_') {
            const e = leftover.get(prev);
            if (e !== undefined && e.origIdx + e.origN === n.srcStart && prev.n > 0) {
              const extra = '_'.repeat(prev.n);
              const t = n.first;
              if (t !== null && t.k === 'text') t.v = extra + t.v;
              n.href = 'mailto:' + extra + n.href.slice('mailto:'.length);
              n.srcStart -= prev.n;
              prev.n = 0;
              detachNode(prev);
            }
          }
        }
        const nxt = n.next;
        if (nxt !== null && nxt.k === 'delim' && nxt.ch === '_') {
          const e = leftover.get(nxt);
          if (e !== undefined && e.idx === n.srcEnd) {
            // Not an email after all: splice the link out, keeping
            // its text child.
            const parent = n.parent;
            const first = n.first;
            const last = n.last;
            const p = n.prev;
            if (first !== null) {
              for (let c = first; c !== null; c = c.next) c.parent = parent;
              first.prev = p;
              last.next = next;
              if (p !== null) p.next = first;
              else parent.first = first;
              if (next !== null) next.prev = last;
              else parent.last = last;
            } else {
              if (p !== null) p.next = next;
              else parent.first = next;
              if (next !== null) next.prev = p;
              else parent.last = p;
            }
            n = next;
            continue;
          }
        }
      }
      if (n.first !== null) visit(n);
      n = next;
    }
  };
  visit(I.root);
}

// An underscore only starts a delimiter run when it could open or close
// emphasis there; intraword underscores are plain text (which also keeps
// email addresses containing them in one text run).
function underscoreIsStructural(src, i) {
  let run = 0;
  while (src[i + run] === '_') run++;
  const f = flanking(src, i, run, '_');
  return f.canOpen || f.canClose;
}

// Append the plain-text run src[from, to) to the output, splitting
// out any extended autolinks. A matched autolink may consume source
// past `to`; returns the index the scanner should resume from.
function appendTextWithAutolinks(I, from, to) {
  const src = I.src;
  if (I.state.inLink || I.state.suppressExt) {
    // Extended autolinks do not form while the reference's inline
    // state is inside a link (a state an unclosed <a> tag leaks
    // across blocks, in document order).
    I.pending += src.slice(from, to);
    return to;
  }
  // Inside an open bracket, a URL body may not cross the bracket's
  // closing ']' (the reference fixes the link text's extent before
  // lexing it); balanced brackets inside the body are fine. The
  // bound is computed lazily, only when a URL candidate is actually
  // found (most text runs contain none).
  let bound = -1;
  const getBound = (urlStart) => {
    if (bound !== -1) return bound;
    bound = src.length;
    if (I.bracketStack.length > 0) {
      // Walk the bracket structure from here: a ']' that would close
      // a bracket already known to contain a link does not bound the
      // URL (that bracket can never form, so its ']' is plain text).
      const open = I.bracketStack.slice();
      for (let k = urlStart; k < src.length; k++) {
        const ch = src[k];
        if (ch === '\\') {
          k++;
        } else if (ch === '[') {
          open.push(null);
        } else if (ch === ']') {
          const b = open.pop();
          if (b === undefined) break;
          if (b === null || !b.hasLink || b.isImage) {
            bound = k;
            break;
          }
        }
      }
    }
    return bound;
  };
  // When this run starts right after a '_' delimiter run that can
  // open emphasis, the reference lexes the run's text as a fresh
  // chunk (the content of the emphasis), so an email at the run's
  // start sees no preceding character.
  let startPrevOk = false;
  if (from > 0 && src[from - 1] === '_') {
    const last = I.delimStack[I.delimStack.length - 1];
    if (
      last !== undefined &&
      last.ch === '_' &&
      last.canOpen &&
      last.origIdx + last.origN === from
    ) {
      startPrevOk = true;
    }
  }
  let pos = from;
  for (;;) {
    // Fast gate: a candidate can only exist in this run if it holds
    // an '@' (emails and mailto:/xmpp: forms), a 'www.' or a '://'
    // (scheme URLs). Plain prose runs skip the scan entirely.
    if (
      pos < to &&
      src.indexOf('@', pos) === -1 &&
      src.indexOf('www.', pos) === -1 &&
      src.indexOf('://', pos) === -1
    ) {
      I.pending += src.slice(pos, to);
      return to;
    }
    const cand = pos < to ? findAutolink(src, pos, to, getBound, startPrevOk) : null;
    if (cand === null) {
      I.pending += src.slice(pos, to);
      return to;
    }
    I.pending += src.slice(pos, cand.start);
    I.flushText();
    const link = makeNode('link');
    link.href = cleanUrl(cand.href);
    link.autolink = true;
    link.extAutolink = true;
    link.akind = cand.kind;
    link.srcStart = cand.start;
    link.srcEnd = cand.end;
    const t = makeNode('text');
    t.v = cand.text;
    t.escFull = true;
    appendNode(link, t);
    appendNode(I.root, link);
    pos = cand.end;
    if (pos > to) return pos;
  }
}

// Handle '<' at src[i]: an autolink, a comment or other raw HTML.
// Returns the index just past the construct, or null for a literal '<'.
function matchAngle(I, i) {
  const src = I.src;
  AUTOLINK_URI_RE.lastIndex = i;
  const uri = AUTOLINK_URI_RE.exec(src);
  if (uri !== null) {
    I.flushText();
    const link = makeNode('link');
    link.href = cleanUrl(uri[1] + ':' + uri[2]);
    link.autolink = true;
    const t = makeNode('text');
    t.v = uri[1] + ':' + uri[2];
    t.escFull = true;
    appendNode(link, t);
    appendNode(I.root, link);
    return AUTOLINK_URI_RE.lastIndex;
  }
  AUTOLINK_EMAIL_RE.lastIndex = i;
  const email = AUTOLINK_EMAIL_RE.exec(src);
  if (email !== null) {
    I.flushText();
    const link = makeNode('link');
    link.href = cleanUrl('mailto:' + email[1]);
    link.autolink = true;
    const t = makeNode('text');
    t.v = email[1];
    t.escFull = true;
    appendNode(link, t);
    appendNode(I.root, link);
    return AUTOLINK_EMAIL_RE.lastIndex;
  }
  let end = -1;
  if (src.startsWith('<!--', i)) {
    // Comments may close abruptly (<!--> or <!--->) or at the first
    // --> after the opener.
    if (src.startsWith('<!-->', i)) end = i + 5;
    else if (src.startsWith('<!--->', i)) end = i + 6;
    else {
      const close = src.indexOf('-->', i + 4);
      if (close !== -1) end = close + 3;
    }
  } else if (src.startsWith('<?', i)) {
    const close = src.indexOf('?>', i + 2);
    if (close !== -1) end = close + 2;
  } else if (src.startsWith('<![CDATA[', i)) {
    const close = src.indexOf(']]>', i + 9);
    if (close !== -1) end = close + 3;
  } else if (/^<![A-Z]/.test(src.slice(i, i + 3))) {
    const close = src.indexOf('>', i + 2);
    if (close !== -1) end = close + 1;
  } else {
    end = scanHtmlTag(src, i);
    if (end !== -1) {
      // An inline HTML token starting with "<a " (a literal space)
      // puts the reference's parser into its in-link state until
      // one starting with "</a>"; the state is not scoped to the
      // current block.
      const head = src.slice(i, i + 4).toLowerCase();
      if (head.startsWith('<a ')) I.state.inLink = true;
      else if (head.startsWith('</a>')) I.state.inLink = false;
    }
  }
  if (end === -1) return null;
  I.flushText();
  const node = makeNode('raw');
  node.v = src.slice(i, end);
  appendNode(I.root, node);
  return end;
}

// The strict label grammar the reference's link pattern uses for
// the bracketed text: a sequence of plain runs (no brackets,
// backslashes or backticks), escapes, bracket groups whose content
// has no unescaped brackets, code spans whose content has no
// backticks, and a final backtick run with no closing run. Anything
// else (a bare ']', a nested '[', a code span containing a
// backtick) means the bracketed text cannot be a link label.
function labelTextOk(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= n) return false;
      i += 2;
    } else if (c === '[') {
      // A bracket group: its content may hold escapes, plain text
      // and one further level of bracket groups (whose own content
      // holds no brackets).
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === ']') {
          closed = true;
          break;
        }
        if (d === '[') {
          let k = j + 1;
          let closed2 = false;
          while (k < n) {
            const e = text[k];
            if (e === '\\') {
              k += 2;
              continue;
            }
            if (e === ']') {
              closed2 = true;
              break;
            }
            if (e === '[') return false;
            k++;
          }
          if (!closed2) return false;
          j = k + 1;
          continue;
        }
        j++;
      }
      if (!closed) return false;
      i = j + 1;
    } else if (c === ']') {
      return false;
    } else if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run++;
      // The next backtick run, if any, is the only possible closing
      // run (the content between the runs holds no backticks).
      let j = i + run;
      let closerEnd = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r = 0;
          while (text[j + r] === '`') r++;
          closerEnd = j + r;
          break;
        }
        j++;
      }
      if (closerEnd === -1) {
        // No closing run: only a run of at least two backticks that
        // ends the text is allowed.
        if (run < 2 || i + run !== n) return false;
        i = n;
      } else {
        i = closerEnd;
      }
    } else {
      i++;
    }
  }
  return true;
}

// Skip whitespace (spaces, tabs, line endings) in an inline context.
function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Try the "(destination title)" form starting just after '('.
// Returns {href, title, end} or null.
function parseInlineLinkTarget(s, i) {
  let j = skipInlineWs(s, i);
  const dest = parseLinkDestination(s, j);
  if (dest === null) return null;
  j = dest.end;
  const wsEnd = skipInlineWs(s, j);
  let title = null;
  if (s[wsEnd] !== ')') {
    if (wsEnd === j) return null;
    const t = parseLinkTitle(s, wsEnd);
    if (t === null) return null;
    title = t.value;
    j = skipInlineWs(s, t.end);
  } else {
    j = wsEnd;
  }
  if (s[j] !== ')') return null;
  return { href: dest.href, title, end: j + 1 };
}

// Handle a ']' at src[i]. Returns the index to continue from.
// Side-effect-free version of the link/image formation decision
// that closeBracket makes at a ']' (position closePos) for the
// given open bracket: an inline target that parses (with a label
// satisfying the strict grammar), a full or collapsed reference
// that resolves, or a shortcut reference that resolves. A bracket
// already known to contain a formed link cannot form one itself.
function bracketFormsLink(I, bracket, closePos) {
  const src = I.src;
  if (!bracket.active || bracket.hasLink) return false;
  const text = src.slice(bracket.contentStart, closePos);
  if (src[closePos + 1] === '(') {
    const target = parseInlineLinkTarget(src, closePos + 2);
    if (target !== null) return labelTextOk(text);
  }
  if (src[closePos + 1] === '[') {
    const labelEnd = scanLabelEnd(src, closePos + 1);
    if (labelEnd !== -1) {
      const rawLabel = src.slice(closePos + 2, labelEnd);
      const label = rawLabel === '' ? text : rawLabel;
      if (!I.links.has(normalizeLabel(label))) return false;
      return rawLabel === '' || labelTextOk(text);
    }
  }
  return I.links.has(normalizeLabel(text));
}

function closeBracket(I, i) {
  const src = I.src;
  const stack = I.bracketStack;
  if (stack.length === 0) {
    I.pending += ']';
    return i + 1;
  }
  const bracket = stack[stack.length - 1];
  if (!bracket.active) {
    stack.pop();
    I.pending += ']';
    return i + 1;
  }

  let href = null;
  let title = null;
  let end = -1;
  // The reference's link pattern matches the bracketed text against
  // a strict label grammar; inline links and full references use
  // it, collapsed and shortcut references use a looser one.
  let strictLabel = false;

  if (src[i + 1] === '(') {
    const target = parseInlineLinkTarget(src, i + 2);
    if (target !== null) {
      href = target.href;
      title = target.title;
      end = target.end;
      strictLabel = true;
    }
  }
  if (end === -1 && src[i + 1] === '[') {
    const labelEnd = scanLabelEnd(src, i + 1);
    if (labelEnd !== -1) {
      const rawLabel = src.slice(i + 2, labelEnd);
      // Reference labels match on the raw source text (escapes are
      // not resolved); a collapsed reference uses the bracketed
      // source itself.
      const label = rawLabel === '' ? src.slice(bracket.contentStart, i) : rawLabel;
      const found = I.links.get(normalizeLabel(label));
      if (found !== undefined) {
        href = found.href;
        title = found.title;
        end = labelEnd + 1;
        strictLabel = rawLabel !== '';
      } else {
        // A full or collapsed reference with no matching definition
        // is not a link at all.
        stack.pop();
        I.pending += ']';
        return i + 1;
      }
    }
  }
  if (end === -1) {
    // Shortcut reference: the bracketed source itself is the label.
    const label = src.slice(bracket.contentStart, i);
    const found = I.links.get(normalizeLabel(label));
    if (found !== undefined) {
      href = found.href;
      title = found.title;
      end = i + 1;
    }
  }
  if (end === -1) {
    stack.pop();
    I.pending += ']';
    return i + 1;
  }
  if (strictLabel && !labelTextOk(src.slice(bracket.contentStart, i))) {
    stack.pop();
    I.pending += ']';
    return i + 1;
  }

  // Form the link or image: first settle emphasis inside it, then move
  // the content nodes under the new node. The text is judged against
  // its own mask, as the reference lexes it as a separate string.
  I.passMask = computeMaskRanges(src.slice(bracket.contentStart, i));
  I.passMaskBase = bracket.contentStart;
  processEmphasis(I, bracket.delimLen, bracket);
  I.passMask = null;
  I.delimStack.length = bracket.delimLen;
  if (!bracket.isImage) {
    // A link whose content itself contains a link is not formed (the
    // reference tracks links emitted while lexing the content and
    // rejects the outer one). Images are exempt, and autolinks do
    // not count: they are unwrapped back to plain text below.
    let nested = false;
    const scan = (node) => {
      for (let n = node; n !== null && !nested; n = n.next) {
        if (n.k === 'link' && !n.autolink) nested = true;
        else if (n.first !== null) scan(n.first);
      }
    };
    scan(bracket.node.next);
    if (nested) {
      stack.pop();
      I.pending += ']';
      return i + 1;
    }
    unwrapAutolinksFrom(I, bracket.node.next);
  }
  stack.pop();
  if (!bracket.isImage) {
    // The new link sits inside every bracket still open, so none of
    // them can form a link anymore (the nested-link rule); their
    // closing brackets are not text boundaries for autolinks.
    for (const b of stack) b.hasLink = true;
  }
  const link = makeNode(bracket.isImage ? 'img' : 'link');
  link.href = cleanUrl(href);
  link.title = title;
  let cur = bracket.node.next;
  while (cur !== null) {
    const nxt = cur.next;
    detachNode(cur);
    appendNode(link, cur);
    cur = nxt;
  }
  detachNode(bracket.node);
  appendNode(I.root, link);
  if (!bracket.isImage) {
    // Links cannot contain links: earlier link openers are
    // deactivated (image openers are not affected).
    for (const b of stack) if (!b.isImage) b.active = false;
  }
  return end;
}

// Extended (bare) autolinks do not form inside link text: the
// reference lexes link text with autolinking off, so emphasis and
// other inline constructs inside what looked like a URL still
// apply. Replace every extended autolink node in the sibling chain
// starting at `start` (recursively) with a fresh inline parse of
// its text under that rule. Angle-bracket autolinks do form inside
// links and stay.
function unwrapAutolinksFrom(I, start) {
  let n = start;
  while (n !== null) {
    if (n.k === 'link' && n.extAutolink) {
      const parent = n.parent;
      const prev = n.prev;
      const next = n.next;
      const textNode = n.first;
      const text = textNode !== null && textNode.k === 'text' ? textNode.v : '';
      const wasSuppressed = I.state.suppressExt;
      I.state.suppressExt = true;
      const sub = parseInline(text, I.links, I.state);
      I.state.suppressExt = wasSuppressed;
      const subFirst = sub.first;
      const subLast = sub.last;
      if (subFirst !== null) {
        for (let c = subFirst; c !== null; c = c.next) c.parent = parent;
        subFirst.prev = prev;
        subLast.next = next;
        if (prev !== null) prev.next = subFirst;
        else parent.first = subFirst;
        if (next !== null) next.prev = subLast;
        else parent.last = subLast;
      } else {
        if (prev !== null) prev.next = next;
        else parent.first = next;
        if (next !== null) next.prev = prev;
        else parent.last = prev;
      }
      n = next;
      continue;
    }
    if (n.first !== null) unwrapAutolinksFrom(I, n.first);
    n = n.next;
  }
}

// The reference renderer percent-encodes parts of link destinations
// (spaces and non-ASCII become %XX sequences); existing % signs are
// left alone.
function cleanUrl(href) {
  if (href === null) return null;
  // Fast path: a destination made only of characters encodeURI
  // keeps (printable ASCII outside the set it escapes) and with no
  // '%' (whose %25 form the reference un-escapes) is unchanged.
  let simple = true;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (
      c < 33 || c > 126 || c === 34 || c === 37 || c === 60 || c === 62 ||
      c === 91 || c === 92 || c === 93 || c === 94 || c === 96 ||
      c === 123 || c === 124 || c === 125
    ) {
      simple = false;
      break;
    }
  }
  if (simple) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInlineNodes(container) {
  let out = '';
  for (let n = container.first; n !== null; n = n.next) out += renderInlineNode(n);
  return out;
}

function renderInlineNode(node) {
  switch (node.k) {
    case 'text':
      return escapeFull(node.v);
    case 'ent':
      return node.v;
    case 'raw':
      return node.v;
    case 'code':
      return '<code>' + escapeFull(node.v) + '</code>';
    case 'br':
      return '<br>';
    case 'delim':
      return node.ch.repeat(node.n);
    case 'em':
      return '<em>' + renderInlineNodes(node) + '</em>';
    case 'strong':
      return '<strong>' + renderInlineNodes(node) + '</strong>';
    case 'del':
      return '<del>' + renderInlineNodes(node) + '</del>';
    case 'link': {
      const href = node.autolink ? escapeFull(node.href) : escapeText(node.href);
      let out = '<a href="' + href + '"';
      if (node.title !== null && node.title !== '') out += ' title="' + escapeText(node.title) + '"';
      return out + '>' + renderInlineNodes(node) + '</a>';
    }
    case 'img': {
      let out =
        '<img src="' + escapeText(node.href) + '" alt="' +
        escapeText(textOfRange(node.first, node.last)) + '"';
      if (node.title !== null && node.title !== '') out += ' title="' + escapeText(node.title) + '"';
      return out + '>';
    }
    default:
      return '';
  }
}

function renderChildren(block, links, tight, state) {
  let out = '';
  for (const child of block.children) out += renderBlock(child, links, tight, state);
  return out;
}

function renderBlock(block, links, tight, state) {
  switch (block.type) {
    case 'document':
      return renderChildren(block, links, false, state);
    case 'blockquote':
      return '<blockquote>\n' + renderChildren(block, links, false, state) + '</blockquote>\n';
    case 'heading':
      return (
        '<h' + block.level + '>' +
        renderInlineNodes(parseInline(block.text, links, state)) +
        '</h' + block.level + '>\n'
      );
    case 'paragraph': {
      if (block.defOnly) return '';
      const inner = renderInlineNodes(parseInline(block.text, links, state));
      return tight ? inner : '<p>' + inner + '</p>\n';
    }
    case 'code': {
      let lang = '';
      if (block.fenced && block.info !== '') lang = block.info.split(/\s+/)[0];
      // Code text is rendered with exactly one trailing newline.
      let text = block.text;
      if (text !== '') text = text.replace(/\n$/, '') + '\n';
      return (
        '<pre><code' +
        (lang !== '' ? ' class="language-' + escapeText(lang) + '"' : '') +
        '>' + escapeFull(text) + '</code></pre>\n'
      );
    }
    case 'html':
      return block.text;
    case 'hr':
      return '<hr>\n';
    case 'list': {
      const open =
        block.listKind === 'ordered'
          ? block.start !== 1
            ? '<ol start="' + block.start + '">\n'
            : '<ol>\n'
          : '<ul>\n';
      const close = block.listKind === 'ordered' ? '</ol>\n' : '</ul>\n';
      return open + renderChildren(block, links, false, state) + close;
    }
    case 'item':
      return renderItem(block, links, state);
    case 'table':
      return renderTable(block, links, state);
    default:
      return '';
  }
}

const TASK_STRIP_RE = /^\[[ xX]\][ \t]+/;
function renderItem(item, links, state) {
  const list = item.parent;
  const tight = list !== null && list.type === 'list' ? list.tight : false;
  let inner = '';
  for (let idx = 0; idx < item.children.length; idx++) {
    const child = item.children[idx];
    if (
      idx === 0 &&
      item.task &&
      child.type === 'paragraph' &&
      TASK_STRIP_RE.test(child.text)
    ) {
      // The marker and all whitespace after it are replaced by the
      // checkbox, which renders with a single trailing space.
      const checkbox =
        (item.checked
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">') + ' ';
      const saved = child.text;
      child.text = saved.replace(TASK_STRIP_RE, '');
      if (tight) {
        inner += checkbox + renderBlock(child, links, true, state);
      } else {
        inner += '<p>' + checkbox + renderInlineNodes(parseInline(child.text, links, state)) + '</p>\n';
      }
      child.text = saved;
      continue;
    }
    inner += renderBlock(child, links, tight, state);
  }
  return '<li>' + inner + '</li>\n';
}

function alignAttr(align) {
  return align ? ' align="' + align + '"' : '';
}

function renderTable(block, links, state) {
  const cols = block.header.length;
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < cols; i++) {
    out +=
      '<th' + alignAttr(block.aligns[i]) + '>' +
      renderInlineNodes(parseInline(block.header[i], links, state)) +
      '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (block.rows.length > 0) {
    out += '<tbody>';
    for (const row of block.rows) {
      out += '<tr>\n';
      for (let i = 0; i < cols; i++) {
        out +=
          '<td' + alignAttr(block.aligns[i]) + '>' +
          renderInlineNodes(parseInline(row[i] === undefined ? '' : row[i], links, state)) +
          '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const doc = newBlock('document');
  const P = {
    doc,
    tip: doc,
    links: new Map(),
    line: '',
    pos: 0,
    col: 0,
    firstNonspace: 0,
    firstNonspaceCol: 0,
    indent: 0,
    blank: false,
    lineIndex: 0,
    totalLines: 0,
    allLines: [],
    endsWithNewline: false,
    nonTop: false,
    lineLazyQuote: false,
    defuseLine: false,
    trackSpans: false,
    eofFinalize: false,
  };
  parseBlocks(P, src);
  return renderBlock(doc, P.links, false, { inLink: false });
}
