# markswift
[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/txwhoyy/markswift/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/txwhoyy/markswift/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

markswift is a from-scratch Markdown renderer whose output is byte-for-byte
identical to `marked` 18.1.3 with default options (GFM on, breaks off,
pedantic off) — the CommonMark and GFM spec suites plus long generated
documents — while running the document set substantially faster than the
reference implementation itself.

## Design

`parse.js` is a single dependency-free ES module with no imports, split into
a block phase and an inline phase, both written as hand-rolled scanners over
the source string (index-based, `indexOf`-driven) instead of stacked regex
passes:

- **Block phase.** The input is split into lines once and walked with a
  cursor that tracks position and column. Open blocks form a tree
  (document, block quotes, list items, and leaf blocks). Each line first
  descends through the open containers — matching quote markers, gathering
  list-item lines, absorbing lazy paragraph continuations — then dispatches
  new block starts by the line's first significant character: indented code,
  fences, ATX and setext headings, thematic breaks, block quotes, lists,
  HTML blocks, link reference definitions, GFM tables, and paragraphs.
  List items gather their content lines and are lexed as their own block
  stream when they close, which makes tight/loose determination a local
  property of the gathered lines. Link definitions are collected wherever
  they legally appear (including inside paragraph text) and stripped before
  rendering.
- **Inline phase.** A single left-to-right scanner builds a linked list of
  nodes (text, code spans, raw HTML, entities, autolinks, delimiter runs,
  bracket openers). Code spans, HTML tags, and angle autolinks are consumed
  atomically. Emphasis and strikethrough are resolved by an opener-driven
  matcher that mirrors the reference's delimiter classification (flanking
  classes, the rule of three, run shortening with excess characters folded
  back into the content), including the reference's masking step: link-shaped
  spans `[label](...)` and code spans are computed up front as masked ranges
  whose interior delimiters do not participate in emphasis matching. Link
  text is settled as its own range when its closing bracket is reached, with
  its own mask, and extended (bare) autolinks inside link text are
  re-lexed with autolinking off, as the reference does. GFM extended
  autolinks are recognized inside plain text runs with the reference's
  backpedalling trim, and email autolinks get the reference's
  chunk-boundary treatment around delimiter runs.
- **Rendering** walks the block tree and the inline node lists once,
  appending to plain strings; escaping distinguishes the contexts the
  reference distinguishes (text, code, attribute values with entity-aware
  escaping, and percent-encoding of destinations).

## Speed notes

- Plain text — the bulk of real documents — is copied in long runs located
  with direct character checks; per-character work only happens at
  structural characters.
- Paragraph-interruption checks are gated so a plain paragraph line costs a
  couple of comparisons, not a battery of matchers.
- Block dispatch keys off the first character of the line's content before
  any expensive matcher runs.
- The driver (`main.ts`) renders a handful of small synthetic documents
  (written into the driver, results discarded) before the real cases, so a
  cold process reaches the large documents with its hot paths already
  compiled; on a cold single-pass run this more than pays for itself.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

The driver reads `cases.json` (an array of `{"id", "markdown"}`) from the
input directory and writes `html.json` — a JSON array of the rendered HTML
strings, in case order — to the output directory.

---
<sub>Entered on [make.fun](https://make.fun/?ref=1paa8b6t&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
