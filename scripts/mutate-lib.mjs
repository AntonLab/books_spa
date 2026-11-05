/**
 * Core of the mutation script: replaces one exact string in one tracked file,
 * runs a command, reports whether the command caught the change, and restores
 * the file.
 *
 * Refuses (`Refusal`, CLI exit 1) a path outside the repo or under
 * `DISALLOWED`, an untracked or dirty file (a restore would destroy its
 * edits), a file that resolves outside the repo or is not valid UTF-8, and a
 * `from` found 0 or 2+ times. An empty `from` is a `UsageError`
 * (CLI exit 2). The file is written as utf8 with no newline normalisation, so
 * CRLF bytes survive.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class Refusal extends Error {}
export class UsageError extends Error {}

const DISALLOWED = ['.git', 'node_modules', '.claude', 'docs/superpowers'];

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

// True when `rel` (from `pathApi.relative`) names `..`, climbs out, or is absolute.
const isOutside = (rel, pathApi) =>
  rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel);

export const repoRelative = (root, file, pathApi = path) => {
  const abs = pathApi.resolve(root, file);
  const rel = pathApi.relative(root, abs);
  if (rel === '' || isOutside(rel, pathApi))
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

const restoreOrExplain = (root, rel) => {
  try {
    restore(root, rel);
  } catch (cause) {
    throw new Error(`${rel} left mutated: run git checkout -- ${rel}`, {
      cause,
    });
  }
};

const run = (command, cwd) => {
  const child = spawn(command, { shell: true, cwd });
  // With `shell: true` the child is the shell; on Windows its tree needs taskkill.
  const kill = () => {
    // taskkill goes first: once the shell is dead its children are orphaned.
    if (process.platform === 'win32' && child.pid !== undefined)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    child.kill();
  };
  const done = new Promise((resolve) => {
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (err) => resolve({ exitCode: 1, output: String(err) }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
  return { kill, done };
};

const lf = (s) => s.replace(/\r\n/g, '\n');

const numberAfter = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
};

const names = (text, re, skip) => [
  ...new Set(
    [...text.matchAll(re)].map((m) => m[1]).filter((name) => name !== skip)
  ),
];

export const parseReport = (output) => {
  const text = lf(output);
  const pass = numberAfter(text, /^(?:#|ℹ) pass (\d+)/m);
  const fail = numberAfter(text, /^(?:#|ℹ) fail (\d+)/m);
  if (pass !== null && fail !== null)
    return {
      failed: names(
        text,
        /^[ \t]*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm,
        'failing tests:'
      ),
      pass,
      fail,
    };
  const summary = text.match(/^Tests:.*$/m);
  if (!summary) return null;
  return {
    failed: names(text, /^[ \t]*✕ (.+?)(?: \(\d+ ms\))?$/gm),
    pass: numberAfter(summary[0], /(\d+) passed/) ?? 0,
    fail: numberAfter(summary[0], /(\d+) failed/) ?? 0,
  };
};

export const formatResult = ({ verdict, output }) => {
  const report = parseReport(output);
  if (!report) {
    const tail = lf(output).trimEnd();
    return tail === ''
      ? verdict
      : [verdict, ...tail.split('\n').slice(-20)].join('\n');
  }
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
  if (isOutside(path.relative(realpathSync(root), realpathSync(abs)), path))
    throw new Refusal(`${rel} resolves outside the repo`);
  const buf = readFileSync(abs);
  const text = buf.toString('utf8');
  if (!Buffer.from(text).equals(buf))
    throw new Refusal(`${rel} is not valid UTF-8`);
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
    const { kill, done } = run(command, root);
    try {
      onApplied?.({ restore: () => restoreOrExplain(root, rel), kill });
    } catch (error) {
      kill();
      throw error;
    }
    const { exitCode, output } = await done;
    return {
      verdict: exitCode === 0 ? 'SURVIVED' : 'KILLED',
      exitCode,
      output,
    };
  } finally {
    restoreOrExplain(root, rel);
  }
};
