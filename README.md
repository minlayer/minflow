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

wf.run("typecheck", { command: "npm run typecheck" });          // no model call

wf.entry("research");

wf.ask("research", "plan", {                                    // asks, then resumes
  questions: [{ question: "Ship behind a flag?", header: "Flag",
                options: [{ label: "Yes" }, { label: "No" }] }],
});
wf.edge("plan", "typecheck");
wf.edge("typecheck", "implement", when.field("exitCode").equals(0));
wf.gate("implement", "review",  { command: "approve-diff" });   // human sign-off
wf.branch("review", judge("Are there unresolved findings?"), {
  no:  END,
  yes: "implement",
});

await claudeCode.writeFiles(claudeCode.emit(wf.compile()), "./research-ship");
```

## What you get

### Routing nothing can talk its way out of

Every transition is decided by evaluating a table in code. A model never chooses
what happens next, it only produces the value a guard reads.

`when.*` is a library of mechanical predicates that cost no tokens: an exit code,
a file on disk, a field of a step's output. `judge()` is the one conspicuous way
to ask a model for a verdict, so reaching for judgment is a visible decision
rather than something that happens by default.

### Steps that are not model calls

`wf.run("check", { command: "npm test" })` runs a shell command instead of a
model. Its output is `{ exitCode, stdout, stderr }`, which guards read like any
other payload, and a chain of them resolves between two of the runner's stops.
Anything a script can decide costs no model call, no round trip, and cannot be
graded generously by the thing it is checking.

### Questions that answer themselves back into the run

`wf.ask()` puts questions to the user and the run **resumes on its own**. Nobody
types a command to continue.

That is harder than it sounds and is why it is a feature rather than a line of
prose in a skill: a subagent has no way to reach the user at all. The questions
travel out through the runner's final message, the answers come back through a
file, and the run picks up where it left off.

### Sign-off that actually blocks

`wf.gate()` parks the run and waits for a human to release it, across sessions if
need be.

An ask and a gate look similar and are not. **An ask needs a fact. A gate needs a
person to look.** That distinction is enforced rather than documented: an
unattended run answers asks and refuses to pass a gate, because a mode that
removes the human from the one mechanism whose purpose is human judgment would
make gates meaningless.

### Reading an earlier step's output, with a proof

```ts
wf.step("plan", { skill: "write-plan", prompt: "Write a plan from:\n\n{{ctx.research.notes}}" });
```

Legal only when `research` **dominates** `plan`, meaning every route through the
graph reaches `plan` through `research`. When it does not, compiling fails and
names the route that reaches `plan` while skipping `research`, instead of leaving
you to find out on the branch nobody tested.

### Skills that ship, and stay private

`emit` writes every skill the graph names into the plugin, each copy
`user-invocable: false`. A compiled workflow has exactly one public surface, its
entry command. Its steps are implementation, and a plugin exposing each internal
step as a separately invocable skill has as many public surfaces as it has steps.

Your own files are untouched. These are copies, which is what a compiler does
with source. `Skill` reads one from its directory, brings the bundled
`references/` and `scripts/` along, types the fields minflow reasons about, and
carries every other frontmatter field through unchanged.

### Mistakes caught before anything runs

Unreachable nodes, dead ends, cycles that provably cannot terminate, a `ctx`
reference to a step that might not have run, a judge guard on an edge leaving a
command node: all compile errors, all reported at the line that caused them.

```ts
const problems = checkSkills(ir, await discoverSkills([".claude/skills"]));
```

`checkSkills` matters more than it sounds. Claude Code skips a skill it cannot
resolve with only a debug-log warning, so a step whose skill is missing runs
without its instructions and the run reports nothing wrong.

### A graph you can actually read

```ts
console.log(toMermaid(ir));
```

The builder trades the transition table's one-glance legibility for errors at the
offending line. The diagram buys it back: where a run parks for a human, what a
retry's ceiling is, which boxes cost a model call and which are mechanical.

### Tests generated from the graph

```bash
minflow plan     # introspect the graph, write .minflow/plan.json
minflow test     # run it against a real emitted dispatcher
```

Generation and execution are separate verbs on purpose. The plan is a file you
read: every case, the decision it targets, and the exact inputs that force it.

It aims at **branch coverage**, since unreachable nodes and dead ends are already
compile errors. Automatic generation over a control-flow graph normally stalls on
forcing a branch, because that means solving an arbitrary predicate. Guards here
are data, so every kind inverts by inspection and there is no branch minflow
cannot force. An outcome it reports as uncoverable is a fact about your graph,
with the reason attached.

`minflow test` never runs a model and never touches the network.

### Zero idle footprint

An installed workflow runs nothing when no workflow is running. Both hook
registrations are matcher-scoped, so nothing fires during unrelated work. This is
a hard requirement of the design rather than an optimisation.

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
  skills/*/SKILL.md              every skill the graph names, shipped user-invocable: false
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
context interpolation, command nodes, interactive asks, skills shipped inside the
plugin, skill validation, Mermaid output, and the Claude Code backend. 619 tests,
none of which need a model.

A compiled workflow runs: the transition cycle, a judge verdict, a gate parked in
one session and released in another, and a retry to its limit have each been
driven end to end on a real install.

Platform behaviour is verified by execution rather than assumed. The claims the
design rests on were measured against Claude Code `2.1.229` and re-confirmed on
`2.1.232`, and
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md) records what was checked, how,
and what to re-check against a future release.

Not done: backends for the other Agent Plugins clients (Codex CLI, Cursor,
GitHub Copilot, VS Code, Kiro). Their packaging is settled by the Agent Plugins
1.0.0 standard; their orchestration seam is not yet investigated.

Specified and not yet built: generated tests. A compiled graph is a control-flow
graph whose guards are data rather than code, so the inputs that force a given
branch are derivable by inspection rather than by solving a predicate. `SPEC.md`
§1.6 describes writing a readable test plan and executing it against the real
emitted dispatcher, and §3.13 describes the auto mode a live run needs.

Also not done, and wanted: broader graph shapes. A run has one current node, so
graphs are sequential today. Parallel branches and their joins are the one shape
the transition table cannot express, and adding them is the next capability
worth having (L22).

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
