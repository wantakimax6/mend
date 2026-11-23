# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wantakimax6/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wantakimax6/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies edits written by AI models to a tree of
text files. Models write edits in four formats, and mend reads all of them to
one specification, `SPEC.md`: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It
finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree). With no `PATCH`, or with `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default, which detects the format).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one line per changed file (`A`, `D`, `M`, or `R <old> ->
<new>` for a move) and `ok: <n> files`, and exits 0. A patch that cannot be
read exits 2 (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`); a patch whose edits fail exits 1, lists every failure,
and writes nothing.

## Matching

An edit's old lines are found at the first of three tiers at which they occur:
exact, trailing whitespace ignored, or leading and trailing whitespace
ignored. At the third tier, new lines are re-indented to match the file.
Context lines are always written as the file's own lines.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files
it starts with. It passes when the exit code, everything written to standard
output and every file afterwards are exactly what `SPEC.md` says.

---

<sub>Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
