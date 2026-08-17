# minflow specification

minflow is a workflow compiler for coding agents. The input is a declarative workflow graph. The output is a plugin for a coding agent, which the user installs and runs with one command.

This document specifies the system: the authoring surface, the intermediate representation, the guard model, the portability thesis and platform roadmap, the contract every backend satisfies, the Claude Code backend in full, and the known limitations. Platform behaviour recorded here was measured against Claude Code `2.1.229` and re-confirmed on `2.1.232`; see the verification document for how each claim was established.

Three companion documents carry the rest:

- [`docs/DECISIONS.md`](./docs/DECISIONS.md): the decision ledger. Every path considered, taken or not, with reasons, including the rejected paths and the reversal chain. Decisions are numbered D1 through D25 and are cited from this document by number.
- [`docs/VERIFICATION.md`](./docs/VERIFICATION.md): how the platform claims were established, the pinned Claude Code baseline, and what a reader would re-check against a future release.
- [`docs/DYNAMIC-WORKFLOWS.md`](./docs/DYNAMIC-WORKFLOWS.md): the Claude Dynamic Workflows output mode. Preview, opt-in, outside v1, and largely reverse-engineered rather than vendor-documented. Its sections are numbered A.1 through A.9 and are cited from this document by number.

## How to read this document

- **§1**: what minflow is, and why it is a compiler rather than a Claude Code tool.
- **§2**: the portability thesis and the platform roadmap.
- **§3**: the Claude Code backend. The v1 target, described in full.
- **§4**: the remaining platform backends. Mostly open.
- **§5**: a pointer to the decision ledger.
- **§6**: verification baseline, limitations, resolved and open questions.

---

## §1 What minflow is

A compiler. The input is a declarative workflow graph. The output is a plugin for a coding agent.

### 1.1 The user's experience

1. The user has skills. They wrote them normally. They contain no workflow machinery.
2. The user writes a TS script describing: which skills, in what order, what passes between them, what conditions gate each transition.
3. They run the compiler, selecting a platform.
4. They install the output. One command runs the graph.

The user never edits a hook. The user never edits their skill files. The user never manages state.

### 1.2 Why this is a compiler

The core asset is the **intermediate representation**: a Mealy transition table plus node definitions, expressible as JSON. Everything valuable lives at the IR level and is platform-independent:

- It is testable with no model in the loop.
- A Mermaid diagram generates from it.
- Unreachable states, dead ends, and unguarded cycles become lint checks.
- It survives any one platform going away.

The IR is a compile target, not something the user writes. See §1.3 for the authoring surface and D24 for why they are separate.

Backends are adapters that know one platform's quirks. They are replaceable. The IR is not.

### 1.3 Authoring surface

The formalism is a Mealy transducer: output depends on state *and* input. The user does not write one.

The public API is an imperative graph builder, deliberately shaped like LangGraph, because that is the mental model most people bringing an agent graph already have:

```ts
import { workflow, when, judge, retry, END } from "minflow"

const wf = workflow({ name: "research-and-ship" })

wf.step("research", { skill: "research-topic", model: "haiku",
                      output: { notes: "string", sources: "string[]" } })
wf.step("plan",     { skill: "write-plan" })
wf.step("implement",{ skill: "implement-plan", maxTurns: 25 })
wf.step("review",   { skill: "review-changes" })

wf.entry("research")

wf.edge("research", "plan",       when.fileExists("notes.md"))
wf.gate("plan", "implement",      { command: "approve-plan" })   // human sign-off
wf.edge("implement", "review",    when.exitZero("npm test"),
                                  { otherwise: retry(3, "tests failing") })
wf.branch("review", judge("Are there unresolved findings?"), {
  no:  END,
  yes: "implement",
})

export default wf.compile()
```

`compile()` returns the IR (§1.4). Nothing above is exported as a data literal; the transition table is internal.

**What the builder buys.** Validation fires at the offending line: `wf.edge("reserch", …)` throws on an unknown node with a stack trace, rather than surfacing as a key error in a blob. And `when.*` being a library of mechanical predicates while `judge()` is a single conspicuous function is what makes D10's "mechanical by default" preference structural rather than advisory.

**What it costs.** The graph is no longer visible in one glance, which was the transition table's best property. The generated Mermaid diagram and `wf.print()` therefore move from nice-to-have to the primary way anyone reads a workflow.

Rejected: Moore machine, where output depends on state alone, which is the wrong shape. SCXML and Harel statecharts are correct but heavier than needed; revisit only if hierarchy or parallelism becomes a requirement.

### 1.4 What the IR contains

The IR is the asset, so its contents are stated rather than implied. This is what `wf.compile()` produces (§1.3), not what a user writes. A compiled graph is:

**Node**
| Field | Purpose |
|---|---|
| `id` | Node name, used as the state value |
| `skill` | The user's skill this node invokes |
| `prompt` | Template over the run context, producing the invocation. `{{params.key}}` is fixed at compile time; `{{ctx.node.path}}` reads an earlier step's payload and is legal only when that step **dominates** this one, so the value is present on every route |
| `params` | Scalars interpolated inline |
| `schema` | Optional structured-output contract for the step |
| `model` | Optional per-node model override. **Provider-specific today**, and a known defect: it holds a platform's own model name in the one layer that is supposed not to have platform names in it, and nothing validates it. It should be an agnostic capability tier translated per backend (D28, L23) |
| `maxTurns` | Optional per-step turn ceiling |
| `tools` | Optional tool allowlist for the step. Carries the same leak as `model`, latent only because a tool name is platform-specific too (L23) |
| `phase` | Display grouping |

A node may instead be a **command node**, carrying `kind: "command"` and a `command` template in place of `skill` and `prompt`, optionally with `timeoutMs`. The host runs it rather than spawning a model, and its payload is exactly `{ exitCode, stdout, stderr }` (§3.11).

**Edge**
| Field | Purpose |
|---|---|
| `id` | Stable identity, assigned at compile time. Retry counters are keyed by it, so it has to survive recompilation of an unchanged graph |
| `from`, `event` | The transition key |
| `guard` | Predicate: mechanical, NL, or `always` for an unconditional edge |
| `goto` | Destination on pass. `END` marks a terminal transition |
| `otherwise` | `retry(reason)` or a different node |
| `limit` | Loop ceiling for retry edges |
| `gate` | Optional. Names the resume command for a human sign-off (§3.9). A gated edge ends a run segment rather than continuing |
| `ask` | Optional. Questions to put to the user before continuing, plus the id their answers are recorded under. Unlike a gate, the run resumes by itself (§3.10). Mutually exclusive with `gate` |

