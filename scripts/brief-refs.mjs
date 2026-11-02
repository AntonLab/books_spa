/**
 * Counts `git grep` hits for the names and paths a brief mentions.
 * A name with 0 hits is not wrong by itself ("X is absent" is a valid
 * claim); it is the line the writer has to look at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import {
  extractTokens,
  isSuffixOf,
  runGit,
  trackedFiles,
} from './doc-refs.mjs';

const FILE_NAME = /\.(ts|tsx|mjs|md|json)$/;

// Matching lines in tracked files, or tracked paths ending in the token.
const countHits = (root, token, files, briefPath) => {
  if (FILE_NAME.test(token)) {
    const slashed = token.replaceAll('\\', '/');
    return files.filter((file) => isSuffixOf(file, slashed)).length;
  }
  // A tracked brief would count its own tokens, so leave it out.
  const rel = relative(root, briefPath).replaceAll('\\', '/');
  const own =
    rel.startsWith('..') || isAbsolute(rel) ? [] : [`:(exclude)${rel}`];
  // grep exits 1 on no match
  return runGit(
    root,
    ['grep', '-F', '-c', '-e', token, '--', '.', ...own],
    [0, 1]
  )
    .split('\n')
    .filter(Boolean)
    .reduce((sum, row) => sum + Number(row.slice(row.lastIndexOf(':') + 1)), 0);
};

export const checkBrief = ({ root, briefPath }) => {
  if (!existsSync(briefPath)) {
    console.error(`brief-check: brief not found: ${briefPath}`);
    process.exit(2);
  }
  const files = trackedFiles(root);
  const cache = new Map();
  const text = readFileSync(briefPath, 'utf8');
  return extractTokens(text).map(({ line, token }) => {
    if (!cache.has(token))
      cache.set(token, countHits(root, token, files, briefPath));
    return { line, token, hits: cache.get(token) };
  });
};
