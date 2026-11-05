---
paths:
  - 'docs/superpowers/queue/**'
---

# Follow-up fix rounds

A round that applies the follow-ups of a finished plan has no plan, only a
brief file. It runs the same chain as a plan task: `sdd-implementer`, then
`sdd-task-reviewer`, then `gate-runner`.

- **The controller saves the report.** The harness refuses a subagent's
  `Write` to a report file ("Subagents should return findings as text"), and
  an implementer still replies with the path as if it existed. Tell it in the
  dispatch to return the full report as its reply, then `Write` the file
  yourself before `sdd-step.sh review`, and `ls` it before a reviewer reads it.
- **Brief-pinned text is not a finding.** A brief that gives exact comment or
  doc text overrides `CODING_STANDARDS.md` "Comments" for that text: say so in
  the reviewer dispatch, or every review repeats the same Minor.
- **Follow-up lines a round fixed** are marked `[fixed: <sha>]` by the
  controller, so `/swarm:ship` finds no open line to ask about. Mark a line the
  moment a commit closes it, an audit fix included: a stale line gets copied
  into the next brief as a defect that no longer exists. Mark with
  `bash scripts/sdd-step.sh mark <followups.md> <line> <sha> [note]`; it
  refuses a line already marked `[fixed:` or `[dropped`.
- **`git status` never shows a followups edit.** The `*-followups.md` files sit
  under git-ignored `docs/superpowers/`, so check them with `Read`, not `git diff`.
- **`Fixes #<n>` lines come from the queue file.** Read
  `docs/superpowers/queue/YYYY-MM-DD-<name>.json` (issues with `status` `done`),
  not the commit subjects.
- **A mutation check in an implementer report gives the command and the
  failing test name.** The command is `npm run mutate -- <file> <from> <to> --
<test command>`. A reviewer may run `npm run mutate` itself: it restores the
  file (and refuses a dirty or untracked one).
- **Review package without a plan:** pass the brief file where the plan goes,
  `bash scripts/sdd-step.sh review <brief.md> <BASE> [HEAD]`. It writes the
  diff under `.superpowers/sdd/<brief-name>/` and prints the path. Do not
  build the diff by hand. The brief lives in the main checkout (git-ignored)
  and the `*-followups.md` files in the task worktree: pass the brief by its
  absolute path, since a relative one fails with `no such plan file`.
- **Concerns land in the follow-ups file.** The brief's rule "do not edit the
  followups files" protects the lines being fixed. A `DONE_WITH_CONCERNS` still
  gets its `accepted without user: <concern> -> <choice>` line, or goes to the
  user, under a `## Round <n>` heading in that file, as `pipeline.md` says. A
  concern left only in the chat is lost at `/clear`.
- **Baseline questions** ("does this warning also appear on `origin/dev`?"):
  `npm run baseline -- <client test path> [text]`. It builds a proper task
  worktree for the dev side; a bare `git worktree add` shares `shared` with the
  checkout it came from, so its result proves nothing.
- **Which lines to fix.** Offer "fix now" for a line with a real defect or a
  RED test. Recommend "drop" for a Minor line (naming, comment wording, a
  cosmetic merge): in the queue-b round seven such lines cost 18.46M tokens,
  37% of the chain.
- **Brief preamble for `sdd-implementer`.** Name the traps that cost calls:
  commit types are `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci` (no
  `perf:` or `wip:`); `.superpowers/` is git-ignored, so never `git add` the
  ledger; `sdd-step next` after the last task errors; `ls server/.env.local`
  hits a deny rule; write files with `Write`/`Edit`, since `cp`, `sed -i` and
  redirects are blocked. Give each item its focused test command (client
  `npm test -w client -- <path>`, scripts `node --test <path>`): an implementer
  without one tried `jest` through `npm exec` first.
- **`ui-checker`:** a follow-up round whose diff touches `client/src` is not
  checked again by default, since the plan's own run covered the behaviour.
  Ask the user, and run it when the round changed what a page shows or sends.