**Graph**
| Field | Purpose |
|---|---|
| `irVersion` | Bumped only on a breaking change to the IR types |
| `name` | The workflow's name, which the emitters also derive the plugin name from |
| `entry` | The node a run starts at |
| `nodes`, `edges` | The two tables above, as arrays rather than records: declaration order is load-bearing, since the first edge that could fire wins and that ordering has to survive a JSON round trip |
| `hash` | Hash over the canonical form of everything above. Stamped into run state so a graph edited mid-run is detected rather than silently resumed against nodes that no longer exist (L5) |

Every backend emitter consumes exactly this. A field no backend can express does not belong in the IR; a field only some backends can express is a conformance concern (A.2).

### 1.5 Guards

Mechanical guards (exit code, file exists, tests pass) are the ergonomic default.

Natural-language guards are a first-class escape hatch, quarantined in a single leaf predicate. A judge guard carries a question, the verdict the edge fires on, and optionally the closed set of verdicts the judge is allowed to return. The host asks the question and hands back a verdict; the evaluator compares that verdict to the expected one by exact string equality and routes on the result.

Nothing else crosses the boundary. A verdict that is not a string, or one outside a declared verdict set, is a violated contract: it stops the run with an error rather than routing quietly down `otherwise`. Routing therefore switches on a value from a closed set, so control flow stays deterministic even though the value was produced by a model.

---

### 1.6 Testing a workflow

§1.2 claims a compiled graph is testable with no model in the loop. This is how, and it is a capability the compiler ships rather than something each author builds.

**The generated suite is an artifact.** `minflow test` derives a suite of cases from the graph, writes it under `.minflow/`, and runs it, the way a test runner collects a suite before executing it. The written suite names every case, the decision it targets, and the exact inputs that force it, so nothing implicit decides what gets tested and a reader who wants to know opens the file. `--collect-only` stops after writing, for when you want to look first.

#### 1.6.1 What is derivable, and why it is derivable here

A compiled graph is a control-flow graph, so the standard structural coverage hierarchy applies: node coverage, then edge coverage, then edge-pair, then prime path, then full path coverage, which is infinite once a graph has a cycle.

**Node coverage is already static.** `lintGraph` reports unreachable nodes, dead ends, and cycles that cannot terminate, at compile time and for free. Generated tests are therefore aimed at **edge coverage**, the criterion normally called branch coverage, which is the first one that requires execution.

Automatic test generation over a control-flow graph normally hits a wall: deriving the paths is mechanical, deriving the inputs that force a path is not, because forcing a branch means solving an arbitrary predicate. That is why coverage tools report uncovered branches rather than generating inputs for them.

**minflow does not hit that wall, because guards are data rather than code** (§1.5). Every guard kind is invertible by inspection:

| Guard | Forced true by | Forced false by |
|---|---|---|
| `always` | nothing to force | not falsifiable, and no edge needs it to be |
| `exitZero`, `fileExists` | the synthetic observation | its negation |
| `field(p).equals(v)`, `notEquals` | setting `p` to `v` | any other JSON value |
| `field(p).gt(n)`, `lt(n)` | `n + 1`, `n - 1` | the converse |
| `field(p).truthy()` | any truthy JSON value | `false` |
| `field(p).matches(re)` | a generated string matching `re` | any string that does not |
| `judge(q).is(v)` | the verdict `v` | any other verdict in the declared set |
| `all`, `any`, `not` | a finite boolean assignment over the leaves |

The `matches` row is the only one needing more than arithmetic, and it is a solved problem with an existing library rather than something to write. Generation is seeded so two runs agree, and repetition is capped so a `\d+` does not become sixty digits.

The consequence worth stating: **there is no guard kind minflow cannot force**, so an uncoverable edge means a graph problem rather than a generator limitation, and is reported as such.

#### 1.6.2 The suite

The suite is JSON, written to a scratch directory rather than into the source tree, on the precedent of `target/`, `.pytest_cache` and every other build cache.

It carries the graph hash it was generated against, so a suite run against a changed graph is refused rather than silently testing something else; the seed, so generation is reproducible; and one entry per case. A case names the outcomes it covers, the walk it expects, and, per step, the observations and any answers that force the next transition.

One case is generated per outcome not already covered on the way to another, which keeps cases short and independent. A single long tour would cover the same ground in fewer runs and be a worse test: the first failure would mask everything after it, and nobody could read it. A cycle is entered at most as many times as its retry ceiling allows, which bounds the walk without special-casing loops.

#### 1.6.3 Execution

Running the suite drives the **real emitted dispatcher**, not a simulation of it. Each case replays as hook payloads on stdin with the case's synthetic step outputs, and the run's own trace is then checked against the walk the suite predicted. The trace records `via`, the edge id, on every decision, so a completed run is literally a walk over the transition table and validating it is a graph check rather than string matching.

Two things the harness cannot force, which is why one seam exists. It cannot make an arbitrary shell command exit as it likes, so observations are answered from a file named by `MINFLOW_TEST_OBSERVATIONS`, keyed by node because a fire that drains a command node resolves observations for two nodes at once. And an ask parks the run, so the harness plays the session's part: it relays the marker, writes the answers, and respawns the runner. That drives the real ask rather than putting the workflow into auto mode, which would test a path real users are not on.

This is what makes execution worth its cost over the static lint: it exercises the artifact rather than the graph. Template resolution on a branch nobody took, a delivery obligation the wrong lane satisfies, an ask whose questions the step never produced, a command node whose interpolated path is wrong. Every one is well-formed in the graph and broken in the plugin.

Generation is portable, since it reads only the IR. Execution is per backend, because driving a dispatcher is a backend's business. Claude Code is the only one today.

#### 1.6.4 What it does not test

The harness supplies judge verdicts, so it tests **routing on a verdict** and never **whether a model would return that verdict**. That is the same line every unit test draws around a mock, and it is deliberate: the alternative costs a model call per branch and stops being deterministic.

It also does not test the work. A generated case proves the graph routed, not that any step did anything useful.

#### 1.6.5 Tiers

Two, on the convention every test runner uses for an expensive tier: `go test -short`, `cargo test -- --ignored`, `pytest -m slow`.

