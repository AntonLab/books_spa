import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test } from 'node:test';
import {
  Refusal,
  UsageError,
  countOccurrences,
  formatResult,
  mutate,
  parseReport,
  repoRelative,
} from '../mutate-lib.mjs';

const git = (root, ...args) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();

// A git repo with a tracked a.txt and a check.mjs that passes while a.txt has "alpha".
const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'a.txt'), 'alpha beta\n');
  writeFileSync(
    join(root, 'check.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      "process.exit(readFileSync('a.txt', 'utf8').includes('alpha') ? 0 : 1);\n"
  );
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'init'
  );
  return root;
};

test('repoRelative gives a posix relative path for posix and win32 roots', () => {
  assert.equal(repoRelative('/r', 'src/a.js', path.posix), 'src/a.js');
  assert.equal(repoRelative('C:\\r', 'src\\a.js', path.win32), 'src/a.js');
});

test('repoRelative refuses outside and disallowed paths for both separators', () => {
  for (const [root, file, api] of [
    ['/r', '../x', path.posix],
    ['/r', '/etc/passwd', path.posix],
    ['/r', '.git/config', path.posix],
    ['/r', 'node_modules/m/i.js', path.posix],
    ['/r', '.claude/rules/a.md', path.posix],
    ['/r', 'docs/superpowers/p.md', path.posix],
    ['C:\\r', '..\\x', path.win32],
    ['C:\\r', 'D:\\x', path.win32],
    ['C:\\r', '.claude\\rules\\a.md', path.win32],
    ['C:\\r', 'docs\\superpowers\\p.md', path.win32],
    ['C:\\r', 'NODE_MODULES\\m', path.win32],
  ])
    assert.throws(() => repoRelative(root, file, api), Refusal, `${file}`);
  assert.equal(
    repoRelative('/r', 'docs/superpowers-x/a.md', path.posix),
    'docs/superpowers-x/a.md'
  );
});

test('countOccurrences counts overlapping matches', () => {
  assert.equal(countOccurrences('aaa', 'aa'), 2);
  assert.equal(countOccurrences('abc', 'd'), 0);
  assert.equal(countOccurrences('abc', 'b'), 1);
});

test('mutate KILLED: replaces during the run, restores after', async (t) => {
  const root = sandbox(t);
  const r = await mutate({
    root,
    file: 'a.txt',
    from: 'alpha',
    to: 'omega',
    command: 'node check.mjs',
  });
  assert.equal(r.verdict, 'KILLED');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha beta\n');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('mutate SURVIVED when the command still passes', async (t) => {
  const root = sandbox(t);
  const r = await mutate({
    root,
    file: 'a.txt',
    from: 'beta',
    to: 'gamma',
    command: 'node check.mjs',
  });
  assert.equal(r.verdict, 'SURVIVED');
  assert.equal(r.exitCode, 0);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('mutate restores after a command that crashes', async (t) => {
  const root = sandbox(t);
  const r = await mutate({
    root,
    file: 'a.txt',
    from: 'alpha',
    to: 'omega',
    command: 'node nonexistent.mjs',
  });
  assert.equal(r.verdict, 'KILLED');
  assert.notEqual(r.exitCode, 0);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha beta\n');
});

test('mutate refuses zero and ambiguous matches with the count', async (t) => {
  const root = sandbox(t);
  await assert.rejects(
    mutate({
      root,
      file: 'a.txt',
      from: 'zzz',
      to: 'y',
      command: 'node check.mjs',
    }),
    /0 occurrences/
  );
  writeFileSync(join(root, 'a.txt'), 'alpha alpha\n');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qam',
    'two'
  );
  await assert.rejects(
    mutate({
      root,
      file: 'a.txt',
      from: 'alpha',
      to: 'y',
      command: 'node check.mjs',
    }),
    /2 occurrences/
  );
});

test('mutate refuses a dirty file before any edit', async (t) => {
  const root = sandbox(t);
  writeFileSync(join(root, 'a.txt'), 'alpha dirty\n');
  await assert.rejects(
    mutate({
      root,
      file: 'a.txt',
      from: 'alpha',
      to: 'o',
      command: 'node check.mjs',
    }),
    /dirty/
  );
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha dirty\n');
});

test('mutate refuses untracked, disallowed and outside paths', async (t) => {
  const root = sandbox(t);
  writeFileSync(join(root, 'u.txt'), 'alpha\n');
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'x.txt'), 'alpha\n');
  git(root, 'add', '-f', '.claude/x.txt');
  for (const file of ['u.txt', '.claude/x.txt', '../a.txt'])
    await assert.rejects(
      mutate({ root, file, from: 'alpha', to: 'o', command: 'node check.mjs' }),
      Refusal,
      file
    );
});

