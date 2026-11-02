/**
 * Prints the git grep hit count of each backticked name in a brief; exits 1
 * on a 0. Usage: node scripts/brief-check.mjs <brief.md>
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
if (zero.length)
  console.error(`brief-check: ${zero.length} name(s) with 0 hits, check each`);
process.exitCode = zero.length ? 1 : 0;