- **Free.** No model, no network, deterministic, fast enough for every commit. Everything above.
- **Live**, a separate thing rather than a bigger version of the above. A real run with a real model and no human, which requires the workflow's **auto mode** (§3.13) and turns it on itself: `--auto` is how a smoke run goes unattended, never something the operator types. It costs money, so it warns before it starts, and it runs in a temporary directory so a smoke test cannot leave counterfeit output where real output lives. `minflow test` never does any of this.

## §2 The portability thesis

### 2.1 Everything in this stack is now a standard

Skills, MCP servers, hooks, and now plugins themselves. On 6 August 2026, OpenAI, Microsoft, AWS, Cursor, and Vercel published **Agent Plugins 1.0.0**, a vendor-neutral specification for packaging Agent Skills and MCP server configurations into distributable plugin directories any conformant client can load. Launch clients: ChatGPT, Codex CLI, Cursor, GitHub Copilot, VS Code, and Kiro.

A plugin is a directory, not an archive. `plugin.json` sits at the root; only `$schema` and `name` are required. **The manifest schema is closed**: exactly ten permitted top-level fields (`$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`). Skills live in `skills/`, MCP servers in `mcp.json`. Plugin names are 1–64 characters of `a-z`, `0-9`, `-`, `.`, starting and ending alphanumeric, with no doubled hyphens or periods.

Status is Working Draft, despite 1.0.0 being the published release.

Both wrapped specifications originated at Anthropic. MCP was published November 2024 and donated to the Linux Foundation's Agentic AI Foundation in December 2025; Agent Skills became an open standard the same month and now lives at `agentskills.io`, which the plugin spec defers to for the `SKILL.md` format.

**Anthropic is not on the Technical Steering Committee.** Assume no near-term Claude Code adoption.

### 2.2 What the standard does and does not give a compiler

**Gives:** a portable container for the parts of the output that are already portable, namely the skills a workflow references and the MCP servers those skills need.

**Does not give:** orchestration, and the spec says so directly. v1 defines exactly two component types, skills and MCP servers. Its own design notes state that commands, hooks, agents, rules, and LSP servers are *"too client-specific for a stable portable contract and are outside the v1 format until their formats converge."*

That sentence is the business case. Every mechanism the backends rely on is explicitly out of scope for the portable standard.

Two further gaps: no provenance or code signing, and no portable secret mechanism, the spec stating outright that `env` values and HTTP headers are visible package data and MUST NOT carry credentials.

**This is minflow's position in the market.** The standard covers the nouns. minflow compiles the verbs. Orchestration lives in client-specific extension directories, which the spec explicitly accommodates, and negotiating what goes in each one, per platform, is the whole job.

### 2.3 The authoring model is converging even without a standard

A third party has already ported the `agent()` / `parallel()` / `pipeline()` primitives to run against Codex, Gemini, and pi, with the same script shape running unchanged across backends. That is a de facto portable orchestration API emerging bottom-up.

Two consequences. First, the IR should stay close enough to that shape that emitting to it is mechanical. Second, if it consolidates, the compiler targets one API and gains several platforms at once.

### 2.4 Platform roadmap

A backend is a platform. One IR, one linter, one diagram generator, N emitters.

| Backend | Packaging | Orchestration mechanism | Status |
|---|---|---|---|
| **Claude Code** | Claude Code plugin | `SubagentStop` + matcher-scoped dispatcher | **v1 (§3)** |
| Codex CLI | Agent Plugins 1.0.0 | Open (§4.1) | Planned |
| Cursor | Agent Plugins 1.0.0 | Open | Planned |
| GitHub Copilot / VS Code | Agent Plugins 1.0.0 | Open | Planned |
| Kiro | Agent Plugins 1.0.0 | Open | Planned |

Each backend is expected to need its own investigation of the kind §3 and the decision ledger record for Claude Code. That investigation *is* the work; the IR does not change.

---

### 2.5 Compliance is the goal, not yet the constraint

minflow would rather be Agent Skills and Agent Plugins compliant than not. Both specifications are young enough that complying strictly today would cost capability the design needs, so minflow keeps its own translation layer and negotiates incompatibilities as they surface (D26).

Two concrete examples of what strict compliance would cost:

- **`user-invocable` is not a standard Agent Skills field.** The standard requires `name` and `description`, and permits `license`, `compatibility`, `metadata` and an experimental `allowed-tools`. Its sibling `disable-model-invocation` is documented as a Claude Code extension, so this one very likely is too. Encapsulation is not niche: without it, every internal step of a compiled workflow is a separate public surface, which is the opposite of what a compiled workflow is (§3.12).
- **Most component types are unstandardised.** Agent Plugins 1.0.0 permits exactly two, `skills/` and `mcp.json`. Every component that makes a workflow *run* is outside v1 on every client.

**The test this position is held to.** The acceptable world is one where something is missing from minflow because it is out of spec *and genuinely niche*. The world we have is one where a fundamental encapsulation primitive is out of spec and most of the component surface is unstandardised. Until that inverts, compliance is a direction rather than a constraint.

**What it does not license.** Emitting a violation where the schema is closed. The manifest is ten fields and the graph hash goes under `extensions`, because an unknown top-level key is a violation whether or not a client tolerates it (D21). The translation layer is for what the standard has not reached, never for what it has ruled on.

## §3 The Claude Code backend

The v1 target. Full derivation in the decision ledger, D7 through D17.

### 3.1 Artifact

```
my-workflow-plugin/
  .claude-plugin/
    plugin.json                # manifest: ONLY this file lives here
  hooks/hooks.json             # two registrations
  hooks/dispatch.cjs           # thin entry, calls the runtime. .cjs, not .js, see below
  commands/run-my-workflow.md  # the entrypoint the user types: run-<plugin name>
  commands/approve-*.md        # one resume command per gate, plus its reject
  agents/runner.md             # the dumb executor
  agents/step-*.md             # generated per-step wrappers
  workflow.compiled.json       # the IR
  src/workflow.ts              # source, hand-written
  package.json + lockfile      # optional; see below
```

Two rules the docs are emphatic about. The manifest goes in `.claude-plugin/`, and **every other directory must be at the plugin root, not inside it**. Misplacing them is the most common plugin bug. Paths in manifest fields must be relative and start with `./`; plugins cannot reference files outside their own directory.

