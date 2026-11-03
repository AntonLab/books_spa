import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const scripts = join(import.meta.dirname, '..');

// A feature-branch repo and a fake superpowers cache under a sandbox HOME.
const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-step-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const workspace = join(repo, '.superpowers', 'sdd', 'plan');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'server'));
  writeFileSync(join(repo, 'server', '.env.local'), '');
  copyFileSync(
    join(scripts, 'sdd-step.sh'),
    join(repo, 'scripts', 'sdd-step.sh')
  );
  writeFileSync(
    join(repo, 'plan.md'),
    '# Plan\n\n### Task 1: only task\n\nBody.\n'
  );
  for (const args of [
    ['init', '-q', '-b', 'feat/x'],
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
  ]) {
    spawnSync('git', args, { cwd: repo });
  }

  const fake = join(
    root,
    'home',
    '.claude/plugins/cache/claude-plugins-official/superpowers/1.0.0/skills/subagent-driven-development/scripts'
  );
  mkdirSync(fake, { recursive: true });
  writeFileSync(
    join(fake, 'sdd-workspace'),
    `mkdir -p .superpowers/sdd/plan && echo .superpowers/sdd/plan\n`
  );
  // Mirrors the real task-brief: writes the brief, exits 3 when it is empty.
  writeFileSync(
    join(fake, 'task-brief'),
    [
      'mkdir -p .superpowers/sdd/plan',
      'out=.superpowers/sdd/plan/task-$2-brief.md',
      `grep -A2 "^### Task $2:" "$1" > "$out" || true`,
      '[ -s "$out" ] || { echo "task $2 not found" >&2; exit 3; }',
      'echo "wrote $out"',
      '',
    ].join('\n')
  );
  return { repo, workspace, home: join(root, 'home') };
};

const run = ({ repo, home }, ...args) =>
  spawnSync('bash', ['scripts/sdd-step.sh', 'next', 'plan.md', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

const FOLLOWUPS = 'followups.md';
const mark = ({ repo, home }, ...args) =>
  spawnSync('bash', ['scripts/sdd-step.sh', 'mark', FOLLOWUPS, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
const followups = (box, text) => {
  writeFileSync(join(box.repo, FOLLOWUPS), text);
  return () => readFileSync(join(box.repo, FOLLOWUPS), 'utf8');
};

test('sdd-step mark appends the sha to the line', (t) => {
  const box = sandbox(t);
  const read = followups(box, '- one\n- two\n- three\n');
  const result = mark(box, '2', 'abc1234');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(), '- one\n- two [fixed: abc1234]\n- three\n');
});

test('sdd-step mark appends the note after the sha', (t) => {
  const box = sandbox(t);
  const read = followups(box, '- one\n- two\n');
  const result = mark(box, '1', 'abc1234', 'audit fix');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(), '- one [fixed: abc1234, audit fix]\n- two\n');
});

test('sdd-step mark refuses a line already marked', (t) => {
  const box = sandbox(t);
  for (const line of ['- one [fixed: aaa1111]', '- one [dropped: minor]']) {
    const text = `${line}\n- two\n`;
    const read = followups(box, text);
    const result = mark(box, '1', 'abc1234');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already/);
    assert.equal(read(), text);
  }
});

test('sdd-step mark refuses a missing line and a missing file', (t) => {
  const box = sandbox(t);
  followups(box, '- one\n- two\n');
  const past = mark(box, '3', 'abc1234');
  assert.notEqual(past.status, 0);
  assert.match(past.stderr, /no line 3/);
  rmSync(join(box.repo, FOLLOWUPS));
  const gone = mark(box, '1', 'abc1234');
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /no such file/);
});

test('sdd-step next writes the brief of an existing task', (t) => {
  const box = sandbox(t);
  const result = run(box, '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(box.workspace, 'task-1-brief.md')), true);
});

test('sdd-step next past the last task exits 3 and leaves no brief', (t) => {
  const box = sandbox(t);
  const result = run(box, '2', 'task 1 done');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /no task 2 in plan\.md: plan complete/);
  assert.equal(existsSync(join(box.workspace, 'task-2-brief.md')), false);
  assert.equal(existsSync(join(box.workspace, 'progress.md')), true);
});