test('mutate rejects an empty from as a UsageError', async (t) => {
  const root = sandbox(t);
  await assert.rejects(
    mutate({
      root,
      file: 'a.txt',
      from: '',
      to: 'x',
      command: 'node check.mjs',
    }),
    UsageError
  );
});

test('mutate keeps CRLF bytes and handles an empty to', async (t) => {
  const root = sandbox(t);
  writeFileSync(join(root, 'a.txt'), 'alpha\r\nbeta\r\n');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qam',
    'crlf'
  );
  const r = await mutate({
    root,
    file: 'a.txt',
    from: 'beta',
    to: '',
    command: 'node check.mjs',
  });
  assert.equal(r.verdict, 'SURVIVED');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha\r\nbeta\r\n');
});

test('mutate calls onApplied with a working restore before the command ends', async (t) => {
  const root = sandbox(t);
  let seen = '';
  await mutate({
    root,
    file: 'a.txt',
    from: 'beta',
    to: 'gamma',
    command: 'node check.mjs',
    onApplied: (restoreNow) => {
      seen = readFileSync(join(root, 'a.txt'), 'utf8');
      restoreNow();
    },
  });
  assert.equal(seen, 'alpha gamma\n');
});

const nodeOut = [
  '✔ a ok (0.37ms)',
  '✖ b bad (0.10ms)',
  'ℹ tests 2',
  'ℹ pass 1',
  'ℹ fail 1',
  '✖ failing tests:',
  '✖ b bad (0.10ms)',
].join('\n');
const jestOut = [
  '  ✓ adds (2 ms)',
  '  ✕ subtracts (3 ms)',
  'Tests:       1 failed, 4 passed, 5 total',
].join('\n');

test('parseReport reads node --test output, once per failing name', () => {
  assert.deepEqual(parseReport(nodeOut), {
    failed: ['b bad'],
    pass: 1,
    fail: 1,
  });
});

test('parseReport reads TAP-style counts from node --test', () => {
  assert.deepEqual(parseReport('# pass 3\n# fail 0'), {
    failed: [],
    pass: 3,
    fail: 0,
  });
});

test('parseReport reads jest output, missing counts as 0', () => {
  assert.deepEqual(parseReport(jestOut), {
    failed: ['subtracts'],
    pass: 4,
    fail: 1,
  });
  assert.deepEqual(parseReport('Tests:       3 passed, 3 total'), {
    failed: [],
    pass: 3,
    fail: 0,
  });
});

test('parseReport returns null for output of another runner', () => {
  assert.equal(parseReport('FAIL src/x.spec.ts\n1 failing'), null);
});

test('formatResult prints verdict, failing names and counts', () => {
  assert.equal(
    formatResult({ verdict: 'KILLED', output: nodeOut }),
    'KILLED\nfailing tests:\n  - b bad\npass 1, fail 1'
  );
  assert.equal(
    formatResult({ verdict: 'SURVIVED', output: '# pass 3\n# fail 0' }),
    'SURVIVED\npass 3, fail 0'
  );
});

test('formatResult prints the last 20 lines when nothing is recognised', () => {
  const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
    '\n'
  );
  const text = formatResult({ verdict: 'KILLED', output });
  assert.equal(
    text,
    ['KILLED', ...Array.from({ length: 20 }, (_, i) => `line ${i + 11}`)].join(
      '\n'
    )
  );
});

const cli = (root, ...args) => {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of ['mutate.mjs', 'mutate-lib.mjs']) {
    copyFileSync(
      join(import.meta.dirname, '..', file),
      join(root, 'scripts', file)
    );
  }
  return spawnSync('node', [join(root, 'scripts', 'mutate.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
};

test('cli prints KILLED and exits 0 even though the command failed', (t) => {
  const root = sandbox(t);
  const r = cli(root, 'a.txt', 'alpha', 'omega', '--', 'node', 'check.mjs');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^KILLED/);
  assert.equal(git(root, 'status', '--porcelain', '--', 'a.txt'), '');
});

test('cli prints SURVIVED and exits 0', (t) => {
  const root = sandbox(t);
  const r = cli(root, 'a.txt', 'beta', 'gamma', '--', 'node', 'check.mjs');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SURVIVED/);
});

test('cli exits 1 with the reason on a refusal', (t) => {
  const root = sandbox(t);
  const r = cli(root, 'a.txt', 'zzz', 'y', '--', 'node', 'check.mjs');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /0 occurrences/);
});

test('cli exits 2 with usage on bad arguments', (t) => {
  const root = sandbox(t);
  for (const args of [
    [],
    ['a.txt', 'alpha', 'omega'],
    ['a.txt', 'alpha', 'omega', 'node', 'check.mjs'],
    ['a.txt', 'alpha', 'omega', '--'],
    ['a.txt', '', 'omega', '--', 'node', 'check.mjs'],
  ]) {
    const r = cli(root, ...args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage: npm run mutate/);
  }
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha beta\n');
});
