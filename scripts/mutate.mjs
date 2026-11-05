/**
 * Applies one literal replacement to a tracked, clean file, runs a test
 * command, prints KILLED (the command failed, so a test caught the change) or
 * SURVIVED, and restores the file. Usage: see `usage` below.
 *
 * The working tree is left as found, so a read-only reviewer may call it. It
 * refuses an untracked or dirty file, a path outside the repo, and a `from`
 * that does not occur exactly once. The command runs through the shell: the
 * caller quotes it. The logic is in `mutate-lib.mjs`.
 */
import { resolve } from 'node:path';
import { Refusal, UsageError, formatResult, mutate } from './mutate-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const usage = 'usage: npm run mutate -- <file> <from> <to> -- <test command>';

const fail = (message, code) => {
  console.error(message);
  process.exit(code);
};

// Restore on Ctrl-C or a kill, since `finally` does not run on process.exit.
const restoreOnSignal = (restore) => {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(signal, () => {
      restore();
      process.exit(code);
    });
  }
};

const argv = process.argv.slice(2);
if (argv.length < 5 || argv[3] !== '--') fail(usage, 2);

try {
  const [file, from, to] = argv;
  const result = await mutate({
    root,
    file,
    from,
    to,
    command: argv.slice(4).join(' '),
    onApplied: restoreOnSignal,
  });
  console.log(formatResult(result));
} catch (error) {
  if (error instanceof Refusal) fail(error.message, 1);
  if (error instanceof UsageError) fail(usage, 2);
  throw error;
}
