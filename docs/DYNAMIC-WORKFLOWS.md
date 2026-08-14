# Claude Dynamic Workflows output mode

> **Status: preview. Opt-in behind an explicit flag. Not part of v1.**
>
> This mode targets Claude Code's native Workflow runtime, whose authoring API Anthropic deliberately does not document. Most of A.5 and A.6 below is community reverse-engineering, from binary strings and the bundled `/deep-research` script, with no authoritative source to check it against (A.9). The feature has already been through a breaking rename, whose direction is not established (A.9). Emitting against this surface means silent breakage on patch releases.

Claude Code ships a native Workflow runtime that covers similar ground to the hooks architecture by different means. This document records it fully enough to build a compliant emitter, and states the conditions under which one would ship.

Conventions: **§ references** are sections of [`../SPEC.md`](../SPEC.md); **D-numbers** and **§5.1** are in [`DECISIONS.md`](./DECISIONS.md); **L-numbers** are rows of the limitations table in [`../SPEC.md`](../SPEC.md) §6.2. Sections here are numbered A.1 through A.9, and are cited by those numbers from the other documents.

## A.1 Why this is a separate document

A backend is a platform. This is a second way to emit for a platform already supported, so it does not get a backend slot (D23).

The deeper reason is who owns the loop. The Claude Code backend in §3 is built on *mechanism*: matcher scoping, subagent depth, hook lifecycle. Every constraint there was worked around, repeatedly, as §5.1 records. This runtime is a *framework* with policy: no cross-session resume, no filesystem, no module loading, a parser that requires `meta` to be a pure literal. Policy cannot be worked around, only accepted, and when it changes the emitted output breaks with no seam to absorb it.

**What it does genuinely well:** it satisfies the §4.3 zero-idle-footprint contract trivially, by registering no hooks at all, which is the property §3 spends two hooks and a matcher discipline to achieve. It enforces determinism at the runtime level, breaking resume on `Date.now()` or `Math.random()`, which happens to match minflow's own preference. And `parallel()` / `pipeline()` give fan-out that §3 has no equivalent for. These are real advantages and they do not change the conclusion, because cross-session durability is what approval gates need and this mode cannot provide it.

**Why support it at all:** so a user already committed to the native runtime is not locked out, and so the emitter is a known quantity rather than a research project if the runtime stabilises.

## A.2 Conformance: errors, not warnings

This mode supports a strict subset of the IR. Where a graph uses a feature the runtime cannot express, the compiler **refuses to emit** rather than producing something that silently behaves differently.

| IR feature | Supported? | Compiler behaviour |
|---|---|---|
| Cross-session human gate | No (L13) | **Error** |
| Guard requiring shell or filesystem | No | **Error** |
| Non-deterministic helper in the graph | No, it breaks resume | **Error** |
| Free mechanical guard | Becomes a billed model call (L14) | **Warn**, with projected cost |
| Retry-with-counter loop | Yes | OK |
| Fan-out over a list | Yes, and better than §3 | OK |

Warnings are for degradation the user can price. Errors are for semantic loss they cannot see.

## A.3 What the runtime is

A dynamic workflow is a JavaScript script that orchestrates subagents at scale; Claude writes the script for the task you describe, and a runtime executes it in the background while the session stays responsive. Requires Claude Code v2.1.154 or later; available on all paid plans, with Anthropic API access, and on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry.

## A.4 File format

**The `meta` block must be the first statement and a pure literal**, with no variables, spreads, template strings, or function calls inside it.

```js
export const meta = {
  name: 'my-workflow',
  description: 'One line describing the run',
  whenToUse: 'optional',
  phases: [
    { title: 'Research' },
    { title: 'Plan', detail: 'optional', model: 'optional' },
  ],
}
```

The body is plain JavaScript with top-level `await`.

## A.5 Injected globals

Provided by the runtime; not imported.

```
phase(title: string): void
    Display primitive. Groups subsequent agents under a labelled phase
    in the progress tree. Title must match one declared in meta.phases.

agent(prompt: string, opts?): Promise<T | null>
    Spawns one subagent with its own context window.
    opts: { label?, phase?, schema?, model?, effort?,
            isolation?: 'worktree' | 'remote', agentType? }
    Returns null if the user skips it or it hits a terminal API error.
    ALWAYS handle null.

parallel(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
    Scheduling plus a barrier. All results before proceeding.

pipeline<T>(items: T[], ...stages): Promise<any[]>
    Each item flows through every stage independently, no barrier.
    Item A can be in stage 3 while item B is in stage 1.

log(...)      Status output to the progress view.
args          Structured input passed at invocation. undefined if omitted.
budget        Token budget surface.
workflow()    Workflow-level primitive (surface not confirmed).
```

