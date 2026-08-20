# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An entry command can greet the user before the run starts.** `emit` takes a new
  `welcome` option. When it is set, the entry command opens with that text, quoted
  inside a fence longer than any fence inside it, and spawns the runner after it.

  A compiled workflow opened with a spawn instruction and nothing else, so the first
  thing a user saw was a run already under way. Nothing said what the workflow does,
  what it needs from them, or how often it stops to ask. That is knowledge the author
  has and the user does not, and a command body is the one place a plugin can put text
  into the main conversation.

  The fence grows one backtick past the longest run inside the text, because a greeting
  almost always carries a fenced banner. A three backtick wrapper would close at the
  banner's own fence, and the rest of the greeting would reach the model as instructions
  rather than as text to print.

  It is an emit option rather than a graph field, so a reworded greeting leaves the graph
  hash alone. A parked run resumes only against its own hash, so the alternative would
  strand every run in flight.

  Only the entry command carries it, because a gate command releases a run that greeted
  the user already. A workflow that does not set the option emits a byte identical command
  body.

## [0.4.0] - 2026-08-19

### Added

- **A step is told the turn ceiling the host will enforce on it.** When a node
  declares `maxTurns`, the emitted wrapper now states the number in its body and
  tells the step to keep one turn back for its final message.

  A ceiling a step cannot see gets spent. The step is then cut off before it writes
  the message the run reads, so it has produced nothing at all however much work it
  did. That surfaces as a broken output contract, because that is what it is, and the
  cause is a number in a frontmatter field the step was never told about. Two runs of
  a real workflow died that way, on two different steps, and both reports named the
  payload rather than the ceiling.

  The number comes from the same `maxTurns` the frontmatter carries, so what a step is
  told cannot drift from what the host enforces. A node with no ceiling is told about
  none, rather than being told a default it does not have.


## [0.3.0] - 2026-08-19

### Added

- **A finished or stopped run leaves a record, and `--from <node>` re-enters
  from it.** A record holds every payload every step produced, keyed by the step
  that produced it, and the entry command can start a fresh run at any step you
  name with that record carried into it. Nothing before the named step runs
  again.

  This is the loop a workflow is actually edited in: run it, read what came out,
  change one prompt near the end, run it again. Paying for the eleven steps in
  front of the twelfth, every time, is what made that loop expensive. The record
  is not consumed, so one run seeds as many attempts as the tuning takes.

  A graph whose hash moved is accepted here, unlike a resume, because changing
  the graph is usually the reason to re-enter. What replaces the hash check is
  stricter than the hash was: every value the chosen step reads is checked
  against the record before the run starts, and a step that reads something
  nothing carries is refused rather than started. A value only a later step reads
  is named as a warning instead, because that step may sit on a branch this run
  never takes.

  A record is not state and is not a run. It sits in its own directory, nothing
  resumes one, and no scan of live runs can see one. Records are capped at the
  most recent 20, and abandoning a run at a gate keeps none: that command means
  throw this away, and a record would make it reversible by accident.

  An interrupted run seeds a re-entry too, so there is no need to finish or
  abandon one first.

### Fixed

- **An argument the entry command does not recognise is now reported.** It named
  a run to resume, and when it named nothing the caller could not tell that from
  there being nothing to resume, so a typo, or a subject somebody reasonably
  expected to reach the workflow, silently started a fresh run over the top of a
  stalled one. That is the single outcome resume exists to prevent, and it was
  reachable by misspelling a word.


## [0.2.1] - 2026-08-17

### Added

- **Portable capability tiers for `model`.** A step may ask for `small`, `medium`
  or `large`, and the backend translates it: on Claude Code, into `haiku`,
  `sonnet` and `opus`. A tier is relative to whichever ladder a deployment
  resolves, not an absolute capability claim, because a client is not a provider:
  several clients expose more than one provider's ladder at once, so `large` can
  only mean the top of the ladder in play.

  This is containment for the leak recorded as D28 and L23, not the fix. `model`
  is still typed as a free string in the IR and a provider's own name still passes
  through, because removing it would break every graph already written. New graphs
  should use a tier: it is the only spelling that survives a change of platform.

### Fixed

- **A model the backend does not recognise is now a compile error**, instead of
  being copied into the agent's frontmatter verbatim. A misspelling used to
  produce an agent naming a model that does not exist, in a compiler that
  otherwise refuses an unknown node reference on the line containing it. The
  error names the node and lists what is accepted. Validation lives in the
  backend, because which model names are real is a fact about a platform and the
  builder is not allowed to know one.

