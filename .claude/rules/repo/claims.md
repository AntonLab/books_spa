---
paths:
  - 'docs/superpowers/specs/**'
  - 'docs/superpowers/queue/**'
  - 'docs/agents/**'
---

# Claims before they ship

A claim written from memory, a compaction summary or a retro reads as fact and
costs a round when it is wrong. In the 2026-10-18 hardening queue three brief
claims and two retro claims were wrong; each became work or an issue.

Give every checkable claim one command and record its output beside it.
**Checkable** means a statement a command can settle: "advisory X has a fix",
"`put` is duplicated in N specs", "the test fails if Y", "`/swarm:ship` re-runs
the gates", "every result arrives twice".

- **Before a brief goes to `sdd-implementer`:** run the command for each claim
  (`npm audit --json` for `first_patched_version`, `git grep -c` for a
  duplicate count, a failing test for "fails if") and write the output into the
  brief's item. An item whose command contradicts the claim is rewritten or
  dropped before dispatch.
- **A path or name that exists is not a claim that holds.** The queue-b fixes
  brief passed a path-and-name check and still had 2 of 7 items false (`inScroller`
  already existed; a named selector was absent from the source) and 3 wrong
  paths. Run `git grep` for each identifier the item says is missing
  or present, and quote the hit count. `npm run brief:check -- <brief.md>`
  prints the count for every backticked name and path, and exits 1 on a 0.
- **A brief item that names an API or a method** ("use `removeQueries`", "use
  `refetchPage`", "move X onto hook Y") gets a command that shows it works
  here: `git grep` in the installed package (`node_modules/<pkg>/src`), `ctx7`
  for the installed major, or the hook's source. In the queue-b follow-ups
  three such items could not run as written (`removeQueries` refetched a
  mounted observer; TanStack Query 5.104.1 has no `refetchPage`; the hook had
  one flag).
- **A brief item copied from a follow-ups line** is checked against the spec
  or code the line came from, not the line itself: a line is a summary. In the
  PR #251 and #263 follow-ups 4 of 18 items each were wrong or infeasible.
- **A brief item that asks for a test** ("a failing regex does not match across
  a blank line") gets the input and both outputs: run the old code and the new
  code on it. If both give the same result, the test cannot fail; drop the item.
  In the 2026-11-05 round the `^\s*` and `^[ \t]*` regexes both gave
  `[ 'b bad' ]` on the test's input, and the test was deleted a round later.
- **A brief item that prescribes a process kill or spawn order** gets a repro on
  the platform where it matters. Under `shell: true` on Windows,
  `child.kill()` before `taskkill /T /F` left the sleeping grandchild alive;
  `taskkill` first killed it.
- **A count in a brief** ("a like has two keys", "N handlers", "three
  callers") gets the same: read the code or `git grep -c` and quote the
  output. In the queue-b follow-ups a wrong key count cost a review round.
- **Before `gh issue create` from a retro, audit or summary:** check each factual
  line against the primary source: the transcript (`npm run tokens -- <id>`
  tallies one session; `Grep` the `.jsonl` for the event), the skill text, the
  CI run. Quote the `path:line` in the issue body. A retro written after a
  compaction is a summary of a summary: treat it as a lead, not a source.
- **Done when** every checkable claim in the brief or issue has a command and an
  output, and none contradicts it.
