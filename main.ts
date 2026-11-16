// markswift driver.
//
// The harness runs `node /bot/main.ts`. The program reads every case from
// cases.json in the input directory (an array of {"id", "markdown"}), renders
// each case on its own with parse() from ./parse.js, and writes html.json to
// the output directory: a JSON array with one HTML string per case, in the
// cases' order. MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override the
// /input and /output defaults so the same program can run outside the box.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Warm-up: a graded run is a fresh process, so the interpreter reaches the
// large documents with cold, uncompiled hot paths. Rendering a few small
// synthetic documents first (their results are thrown away) lets the JIT
// settle before the real cases start. The samples below are written for this
// driver; they only exercise the same code paths the real cases will.
const warmSamples: string[] = [
  '# Warm up\n\nA paragraph with *emphasis*, **strong text**, `code`, ' +
    'a [link](https://example.com "title") and ~~struck~~ words.\n',
  '- one\n- two\n  - nested\n\n1. first\n2. second\n\n> a quote\n> with lines\n',
  '| a | b |\n| :- | -: |\n| 1 | 2 |\n\n```txt\nfenced code\n```\n\n    indented code\n',
  'Text with an autolink www.example.com and someone@example.com, ' +
    'entities &copy; &#35;, escapes \\* and a hard break.  \nNext line.\n',
];
for (let round = 0; round < 12; round++) {
  for (const sample of warmSamples) parse(sample);
}

interface Case {
  id: string;
  markdown: string;
}

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const rendered: string[] = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
