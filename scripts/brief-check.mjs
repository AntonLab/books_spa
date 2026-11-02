/**
 * Usage: node scripts/brief-check.mjs <brief.md>
 * Exit codes: 1 on a 0-hit name, 2 on a missing argument.
 */
import { resolve } from 'node:path';
import { checkBrief } from './brief-refs.mjs';

const root = resolve(import.meta.dirname, '..');
const briefPath = process.argv[2];
if (!briefPath) {
  console.error('usage: node scripts/brief-check.mjs <brief.md>');
  process.exit(2);
}

const rows = checkBrief({ root, briefPath: resolve(briefPath) });
for (const { line, token, hits } of rows)
  console.log(`${briefPath}:${line} ${token} hits=${hits}`);
const zero = rows.filter((row) => row.hits === 0);
if (zero.length) {
  console.error(`brief-check: ${zero.length} name(s) with 0 hits, check each`);
  process.exitCode = 1;
}
