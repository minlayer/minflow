# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/minlayer/minflow/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/minlayer/minflow/releases/tag/v0.0.0