## [0.2.0] - 2026-08-17

### Added

- **A run interrupted mid-flight can be resumed from the entry command.** A long
  workflow will be interrupted: a session limit, a closed laptop, a crash. Its
  state was already intact and already pointed at the step it was about to take,
  and SPEC section 3.5 already said "one static command therefore serves both a
  fresh run and a run resumed at any node", which is how gate resume has always
  worked. Nothing was wired to it for an interrupted run, so the work was simply
  lost. Running the entry command again now picks the run up where it stopped and
  reports what it resumed.

  Resuming is the default, because the expensive mistake is redoing work rather
  than continuing it. `--new` starts a fresh run and leaves the stopped one
  alone. The auto flag is carried rather than re-read, so a run cannot change
  halfway about whether a human is behind it. A run whose graph hash no longer
  matches is refused rather than resumed against nodes that may have moved, and
  several stopped runs are named rather than guessed between. A run stopped
  mid-ask is reported as needing its answers, not resumed past them.

- The entry command now always carries an `argument-hint`, since every workflow
  can be interrupted and therefore resumed.

## [0.1.4] - 2026-08-17

### Fixed

- **A pattern nothing can fail is reported as unreachable instead of guessed
  at.** Making an `otherwise` coverable needs a string that fails the guard, and
  for a pattern like `/.*/` no such string exists. The generator returned one
  that matched anyway, so it emitted a case whose walk the run could never take,
  and that case then failed as though the graph were wrong. It now refuses, and
  the outcome is reported unreachable with the pattern named.

## [0.1.3] - 2026-08-17

### Fixed

- **A generated case can now get past a gate.** A gate parks the run for a
  person to look at, and is released by a command that person runs, which the
  harness never sent. The run parked and stayed parked, so every node
  downstream of a gate was unreachable to the suite and was reported as a
  routing failure that was not one. The harness now plays the reviewer's part,
  exactly as it already plays the session's part for an ask.

  This is not auto mode waving a gate through. Auto mode governs a live run
  doing real work, where removing the human is the whole danger; a generated
  case does no work at all, its observations are synthetic, and the only
  question being asked is whether the routing is right.

### Added

- `claudeCode.gateCommandsFor(graph)`, which reports every gate's qualified
  resume and reject commands as the emitted plugin registers them.

## [0.1.2] - 2026-08-17

### Fixed

- A generated case whose **entry is a command node** now answers that node.
  Every other command node is drained on the fire belonging to the step before
  it, and that is where its answers were written. An entry command node has no
  step before it: it runs while the runner is still standing by for the first
  time, so its answers were never written at all and it resolved against the
  world instead. A case that needed the command to fail on its first visit
  walked straight past the divert, and the walk check blamed the graph.

## [0.1.1] - 2026-08-17

### Fixed

- A generated case that visits one node twice in a single hook fire now
  answers each visit in turn. A retry whose guard leaves a command node sends
  that node back to itself, and a command node is drained without leaving the
  dispatcher, so both visits happen in one process and the harness cannot
  rewrite its answers between them. Answering per node let the second visit
  overwrite the first, so a case meant to fail a build once and pass it on the
  retry advanced on the first attempt, and the walk check blamed the graph for
  it.
- `src` ships in the package. The maps in `dist` name `../src/*.ts`, which was
  not there, so every stack trace through minflow pointed at a file the tarball
  did not contain.
- `minflow test` prints paths relative to the working directory when they are
  under it, rather than absolute ones.
- `minflow test` no longer reports unreachable outcomes as "not covered"
  directly beneath the count of covered ones, which read as a contradiction.
  They are outcomes nothing can reach, the reachable count already excludes
  them, and each still carries its reason.
- A literal NUL in `testsuite.ts` made the file binary to `grep` and every tool
  that reads it as text.

## [0.1.0] - 2026-08-17

### Added

- Command nodes: `wf.run(id, { command })`. The host runs a shell command
  between two runner stops and records `{exitCode, stdout, stderr}` as the
  node's payload, with no model call and no round trip. A chain of them drains
  in a single hook fire. A non-zero exit is a routable outcome rather than a
  failure; only a command that could not be run at all is an error. A `judge()`
  guard leaving a command node is a compile error, because there is no model
  there to ask.
