import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const scripts = join(import.meta.dirname, '..');

// A git repo holding the CLI, one source file and one brief.
const sandbox = (t, brief) => {
  const repo = mkdtempSync(join(tmpdir(), 'brief-check-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'src'));
  for (const file of ['brief-check.mjs', 'brief-refs.mjs', 'doc-refs.mjs'])
    copyFileSync(join(scripts, file), join(repo, 'scripts', file));
  writeFileSync(
    join(repo, 'src', 'code.ts'),
    'export const liveName = 1;\nliveName;\n'
  );
  writeFileSync(join(repo, 'brief.md'), brief);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['add', 'scripts', 'src'], { cwd: repo });
  return repo;
};

const run = (repo, { args = ['brief.md'], env } = {}) =>
  spawnSync(process.execPath, ['scripts/brief-check.mjs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
  });

test('a name in the code prints its line count and passes', (t) => {
  const result = run(sandbox(t, '`liveName` exists\n'));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /brief\.md:1 liveName hits=2/);
});

test('a missing name and a missing path exit 1 with hits=0', (t) => {
  const result = run(sandbox(t, '`goneName`\n`src/gone.ts`\n'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /goneName hits=0/);
  assert.match(result.stdout, /src\/gone\.ts hits=0/);
});

test('a path of a tracked file counts as one hit', (t) => {
  const result = run(sandbox(t, '`src/code.ts`\n'));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /src\/code\.ts hits=1/);
});

test('an untracked file named in the brief reports hits=0', (t) => {
  const repo = sandbox(t, '`src/untracked.ts`\n');
  writeFileSync(join(repo, 'src', 'untracked.ts'), 'export const x = 1;\n');
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\/untracked\.ts hits=0/);
});

test('a missing git exits non-zero naming git, not a TypeError', (t) => {
  const result = run(sandbox(t, '`liveName`\n'), {
    env: { ...process.env, PATH: '', Path: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('a tracked brief does not match its own tokens', (t) => {
  const repo = sandbox(t, '`deadName`\n');
  spawnSync('git', ['add', 'brief.md'], { cwd: repo });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /deadName hits=0/);
});

test('no argument exits 2 with usage', (t) => {
  const result = run(sandbox(t, ''), { args: [] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

test('a bare file name is matched by suffix', (t) => {
  const result = run(sandbox(t, '`code.ts`\n'));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /brief\.md:1 code\.ts hits=1/);
});

test('a token inside a fenced block is skipped', (t) => {
  const result = run(sandbox(t, '```\n`goneName`\n```\n`liveName`\n'));
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /goneName/);
  assert.match(result.stdout, /brief\.md:4 liveName hits=2/);
});

test('a missing brief file exits 2 with one error line and no stack', (t) => {
  const result = run(sandbox(t, ''), { args: ['nope.md'] });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /brief-check: brief not found: .*nope\.md/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stderr, /\bat .*\(|node:internal|ENOENT/);
});

test('a line suffix and a leading ./ do not change the hit count', (t) => {
  const repo = sandbox(t, '`src/liveFile.ts:4,9`\n`./src/liveFile.ts`\n');
  writeFileSync(join(repo, 'src', 'liveFile.ts'), 'export const x = 1;\n');
  spawnSync('git', ['add', 'src'], { cwd: repo });
  const result = run(repo);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /src\/liveFile\.ts:4,9 hits=1/);
  assert.match(result.stdout, /\.\/src\/liveFile\.ts hits=1/);
});

test('a backslash path counts like its slash form', (t) => {
  const result = run(sandbox(t, '`src\\code.ts`\n`src\\gone.ts`\n'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\\code\.ts hits=1/);
  assert.match(result.stdout, /src\\gone\.ts hits=0/);
});