Subagents share no state. Everything passes explicitly through the prompt.

## A.6 Hard rules

| Rule | Consequence of violating |
|---|---|
| `meta` is a pure literal and the first statement | Parser-fatal, fails before the run |
| No `Date.now()`, `Math.random()`, argless `new Date()` | Breaks resume. Pass timestamps via `args` |
| No `import()`, so no module loading | Script fails before the run starts |
| No direct filesystem or shell access from the script | Agents do I/O; the script only coordinates |
| No mid-run user input | For sign-off between stages, run each stage as its own workflow |
| ≤ 16 concurrent agents, 1,000 total per run | Runtime caps |
| ≤ 4,096 items per `parallel()` or `pipeline()` call | Explicit error, not silent truncation |

## A.7 What the emitter produces

No imports means the interpreter is **inlined**, not depended upon. The transition table stays a literal.

```js
export const meta = {
  name: 'my-workflow',
  description: 'Compiled by minflow',
  phases: [{ title: 'Research' }, { title: 'Plan' }, { title: 'Implement' }],
}

// ---- emitted IR ----
const NODES = { /* prompt templates, schemas, agentType per node */ }
const TRANSITIONS = { /* compiled graph, verbatim */ }

// ---- emitted interpreter (~60 lines, inlined) ----
function evaluate(rule, out, ctx) { /* pure, no I/O */ }

// ---- driver ----
let node = args?.resumeAt ?? 'research'
let ctx  = args?.ctx ?? {}
let steps = 0

while (node !== 'done' && steps++ < CEILING) {
  const step = NODES[node]
  phase(step.phase)
  const out = await agent(step.prompt(ctx), {
    schema: step.schema,
    agentType: step.agentType,
    model: step.model,
    label: node,
  })
  if (out === null) break            // skipped or terminal API error
  ctx = { ...ctx, [node]: out }
  node = evaluate(TRANSITIONS[node], out, ctx)
}
return ctx
```

`meta.phases` cannot be computed at runtime, so the compiler derives the phase list from the graph at compile time.

**Guard economics invert here.** With no filesystem or shell access, "does `notes.md` exist" and "do the tests pass" each become an `agent()` call with a boolean schema. NL guards, meanwhile, cost nothing extra, since the model call was happening regardless. A graph tuned for §3 is mistuned for this mode, which is what A.2 exists to catch.

## A.8 Distribution

Place the script in a `workflows/` directory at the plugin root, or point elsewhere with the `workflows` manifest field. Plugin workflows are namespaced by plugin name: a plugin `acme-tools` with a script whose `meta.name` is `release-audit` runs as `/acme-tools:release-audit`. Saved workflows also live in `.claude/workflows/` (project) or `~/.claude/workflows/` (personal); project wins on name collision.

## A.9 Provenance warning

The official documentation deliberately does not document the authoring API. It says to ask Claude to write the script, states you usually do not need to edit it, and points to the Agent SDK TypeScript reference for the full set of options.

Most of A.5 and A.6 comes from community reverse-engineering, binary strings and the bundled `/deep-research` script, not from Anthropic documentation.

**The surface has been renamed at least once, in a breaking way, reported around v2.1.160.** The direction of that rename is not established. The report is community-sourced, and it cannot be reconciled with the names observed at the `2.1.229` baseline, all of which say the surface is called Workflow: the `Workflow` tool stripped from every subagent (L18), the `workflows/` plugin component directory (A.8), and the `CLAUDE_CODE_WORKFLOWS=1` flag some setups still gate the feature behind. What is certain is the instability, not the vocabulary: a name in this document is a name observed at one version, it has changed under a patch release before, and an emitter that hard-codes one is betting on it not changing again.

**Emitting against this surface means silent breakage on patch releases.**

**There is no authoritative published surface.** The Agent SDK TypeScript reference, which the official documentation points to, documents `WorkflowInput`, the Workflow *tool's* input schema, meaning how a workflow is invoked, not the `agent()`, `parallel()`, and `pipeline()` globals available inside a script. No Anthropic documentation describes the authoring API. Everything in A.5 and A.6 is community reverse-engineering with no better source to check it against, which raises rather than lowers the bar for promoting this mode beyond preview.
