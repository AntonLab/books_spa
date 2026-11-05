/**
 * Core of the mutation script: replaces one exact string in one tracked file,
 * runs a command, reports whether the command caught the change, and restores
 * the file with `git checkout`.
 *
 * Refuses (`Refusal`, CLI exit 1) a path outside the repo or under `.git`,
 * `node_modules`, `.claude` or `docs/superpowers`, an untracked or dirty file
 * (a restore would destroy its edits), and a `from` found zero or several
 * times. An empty `from` is a `UsageError` (CLI exit 2). The file is written
 * as utf8 with no newline normalisation, so CRLF files keep their bytes.
 *
 * Verdict: `KILLED` when the command fails (the change was caught),
 * `SURVIVED` when it exits 0.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class Refusal extends Error {}
export class UsageError extends Error {}

const DISALLOWED = ['.git', 'node_modules', '.claude', 'docs/superpowers'];

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

export const repoRelative = (root, file, pathApi = path) => {
  const abs = pathApi.resolve(root, file);
  const rel = pathApi.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || pathApi.isAbsolute(rel))
    throw new Refusal(`${file} is outside the repo`);
  const posix = rel.split(pathApi.sep).join('/');
  const lower = `${posix.toLowerCase()}/`;
  if (DISALLOWED.some((dir) => lower.startsWith(`${dir}/`)))
    throw new Refusal(`${posix} is under a disallowed directory`);
  return posix;
};

export const countOccurrences = (text, from) => {
  let count = 0;
  for (let i = text.indexOf(from); i !== -1; i = text.indexOf(from, i + 1))
    count++;
  return count;
};

export const restore = (root, rel) => {
  git(root, 'checkout', '--', rel);
};

const run = (command, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (err) => resolve({ exitCode: 1, output: String(err) }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });

const count = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
};

const names = (text, re, skip) => [
  ...new Set(
    [...text.matchAll(re)].map((m) => m[1]).filter((name) => name !== skip)
  ),
];

export const parseReport = (output) => {
  const text = output.replace(/\r\n/g, '\n');
  const pass = count(text, /^(?:#|ℹ) pass (\d+)/m);
  const fail = count(text, /^(?:#|ℹ) fail (\d+)/m);
  if (pass !== null && fail !== null)
    return {
      failed: names(
        text,
        /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm,
        'failing tests:'
      ),
      pass,
      fail,
    };
  const summary = text.match(/^Tests:.*$/m);
  if (!summary) return null;
  return {
    failed: names(text, /^\s*✕ (.+?)(?: \(\d+ ms\))?$/gm),
    pass: count(summary[0], /(\d+) passed/) ?? 0,
    fail: count(summary[0], /(\d+) failed/) ?? 0,
  };
};

export const formatResult = ({ verdict, output }) => {
  const report = parseReport(output);
  if (!report)
    return [
      verdict,
      ...output.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-20),
    ].join('\n');
  return [
    verdict,
    ...(report.failed.length
      ? ['failing tests:', ...report.failed.map((n) => `  - ${n}`)]
      : []),
    `pass ${report.pass}, fail ${report.fail}`,
  ].join('\n');
};

export const mutate = async ({ root, file, from, to, command, onApplied }) => {
  if (from === '') throw new UsageError('from must not be empty');
  const rel = repoRelative(root, file);
  try {
    git(root, 'ls-files', '--error-unmatch', '--', rel);
  } catch {
    throw new Refusal(`${rel} is not tracked`);
  }
  if (git(root, 'status', '--porcelain', '--', rel).trim() !== '')
    throw new Refusal(`${rel} is dirty: commit or stash it first`);
  const abs = path.join(root, rel);
  const text = readFileSync(abs, 'utf8');
  const count = countOccurrences(text, from);
  if (count !== 1)
    throw new Refusal(
      `found ${count} occurrences of ${JSON.stringify(from)} in ${rel}, need exactly 1`
    );

  writeFileSync(
    abs,
    text.replace(from, () => to),
    'utf8'
  );
  try {
    onApplied?.(() => restore(root, rel));
    const { exitCode, output } = await run(command, root);
    return {
      verdict: exitCode === 0 ? 'SURVIVED' : 'KILLED',
      exitCode,
      output,
    };
  } finally {
    restore(root, rel);
  }
};
