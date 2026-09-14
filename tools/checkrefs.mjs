/**
 * Reference check — run with `npm run checkrefs`.
 *
 * There is no bundler in this project, so a mistyped import path or a renamed DOM id is
 * a *silent* runtime failure: the page just stops working with nothing to point at.
 * This script closes that gap without adding a build step.
 *
 * It checks that
 *   1. every relative import in js/ resolves to a file that exists
 *   2. every `getElementById('…')` / `$('…')` id exists in index.html
 *   3. every src/href referenced by index.html exists on disk
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = resolve('.');
const jsRoot = join(root, 'js');

/** Strip comments and string literals so example code cannot produce false positives. */
function stripNonCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      // Keep the literal itself (imports live in them) but skip over its contents.
      out += ch;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        if (source[i] === ch) break;
        i++;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js')) files.push(path);
  }
})(jsRoot);

const html = readFileSync(join(root, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const problems = [];
const rel = (p) => p.replace(root, '').replace(/\\/g, '/');

for (const file of files) {
  const code = stripNonCode(readFileSync(file, 'utf8'));

  for (const m of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(resolve(dirname(file), m[1]))) {
      problems.push(`broken import   ${rel(file)}  ->  ${m[1]}`);
    }
  }

  const ids = [
    ...[...code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  for (const id of ids) {
    if (!htmlIds.has(id)) problems.push(`missing element ${rel(file)}  ->  #${id}`);
  }
}

for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:|#|data:)/.test(m[1])) continue;
  if (!existsSync(join(root, m[1]))) problems.push(`missing asset   index.html  ->  ${m[1]}`);
}

console.log(`${files.length} JS modules checked · ${htmlIds.size} ids in index.html`);
for (const problem of problems) console.log(`  \u2717 ${problem}`);
console.log(problems.length === 0 ? 'Reference check passed.' : `${problems.length} problem(s) found.`);
process.exitCode = problems.length === 0 ? 0 : 1;
