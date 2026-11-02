/**
 * A name with 0 hits is not wrong by itself ("X is absent" is a valid
 * claim); it is the line the writer has to look at.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { extractTokens } from './doc-refs.mjs';

const FILE_NAME = /\.(ts|tsx|mjs|md|json)$/;

const git = (root, args) => {
  const { status, stdout, stderr, error } = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (status !== 0 && status !== 1)
    throw new Error(`git ${args[0]} failed: ${error?.message ?? stderr}`);
  return stdout;
};

// Matching lines in tracked files, or tracked paths ending in the token.
const countHits = (root, token, files, briefPath) => {
  if (FILE_NAME.test(token)) {
    return files.filter((file) => file === token || file.endsWith(`/${token}`))
      .length;
  }
  // A tracked brief would count its own tokens, so leave it out.
  const rel = relative(root, briefPath).replaceAll('\\', '/');
  const own =
    rel.startsWith('..') || isAbsolute(rel) ? [] : [`:(exclude)${rel}`];
  return git(root, ['grep', '-F', '-c', '-e', token, '--', '.', ...own])
    .split('\n')
    .filter(Boolean)
    .reduce((sum, row) => sum + Number(row.slice(row.lastIndexOf(':') + 1)), 0);
};

export const checkBrief = ({ root, briefPath }) => {
  const files = git(root, ['ls-files', '-z']).split('\0');
  const cache = new Map();
  const text = readFileSync(briefPath, 'utf8');
  return extractTokens(text).map(({ line, token }) => {
    if (!cache.has(token))
      cache.set(token, countHits(root, token, files, briefPath));
    return { line, token, hits: cache.get(token) };
  });
};
