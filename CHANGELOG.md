# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/minlayer/minflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/minlayer/minflow/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/minlayer/minflow/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/minlayer/minflow/releases/tag/v0.0.0
