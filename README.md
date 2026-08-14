# minflow

[![npm](https://img.shields.io/npm/v/minflow.svg)](https://www.npmjs.com/package/minflow)
[![CI](https://github.com/minlayer/minflow/actions/workflows/ci.yml/badge.svg)](https://github.com/minlayer/minflow/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Early development.** The API is unstable and will change without notice
> throughout the `0.0.x` line.

A workflow compiler for coding agents. You describe a graph of steps in
TypeScript, and minflow compiles it into a plugin the agent installs and runs
with one command.

Your skills stay exactly as you wrote them. minflow reads them and never writes
to them, so no workflow machinery leaks into files you maintain by hand, and you
never edit a hook or manage state yourself.

## Example

```ts
import { workflow, when, judge, retry, END, claudeCode } from "minflow";

const wf = workflow({ name: "research-and-ship" });

wf.step("research",  { skill: "research-topic", model: "haiku",
                       output: { notes: "string", sources: "string[]" } });
wf.step("plan",      { skill: "write-plan" });
wf.step("implement", { skill: "implement-plan", maxTurns: 25 });
wf.step("review",    { skill: "review-changes" });

wf.entry("research");

wf.edge("research", "plan",    when.fileExists("notes.md"));
wf.gate("plan", "implement",   { command: "approve-plan" });   // human sign-off
wf.edge("implement", "review", when.exitZero("npm test"),
                               { otherwise: retry(3, "tests failing") });
wf.branch("review", judge("Are there unresolved findings?"), {
  no:  END,
  yes: "implement",
});

await claudeCode.writeFiles(claudeCode.emit(wf.compile()), "./research-ship");
```

`when.*` is a library of mechanical predicates that cost no tokens: an exit code,
a file on disk, a field of a step's output. `judge()` is the one conspicuous way
to ask a model for a verdict, so reaching for judgment is a visible decision
rather than an accident.

A step reads an earlier step's output by interpolating it:

```ts
wf.step("plan", { skill: "write-plan", prompt: "Write a plan from:\n\n{{ctx.research.notes}}" });
```

That reference is legal only when `research` **dominates** `plan`, meaning every
route through the graph reaches `plan` through `research`, so the value cannot be
present on one branch and missing on another. When it is not, compiling fails and
names a route that reaches `plan` while skipping `research`, rather than leaving
you to find out on the branch nobody tested.

Two things worth running before you ship a workflow:

```ts
import { checkSkills, discoverSkills, toMermaid } from "minflow";

const problems = checkSkills(ir, await discoverSkills([".claude/skills"]));
console.log(toMermaid(ir));
```

`checkSkills` matters more than it sounds. Claude Code skips a skill it cannot
resolve with only a debug-log warning, so a step whose skill is missing runs
without its instructions and the run reports nothing wrong. `toMermaid` is the
reading path: the builder gives up the transition table's one-glance legibility
in exchange for errors at the offending line, and the diagram buys it back,
including where a run parks for a human and what a retry's ceiling is.

## Why a compiler

The asset is the intermediate representation that `compile()` produces: a
transition table plus node definitions, expressible as JSON. Everything valuable
lives at that level and is independent of any platform.

- It is testable with no model in the loop.
- Unreachable states, dead ends, and cycles nothing can terminate are lint
  errors, caught before anything runs.
- The same graph hashes identically in a different process on a different day,
  so a graph edited mid-run is detected rather than silently resumed.
- It outlives any one platform.

Backends are adapters that know one platform's quirks. They are replaceable. The
IR is not.

## What it emits

A Claude Code plugin directory, ready to load:

```
research-ship/
  .claude-plugin/plugin.json     manifest, the only file in this directory
  commands/run-research-ship.md  the entrypoint, invoked as /research-ship:run-research-ship
  commands/approve-plan.md       one resume command per gate, plus its reject
  agents/runner.md               spawns one step at a time, makes no routing decisions
  agents/step-*.md               one wrapper per node, preloading that node's skill
  hooks/hooks.json               two registrations, both matcher-scoped
  hooks/dispatch.cjs             evaluates the transition table after each step
  workflow.compiled.json         the compiled graph
```

Two properties the design treats as non-negotiable. Routing is deterministic:
every transition is decided by evaluating a table in code, never by a model
deciding what to do next. And the plugin has **zero idle footprint**: both hook
registrations are scoped so that nothing fires during unrelated work.

## Status

Working: the builder, the IR, the graph lint, the transition evaluator, run
context interpolation, skill validation, Mermaid output, and the Claude Code
backend. 557 tests, none of which need a model.

A compiled workflow runs: the transition cycle, a judge verdict, a gate parked in
one session and released in another, and a retry to its limit have each been
driven end to end on a real install.

Platform behaviour is verified by execution rather than assumed. The claims the
design rests on were measured against Claude Code `2.1.229`, and
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md) records what was checked, how,
and what to re-check against a future release.

Not done: backends for the other Agent Plugins clients (Codex CLI, Cursor,
GitHub Copilot, VS Code, Kiro). Their packaging is settled by the Agent Plugins
1.0.0 standard; their orchestration seam is not yet investigated.

## Documentation

| Document | Contents |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | The specification: authoring surface, IR, guards, and the Claude Code backend in full |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | Why it is shaped this way, including the paths that were tried and abandoned |
| [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) | How each platform claim was established, and the pinned baseline |
| [`docs/DYNAMIC-WORKFLOWS.md`](./docs/DYNAMIC-WORKFLOWS.md) | A preview output mode, opt-in and outside v1 |

## Install

```bash
npm install minflow
```

## Related packages

| Package | Status |
| --- | --- |
| [`minflow`](https://www.npmjs.com/package/minflow) | This package. The compiler, usable on its own. |
| [`minlayer`](https://www.npmjs.com/package/minlayer) | Reserved name, placeholder release. A family of plugins for coding agents, built with minflow. |
| [`minlayer-claude`](https://www.npmjs.com/package/minlayer-claude) | Reserved name, placeholder release. |

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check   # lint, typecheck, and test
npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Ariel Arevalo