- Interactive asks: `wf.ask(from, to, { questions })`, and `askFrom(path)` when
  the step computes its own questions at run time. The run resumes on its own
  once answered. A subagent cannot reach the user, so the questions travel out
  through the runner's final message and the answers come back through a file.
  Answers land under their own node id, and a `{{ctx}}` reference into them is
  checked with edge dominance like any other.
- Auto mode: `--auto` on a compiled workflow's entry command answers its own
  asks and runs unattended. A gate is a wall rather than a formality, and ends
  the run instead of being waved through, since a mode that removed the human
  from the one mechanism meant for human judgment would make gates meaningless.
- Skills are compiled into the plugin. `emit` writes every skill the graph
  names, each copy forced to `user-invocable: false`, so a workflow has exactly
  one public surface: its entry command. The author's files are never written
  to.
- `Skill`: a domain object that reads a skill from its directory, brings the
  bundled `references/` and `scripts/` with it, types the fields minflow
  reasons about, carries every other frontmatter field through unchanged, and
  refuses to let a caller set the three fields the compiler owns.
- `EmitOptions.assets`, for files a workflow needs shipped beside its skills.
- Generated tests, and the `minflow` command line that runs them. `minflow test`
  derives a suite of cases from the graph, writes it to `.minflow/suite.json`,
  and replays each one against a real emitted dispatcher; `--collect-only`
  writes and stops. Coverage is measured over **outcomes** rather than edges,
  because one edge is several decisions with different preconditions. The suite
  is an artifact meant to be read, the way a collected pytest suite is. No model
  and no network are involved.

### Changed

- **Breaking.** The `Ir` prefix is gone from the IR's exported types: `IrNode`,
  `IrEdge` and `IrGraph` are now `Node`, `Edge` and `Graph`. The IR is the
  domain, so it keeps the canonical names and every other layer works around
  it.
- `Node` is a union of `StepNode` and `CommandNode`, discriminated by `kind`.

## [0.0.1] - 2026-08-13

### Added

- The graph builder: `workflow()`, `step`, `entry`, `edge`, `gate`, `branch`,
  `compile`, `print`, with `when.*` mechanical predicates, `judge()` for a model
  verdict, `retry()`, and `END`. Unknown node references throw at the call that
  contains them rather than surfacing later as a key lookup.
- The intermediate representation: nodes, a transition table, and a graph hash,
  all plain JSON so a compiled graph can be diffed, hashed, and linted with no
  model and no runtime involved.
- `lintGraph()`: unreachable nodes, dead ends, and cycles that provably cannot
  terminate are compile errors. Exported so an IR that did not come from the
  builder gets the same checks.
- The transition evaluator: `observationsFor()` reports what a host must find
  out, and `evaluate()` decides the transition as a pure function of already
  resolved values. Nothing about how a value was obtained reaches it.
- The Claude Code backend: `claudeCode.emit()` renders a plugin as a pure
  function returning a path to contents map, and `claudeCode.writeFiles()` puts
  it on disk. The emitted plugin routes a run itself: it resolves the
  observations a graph asks for, evaluates the transition, and drives the next
  step, including a natural language verdict, a gate parked for human sign off,
  and a retry to its limit.
- Run context interpolation. A prompt may read an earlier step's output as
  `{{ctx.node.path}}`, legal only when that step is on every route to this one,
  so a value cannot be present on one branch and missing on another.
- `checkSkills` and `discoverSkills`, because Claude Code skips a skill it
  cannot resolve with only a debug log warning, so a step whose skill is missing
  otherwise runs without its instructions and reports nothing wrong.
- `toMermaid`, which renders a graph as a diagram, including where a run parks
  for a human, a retry's ceiling, and where a failing guard diverts to.

### Notes

- Platform behaviour is verified by execution against Claude Code `2.1.229`
  rather than assumed, and several claims that seemed safe to infer turned out
  to be wrong. See `docs/VERIFICATION.md`.
- The API is unstable throughout the `0.0.x` line.

## [0.0.0]

### Added

- Initial repository scaffolding: TypeScript build, Biome lint and format,
  Vitest test suite, and GitHub Actions for CI and publishing.
- Placeholder release reserving the `minflow` package name on npm.

[Unreleased]: https://github.com/minlayer/minflow/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/minlayer/minflow/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/minlayer/minflow/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/minlayer/minflow/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/minlayer/minflow/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/minlayer/minflow/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/minlayer/minflow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/minlayer/minflow/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/minlayer/minflow/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/minlayer/minflow/releases/tag/v0.0.0