**The graph hash goes in `metadata`.** The manifest has a free-form `metadata` object that Claude Code does not read, which is exactly the right home. A custom top-level field would also load, since unrecognized fields are ignored, but `claude plugin validate` reports them as warnings and `--strict` turns them into errors, so `metadata` is the correct choice and `--strict` stays usable in CI (D8).

**The dispatcher must declare its own module type.** Node resolves CommonJS-vs-ESM from the nearest ancestor `package.json`, and a compiled plugin often sits inside the user's repo. Measured during verification: a dispatcher emitted as `dispatch.js` inherits `"type": "module"` from a `package.json` two levels up and dies with `ReferenceError: require is not defined` on every hook fire. Emit the dispatcher as `.cjs` (or ship an explicit `package.json`); never as a bare `.js` that borrows its semantics from whatever encloses it.

**`author` is required in practice.** `claude plugin validate --strict` promotes "no author information" from advisory warning to error (D18), so the emitter must populate it.

**Node dependencies ship for free, conditionally.** If the plugin root has a `package.json` plus `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, or `package-lock.json`, Claude Code installs dependencies into the cache with `--ignore-scripts` and a 60-second timeout. Yarn and pnpm lockfiles are skipped deliberately. So the dispatcher can have real dependencies, provided the emitter ships an npm or bun lockfile and nothing needs a lifecycle script.

**Reload semantics matter during development.** Edits to a `SKILL.md` take effect immediately; changes to `hooks/`, `agents/`, and `.mcp.json` need `/reload-plugins` or a restart.

### 3.2 Runtime architecture

Main conversation spawns one **runner** subagent. The runner spawns each step as a child. Depth stays constant at two layers regardless of graph length.

The runner is a dumb executor. Its entire instruction is: spawn exactly one step, then stop. It makes no routing decisions.

**Exactly two hook registrations:**

```json
{
  "hooks": {
    "UserPromptExpansion": [
      { "matcher": "^my-workflow:(run-my-workflow|approve-plan|reject-plan)$",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.cjs"] }] }
    ],
    "SubagentStop": [
      { "matcher": "^my-workflow:runner$",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.cjs"] }] }
    ]
  }
}
```

The top-level `hooks` wrapper is **required**. Confirmed twice during verification: the working registration has it, and `claude plugin validate` reports schema errors under the path `hooks.<EventName>`.

**The entrypoint needs a command to exist, and the matcher form is not what it looks like.** Registering a bare name such as `run-my-workflow` while emitting no `commands/` directory leaves a hook that can never fire: the plugin installs, looks correct, and does nothing. Measured on 2.1.229:

- A plugin command lives at `commands/<name>.md` in the **plugin root** and is invoked **namespaced by the manifest `name`**. The emitter's default run command is `run-<plugin name>`, so a plugin named `my-workflow` ships `commands/run-my-workflow.md` and the user types `/my-workflow:run-my-workflow`; an emitter option overrides the command name, never the namespacing. The bare `/run-my-workflow` is an unknown command. The namespace is the manifest name, *not* the plugin's data-directory id (which for a `--plugin-dir` load carries an `-inline` suffix).
- The matcher is tested against the hook payload's `command_name`, which is the namespaced form **without** a leading slash: `my-workflow:run-my-workflow`.
- For this event the matcher behaves as a **full match**, not the unanchored search recorded for `SubagentStop`. A matcher of `run-my-workflow` does not fire for `my-workflow:run-my-workflow` even though it is a substring. Anchoring is therefore harmless and correct, but the plugin prefix is mandatory either way.
- The payload also carries `command_args`, `command_source: "plugin"`, and `expansion_type: "slash_command"`, which is how the dispatcher distinguishes a run from a gate resume and picks up arguments.

**A `block` decision means something different on this event, and the difference is total.** On `SubagentStop` a block redirects the runner: the reason becomes the runner's next instruction, which is the actuation channel §3.3 rests on. On `UserPromptExpansion` a block **cancels the expansion**. The reason is printed and the command never reaches the model at all, so a dispatcher that blocks here seeds a run and then strands it, with nothing spawned and nothing to spawn it. Measured on 2.1.229. Neither event's behaviour can be inferred from the other's.

The entrypoint therefore works the other way round. The dispatcher seeds state and renders **no decision**, letting the expansion through, and the **command's own body** is what instructs the conversation to spawn the runner. The body cannot name the first step, because a command file is written at compile time and a resumed run may be parked anywhere, so it tells the runner to stand by. The runner stops, and that `SubagentStop` is redirected into the real step by the mechanism the spike verified. One static command therefore serves both a fresh run and a run resumed at any node.

Both registrations are matcher-scoped. Neither fires during unrelated work, not as a spawn and not as a no-op. This is a hard requirement (D9).

### 3.3 Transition cycle

Starting a segment, whether a fresh run or one resumed at a gate, takes two beats:

1. The command fires `UserPromptExpansion`. The dispatcher seeds or unparks the run's state, marks it as not yet started, and renders **no decision** (§3.2). The expansion proceeds and the command's body tells the conversation to spawn the runner and instruct it to stand by.
2. The runner stands by and stops. `SubagentStop` fires, the dispatcher sees the not-yet-started mark, clears it, and blocks with the instruction to spawn the current node's step. No guard is evaluated on this pass, because nothing has run yet.

Thereafter the cycle repeats:

3. Runner spawns step N, receives its summary, attempts to stop.
4. `SubagentStop` fires, scoped to the runner only.
5. Dispatcher loads state, resolves the observations the graph asks for, and evaluates the transition on step N's output.
6. **Guard fails** → `{"decision":"block","reason":"retry step-N: <reason>"}`
7. **Guard passes** → `{"decision":"block","reason":"Spawn my-workflow:step-N+1 with <params>, inputs at <path>"}`
8. **Verdict needed** → `{"decision":"block", …}` asking the runner for one word from the verdict set. Nothing is evaluated on that pass; the answer arrives on the next stop. A command hook cannot ask a model anything, and hooks matching one event run in parallel rather than in sequence, so a verdict can only be obtained by asking and being called again.
9. **Human gate** → exit 0, no block. Runner stops. State persists with status `awaiting` and the gate's name recorded beside it.
10. **Terminal node** → exit 0, no block. Runner stops. Dispatcher deletes state.
11. **Unroutable run** → exit 0, no block, and the state is written into the trace and then deleted. An errored run left on disk is still a live run: the next stop reloads it, re-evaluates the same failed guard, and errors again, so a single failure is reported twice. There is no resume-from-error path, so the trace is where a failed run's evidence belongs.

A run of a two-step graph therefore traces as `start`, `SubagentStop`, `begin`, `SubagentStop`, `advance`, `SubagentStop`, `end`.

### 3.4 State

- Lives in `${CLAUDE_PLUGIN_DATA}`, which resolves to `<config-dir>/plugins/data/{id}/`, is created on first reference, survives plugin updates, and is deleted when the plugin is uninstalled from its last scope. Never in the user's repo. Two details measured during verification ([`docs/VERIFICATION.md`](./docs/VERIFICATION.md)): the config dir is `$CLAUDE_CONFIG_DIR` when set, not always `~/.claude`; and a plugin loaded with `--plugin-dir` gets the id `{name}-inline`, not `{name}`. Tests must read `$CLAUDE_PLUGIN_DATA` from the hook environment rather than reconstruct the path.
- Not in `${CLAUDE_PLUGIN_ROOT}`: that path changes on every update, and the docs say explicitly not to write state there.
- Keyed by a run id, with `session_id` recorded as a non-authoritative hint. Session-keyed state cannot survive the cross-session gates of §3.9; D11 records the re-derivation, whose remaining details bind when the emitter writes state.
- Holds: the current node; `outputs`, a per-node map of the resolved JSON payload each completed step produced, which is the context later steps interpolate; retry counters keyed by edge id; a step count against the run-wide ceiling; the graph hash; and a status of `running` or `awaiting`, with the gate being awaited in a separate optional `gate` field rather than folded into the status string.
- Does **not** hold assigned output paths. A payload file path is static: the compiler derives it from the guards on a node's outgoing edges and writes it into the step's instructions (§3.5), so there is nothing per-run to record.
- Also carries an optional `host` object, scratch space the evaluator never reads, never writes, and carries through untouched. It exists because some observations cannot be resolved in one pass: a natural-language verdict on this backend has to be asked for and answered on a later hook fire, and the backend needs somewhere durable to record what it already asked. Keeping it opaque is what stops delivery mechanics leaking into the transition function.
- Created by the entrypoint hook, destroyed at the terminal node.
- Survives across sessions, which is what makes segmented approval gates work.
- An append-only transition trace survives the run, for debuggability.
- Orphans garbage-collected on `SessionStart`, narrowed by D11 to `running` state whose session is provably gone. A run whose status is `awaiting` is never collected by session GC; it expires on an explicit TTL or user command instead.

### 3.5 Payload passing

1. **Scalars**: interpolated into the spawn prompt. Free.
2. **Paths**: assigned, never discovered. The compiler reads the guards on a node's outgoing edges, and every path they name becomes an instruction in that step's wrapper telling it where to write. A path is therefore known because the graph chose it at compile time, which is why state carries no path table (§3.4). Guards needing a file-existence check are ordinary shell predicates.

Never parsed out of the transcript, and never harvested from tool calls.

**No artifact manifest.** There is no third tier recording the paths each step touched, populated from a `PostToolUse` hook. Such a record is unnecessary here: an undeclared write is by definition one the next step was not told to consume. D25 records the decision and why the hook it would depend on cannot exist on this backend.

### 3.6 Generated step wrappers

Each node compiles to a subagent file in the plugin's `agents/` directory. The frontmatter is where most of the IR lands:

```yaml
---
name: step-research                 # no colons: reserved for plugin scoping
description: ...
skills: [user-research-skill]       # full skill content injected at startup
model: haiku                        # per-node override; defaults to inherit
maxTurns: 12                        # per-step ceiling
tools: Read, Grep, Glob, Write
---
```

**`skills` is how the user's skills become nodes without being touched.** The field preloads a skill into the subagent's context at startup, injecting the full skill content rather than only the description. The user's file is read, never modified, which is the whole UX premise (D14).

**Build-time validation is required, not optional.** A missing or policy-disabled skill is skipped with only a debug-log warning, so a node would silently run without its instructions. The compiler must check each referenced skill before emitting. Three things to check, all cheap:

- The skill exists and its `name` frontmatter **matches its parent directory name**. The Agent Skills spec requires this, and a mismatch is the most likely reason a reference fails to resolve.
- The frontmatter is valid: `name` and `description` are both required, and `name` must satisfy the portable charset. The standard's reference tool, `skills-ref validate ./my-skill`, checks this too, but the compiler implements the rules in process rather than shelling out, because a required build check that depends on a binary the user may not have installed fails for the wrong reason.
- The skill does not set `disable-model-invocation: true`, which blocks preloading. Note this is a Claude Code extension, not a standard field. The portable frontmatter set is `name`, `description`, `license`, `compatibility`, `metadata`, and the experimental `allowed-tools`.

`checkSkills` performs these checks and is pure, taking the graph and a list of discovered skills; `discoverSkills` is the only part that reads a filesystem. They are separate from `emit`, which is a pure function of the graph and therefore cannot look at a disk to find out whether a skill is really there.

**Preloading moves cost from on-invoke to always-on.** Agent Skills defines three disclosure tiers: name and description (~100 tokens) load at startup, the body (recommended under 5000 tokens) loads on activation, and `scripts/`, `references/`, and `assets/` load only when needed. Preloading via `skills:` injects the full body into the wrapper at startup, so a step pays its skill's whole body on every invocation whether or not it needs all of it. For a large skill, referencing it normally and letting the agent activate it may be cheaper. `claude plugin details` reports the split, and `preloadCost` surfaces it per skill at build time. It reports characters rather than tokens: the guidance is stated in tokens, and counting those needs a tokenizer the package does not ship, so it reports the measure actually taken rather than a guess dressed as a count.

**`model` per node** lets cheap steps route to a smaller model with no user configuration beyond the graph. Resolution order puts `CLAUDE_CODE_SUBAGENT_MODEL` above the frontmatter, so a user-set environment variable overrides the emitted choice.

**Naming constraints, two different rule sets.** A subagent `name` cannot contain `:`, which is reserved for plugin-scoped identifiers; Claude Code refuses to load such a file and logs an error. A plugin subfolder becomes part of the scoped identifier (`agents/review/security.md` → `my-plugin:review:security`), which the matcher in §3.2 must account for.

Skill names are stricter and portable: 1–64 characters, lowercase letters, digits and hyphens only, no leading, trailing, or consecutive hyphens, and matching the parent directory name. Any skill the compiler generates rather than references must satisfy these.

### 3.7 Guards on this backend

Mechanical guards are free: a shell command in the dispatcher, single-digit milliseconds, no tokens.

NL guards compile to native hook types. `type: "prompt"` returns a yes/no decision; `type: "agent"` can use Read, Grep and Glob to verify first. One constraint: all matching hooks run in parallel, so a prompt hook cannot be pipelined into a command hook, and any composition of NL verdict and deterministic routing happens inside a single handler.

Guard inputs come from files on disk or from `last_assistant_message` on `SubagentStop`. The transcript file is ruled out: it is written asynchronously and may lag the in-memory conversation.

Those two are **delivery lanes for the same JSON payload**, not two encodings. Prose is a string field inside it, read by an NL guard, next to the scalar fields a mechanical guard reads. The dispatcher resolves the lane before evaluating, so the evaluator is pure over resolved JSON and cannot branch on delivery. §6.3 records the resolution in full.

### 3.8 MCP servers

Declared once, at plugin level, in `.mcp.json` at the plugin root or inline in the manifest. They start when the plugin is enabled and their tools appear as `mcp__plugin_<plugin-name>_<server-name>__<tool>`.

**Per-step scoping is unavailable.** Plugin-shipped agents ignore the `mcpServers` frontmatter field (L16), so every step sees the same server set. The compiler cannot narrow tools per node this way; use the `tools` and `disallowedTools` fields on the step wrapper instead, which do work and accept MCP patterns such as `mcp__server__*`.

**Scoped names are mandatory in hooks.** A hook targeting the plugin's own bundled server must use the scoped form: tool matchers and `if` fields take the full `mcp__plugin_<plugin>_<server>__<tool>`, and an `mcp_tool` hook's `server` field takes `plugin:<plugin>:<server>`. A matcher written against the bare server key never fires, silently. Relevant if a guard is ever routed through an `mcp_tool` hook rather than a command hook.

**Credentials are a per-backend concern.** On Claude Code, `userConfig` entries marked `sensitive: true` go to the OS keychain and substitute as `${user_config.KEY}` into MCP and LSP configs. They are *rejected* in shell-form hook commands, which read `CLAUDE_PLUGIN_OPTION_<KEY>` from the environment instead. Agent Plugins has no equivalent, since the spec states `env` values and headers are visible package data that must not carry credentials, so portable targets fall back to client-specific stores (D21). The compiler should not attempt a portable secrets abstraction.

**Testing note:** the SDK's `strictMcpConfig` option ignores plugin-provided servers entirely, which is useful for isolating a test run.

### 3.9 Approval gates

Subagents cannot use `AskUserQuestion`, so there is no reliable mid-task approval. A human gate therefore ends a run *segment*: the guard exits 0 without blocking, the runner stops and returns its summary, and state persists with status `awaiting` and the gate's name in its `gate` field. `/my-workflow:approve-plan` is another `UserPromptExpansion` matcher into the same dispatcher, which spawns a fresh runner at the next node. The command must be emitted as `commands/approve-plan.md` and matched in its namespaced form, per §3.2.

**A gate cannot immediately precede `END`.** State records only the node a run is parked at, so "parked before the end" has no representable value: the marker is not a node, and a resume would fail to find it. The builder rejects the combination at the authoring line; a terminal step before the gate expresses the same intent.

Each segment is internally deterministic. Gates are where determinism is supposed to stop. A segmented run holds nothing but a JSON file and survives the user closing their laptop.

### 3.10 Interactive asks

An approval gate ends a run segment and waits for a typed command (§3.9). An
**ask** does not: it puts questions to the user and the run resumes on its own.

The constraint that shapes it is measured, not assumed. A subagent has no
`AskUserQuestion` tool and no channel to the terminal, confirmed by execution on
`2.1.232` (`docs/VERIFICATION.md`, check E). The questions therefore have to
leave the subagent and reach the main session, and the only channel to the
session is the runner's final message.

Three beats:

1. The dispatcher writes `{ runId, workflow, questions, answersPath }` under
   `$CLAUDE_PLUGIN_DATA/asks/`, records `status: "asking"` with the pending ask,
   and **blocks** the runner with an instruction to reply with exactly
   `MINFLOW-ASK <path>`.
2. The runner says that and stops. The dispatcher marks the ask `relayed` and
   renders **no decision**, which is what lets the runner actually stop and puts
   the marker in front of the session.
3. The session, following the protocol emitted into the run command's body,
   reads the file, calls `AskUserQuestion` with the questions verbatim, writes
   the answers to `answersPath`, and spawns the runner again to stand by. That
   stop resumes the run.

`relayed` is load-bearing: beats two and three end at the same event with the
same state, so without it the second stop is indistinguishable from the first
and the ask is raised forever.

Answers are recorded in `outputs` under the ask's own id, defaulting to
`<node>-answers`, so a later step reads them as `{{ctx.<as>.<header>}}`. Because
an ask is an edge rather than a node, that reference is checked with **edge
dominance**: delete the asking edge, walk from the entry, and any surviving route
to the reader is a route where the answers would be missing.

A missing answers file leaves the run parked and reports what to do. An
unparseable one stops the run, because routing on answers nobody can read would
hand the next step a blank where the user's decision belongs.

### 3.11 Command nodes

A node may run a shell command instead of a model. The dispatcher executes it
between two of the runner's stops, records `{ exitCode, stdout, stderr }` as the
node's payload, and evaluates the outgoing edges against that. A chain of them
drains in a single hook fire, so a mechanical check costs no model call and no
round trip.

A non-zero exit is an answer, not a failure: `when.field("exitCode").equals(0)`
is the ordinary guard and an `otherwise` takes the other branch. A command that
could not be spawned or that outlived its `timeoutMs` produced no answer at all,
and that is an error which stops the run.

Two consequences of running inside a hook. Everything in a chain shares the
hook's timeout budget (L2), so long work belongs in a step that shells out. And
a judge guard on an edge leaving a command node is a **compile error**: the
transition is decided with no model in the loop, so the verdict could never be
obtained.

### 3.12 Secondary output mode

Claude Code also ships a native Workflow runtime, which can serve as an alternative output for this backend. It is opt-in behind an explicit flag, degrades several IR features, and refuses to compile graphs whose semantics it cannot preserve.

It is not part of the v1 build. See [`docs/DYNAMIC-WORKFLOWS.md`](./docs/DYNAMIC-WORKFLOWS.md) for the rationale, the full authoring reference, and the conformance rules.

---

### 3.13 Auto mode

A compiled workflow runs unattended when started with `--auto` on its entry command. Every workflow gets this; it is not something an author builds.

**What changes.** An ask (§3.10) is not relayed to the session. Instead the dispatcher blocks the runner with the questions and their options and takes the answers from its reply, which is the judge round trip of §3.3 step 8 carrying a JSON object rather than one word. No `AskUserQuestion` dialog is raised and nothing waits for a human.

An answer naming an option that was never offered is replaced with the first option and the substitution is recorded. A smoke run that stalls on its own invented answer has defeated its purpose.

**What does not change: a gate is a wall.** An ask exists because the workflow needs a fact it cannot derive, and inventing one is a reasonable thing to do unattended. A gate exists because a human has to look at something, and a mode that removes the human from the one mechanism whose entire purpose is human judgment would make gates meaningless. Auto mode reaching a gate ends the run there and says so. A workflow that cannot be smoke tested without passing a gate has told you the gate is in the wrong place.

**Why an argument rather than an environment variable.** It appears in the command's `argument-hint` and in the session transcript, so a run that was auto is visible in its own scrollback. An environment variable is invisible in exactly the situation where you most need to know which answers were real.

**It is loud on purpose.** Every synthesized answer goes into the trace with its question, and the run's final report leads with the fact that the answers were invented. An auto run produces real artifacts from fabricated inputs, and the only thing standing between that and a counterfeit is that it says so everywhere.

## §4 Remaining backends

Open. Each needs the investigation §3 records for Claude Code: what the packaging layer is, what the orchestration seam is, and which platform quirks the emitter has to absorb.

### 4.1 Codex CLI

Packaging is settled, on Agent Plugins 1.0.0, with Codex CLI shipping plugin installation shortly after the spec landed. Orchestration is open. Two candidate seams: the ported `agent()` API (§2.3), or Codex-native hooks if a comparable lifecycle surface exists.

### 4.2 Cursor, GitHub Copilot, VS Code, Kiro

Packaging settled via Agent Plugins. Orchestration unexamined.

### 4.3 What every backend must supply

The contract a backend emitter satisfies:

| Requirement | Why |
|---|---|
| An entrypoint the user invokes | Starts a run |
| A deterministic decision point after each step | Where the transition table is evaluated |
| Somewhere to persist state between steps | Node pointer, retry counters, step count, and each completed step's resolved payload, which later steps interpolate. Payload file paths are not among them: they are compile-time constants (§3.5). Note: Agent Plugins guarantees `PLUGIN_DATA` only to stdio MCP subprocesses, not to arbitrary plugin-provided executables, so each backend must confirm its own writable location |
| Zero footprint when no run is active | D9, a hard requirement rather than a preference |
| A channel to direct the next step | Actuation |

A platform lacking any of these cannot host a backend without a workaround, and the workaround belongs in the ledger.

---

## §5 Decision ledger

The ledger is its own document: [`docs/DECISIONS.md`](./docs/DECISIONS.md). It records D1 through D25 in the format *what was decided, what else was considered, why*, including the rejected paths, the dead ends, and the reversal chain that produced the dispatch mechanism (§5.1 there).

D-numbers are stable. They are cited from this document, from the other documents in `docs/`, and from comments in the source, so they are never renumbered or reused.

---

## §6 Verification baseline, limitations, open questions

### 6.1 Verification baseline

The platform behaviour §3 depends on was measured by execution against `2.1.229 (Claude Code)` on 12 and 13 August 2026, macOS 24.5.0, Node 26.3.0. Four load-bearing assumptions were checked: that a plugin-provided subagent can spawn one child, that `SubagentStop` fires for an anchored plugin-scoped matcher, that a skill preloaded through the `skills:` frontmatter field reaches the step's context intact, and that a `block` decision on `SubagentStop` redirects the runner. All passed, with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` unset.

The version matters. L1 records that the subagent spawn depth default changed three times across patch releases, so "it worked" is only meaningful with a version attached.

[`docs/VERIFICATION.md`](./docs/VERIFICATION.md) holds the full log, sorted by how each claim was established, plus what a reader would re-check against a later release.

### 6.2 Known limitations

Scope column: **CC** = Claude Code backend, **All** = every backend, **DW** = the Dynamic Workflows output mode only ([`docs/DYNAMIC-WORKFLOWS.md`](./docs/DYNAMIC-WORKFLOWS.md)).

| # | Limitation | Scope | Mitigation |
|---|---|---|---|
| **L1** | Subagent spawn depth default has changed three times: five layers and unchangeable on v2.1.172–2.1.216, one on v2.1.217–2.1.218, three from v2.1.219. Now settable via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. | CC | The flat runner needs depth 2, so only the v2.1.217–218 default breaks it. Preflight and set the variable. §6.1 |
| **L2** | A timed-out `command`, `http` or `mcp_tool` hook is canceled, output discarded, no decision rendered. Prompt hooks default to 30s, agent hooks to 60s. | CC | Keep the dispatcher fast; detect stall against a completed-run marker |
| **L3** | On `StopFailure`, output and exit code are ignored. | CC | `SessionStart` GC is mandatory |
| **L4** | Cross-session artifact collision: session-keyed state does not stop two runs writing the same repo files. | All | Scope artifact directories by run id |
| **L5** | Graph drift mid-run: recompiling leaves state pointing at dead nodes. | All | Stamp graph hash into state; refuse to resume on mismatch |
| **L6** | `disableAllHooks` silently stops routing. | CC | Detect at entrypoint and say so |
| **L7** | The runner is a compliance dependency: actuation runs through prose, so a paraphrased param silently diverges the graph. | CC | Three-line runner prompt forbidding all but spawning; next step verifies received params. Detection, not prevention |
| **L8** | Guards cannot see inside a step; `SubagentStop` fires once at the end. | CC | Out of scope for v1, and **the obvious fix is closed**: per-step `PostToolUse` circuit breakers would need frontmatter hooks, which plugin agents ignore (L16). A mid-step breaker would have to be a globally-registered hook, which D9 forbids |
| **L9** | Steps run in isolated context; only final summaries are visible. | All | `statusMessage` on hooks provides progress UI |
| **L10** | Hook output capped at 10,000 chars; overflow written to file and replaced with a preview and path. | CC | Aligns with path-passing anyway |
| **L11** | Agent Plugins 1.0.0 standardizes packaging only, not permissions, execution, provenance, or secrets. | All | Orchestration lives in client-specific directories by design (D21) |
| **L12** | Orchestration seam unknown on every non-Claude-Code platform. | All | Each backend needs its own investigation (§4.3) |
| **L16** | Plugin agents support only `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, and `isolation` (worktree only). `hooks`, `mcpServers`, and `permissionMode` are unsupported for security reasons. **No per-step hook scoping exists for plugin-shipped agents.** | CC | The two registrations in §3.2 are unaffected: they live in `hooks/hooks.json`, and plugin hooks do fire inside subagents. But any *per-step* hook must instead be work the dispatcher does at `SubagentStop` (see §3.5), or it leaks globally. Per-step MCP servers and permission modes are simply unavailable; declare servers at plugin level |
| **L21** | Preloading a skill via the `skills:` field converts its body from on-invoke to always-on cost for that step, every invocation. | CC | Compiler surfaces the estimate; for large skills, prefer normal activation over preloading |
| **L20** | Generated plugins ship enabled by default. `defaultEnabled: false` is available to ship one that installs disabled, requiring `claude plugin enable`. | CC | Consider defaulting compiled workflows to disabled, since D9's inertness argument extends to installation |
| **L23** | `model` and `tools` hold provider-specific names in a provider-agnostic IR, and neither is validated, so a misspelled model compiles clean and produces an agent naming a model that does not exist. A second backend cannot read such a graph without understanding the first provider's product line. | All | Known and deliberate for now (D28). Should become an agnostic tier, `small` / `medium` / `large`, translated by each backend, with exact pinning moved to `EmitOptions` where every other platform fact lives. The enum also buys the compile-time validation the free string cannot have. Mitigated meanwhile by declaring tiers once at the call site rather than per step |
| **L17** | Claude Code scans every subagent's final report and may prepend a `[harness: ...]` marker line or insert backslashes into instruction-shaped text. | CC | Guards reading `last_assistant_message` must tolerate a prepended marker line; prefer structured output or files |
| **L18** | The `Workflow` tool is stripped from every subagent, alongside `AskUserQuestion` and `EnterPlanMode`. Measured for `AskUserQuestion` on `2.1.232`. | CC | A step cannot launch a dynamic workflow. It also cannot ask the user anything directly, which is what §3.10's three-beat relay exists to work around |
| **L19** | Concurrent subagent limit of 20 per session; resumes take a fresh slot without checking it. | CC | Sequential runner stays well under. Relevant only if fan-out is added |
| **L22** | Run state carries exactly one current node, so a graph is sequential: no fan-out, no join, no concurrent branches. Independent work that could run at once runs one node after another. | All | None today. Generalizing the IR to broader graph shapes, parallel branches and their joins, is a desirable next step: the transition table already expresses selection, iteration and termination, and concurrency is the one shape missing. It touches run state, the evaluator's single-node assumption, `lintGraph`'s reachability and termination proofs, and every backend's runner. L19's subagent cap becomes live the moment it lands |
| **L13** | No cross-session resume; exiting mid-run starts fresh. | DW | None. See [`docs/DYNAMIC-WORKFLOWS.md`](./docs/DYNAMIC-WORKFLOWS.md) |
| **L14** | No filesystem or shell access from a workflow script, so mechanical guards cost a model call each. | DW | Route guard agents to a cheap model |
| **L15** | Workflow authoring API largely undocumented and already renamed once. | DW | Keep it a preview. There is no authoritative published surface to read instead (A.9) |

### 6.3 Resolved and open questions

**Guard input surface, settled, and the question was miscut.** It asked whether steps emit a structured block *or* guards evaluate free prose. That is a false dichotomy, and it conflated two independent things.

- **The payload is always JSON.** There is no unstructured alternative.
- **Prose is a value, not a channel.** A free-prose blob is a string field inside that JSON, alongside scalar fields. An NL guard reads a prose field; a mechanical guard reads a scalar field. Same envelope, and the choice of criterion is per step: a step may have both.
- **The only delivery lever is where the JSON lives:** inline in what is passed between steps, or in a file. This is not a new axis; it is §3.5's two-tier payload rule applied to guard inputs, and a file is no less a contract than an inline block.

Consequence for the implementation: the dispatcher resolves inline-or-file into a value *before* evaluation, so the transition evaluator is a pure function over resolved JSON with no code path that can branch on delivery. Parity between the two is structural rather than tested-for.

Caveat, semantic parity only: the inline lane inherits L10's 10,000-character output cap and L17's marker-line and backslash mangling. Same verdict from the same value, but the inline lane can lose or corrupt the value first.

**Skills as nodes, resolved by execution.** The `skills` frontmatter field preloads full skill content into a generated wrapper at startup, without modifying the user's file (§3.6). The end-to-end run confirms the body arrives and is usable: the child's tools were narrowed to `Glob`, which can list paths but cannot read file contents, so the step returning the marker string proves the body was injected into its context rather than looked up from disk. What remains is narrower than "behaves identically": a preloaded skill's *instructions* are in context, but nothing was tested about its `scripts/`, `references/`, or `assets/` tiers, which progressive disclosure loads on demand.

**A reason string beside a judge's verdict. Proposed, unimplemented.** A natural-language guard could return a typed verdict *plus* a free-text reason, with the reason recorded in the trace, so that "why did review loop three times" is answerable from the trace alone. Nothing implements it: there is no reason field on the judge guard in the IR, none in the evaluator, and none in the trace. It stays on the table because it is purely additive: no routing would depend on it, so adding it later changes what a run records and not how it moves.

**Codex orchestration seam.** Open. §4.1.

### 6.4 Verification log

The log lives in [`docs/VERIFICATION.md`](./docs/VERIFICATION.md), grouped by how each claim was established: Claude Code documentation, the Agent Plugins 1.0.0 specification, the Agent Skills specification, primary reporting, execution against the pinned version, the claims searched for and not found, the claims that are documentation-derived but were never logged individually, and the claims that remain community-reported or assumed. That list is the order of the log, and provenance weakens as it runs.
