# Decision ledger

Every design decision behind minflow, in the order it was taken, including the paths rejected, the dead ends, and the two reversals. Format: **what was decided / what else was considered / why.**

The rejected paths are kept deliberately. A decision is only worth as much as the alternatives it was weighed against, and several of the entries below record something that looked correct, was built or specified, and then failed against a platform fact.

Reading conventions for this document:

- **D-numbers are stable.** They are cited from [`../SPEC.md`](../SPEC.md), from the other documents in this directory, and from comments in the source. They are never renumbered or reused, so a superseded decision keeps its number and carries the correction inline.
- **§ references** are sections of [`../SPEC.md`](../SPEC.md), except §5.1 below, which is part of this ledger.
- **L-numbers** are rows of the known limitations table, [`../SPEC.md`](../SPEC.md) §6.2.
- **A-numbers** are sections of [`DYNAMIC-WORKFLOWS.md`](./DYNAMIC-WORKFLOWS.md).
- Claims marked as measured were established by execution against a pinned Claude Code version; [`VERIFICATION.md`](./VERIFICATION.md) records how.

---

## §5 Decisions

### D1. Prior art on the framing

**Found:** an active blog-level conversation, no papers. Closest: Martin Richards' "Agent Harness Architecture: Skills and Loops"; Nader's "Agent Hooks: Deterministic Control" (completion hook reads a state file and blocks); a DEV post on a deterministic OpenClaw pipeline rejecting "the state machine lives in the LLM's head"; XState's `statelyai/agent` (machine owns control flow, model picks a legal event).

**Concluded at the time:** no formal treatment exists. **Superseded by D19.** This search was for *writing about* the pattern, not for *implementations*. That was a methodological error.

### D2. Loop-as-skill, rejected

**Rejected:** process logic expressed as a natural-language "loop skill."

**Why:** control flow belongs in deterministic code. Natural language for *process* reintroduces exactly what the compiler exists to remove.

### D3. Formalism: Mealy transducer

See §1.3.

### D4. External DSL, rejected

**Rejected:** a purpose-built DSL. Nobody wants to learn one; the cost is a parser, docs, editor tooling, and a learning curve, for no expressive gain.

**Chosen at the time:** an internal DSL, a transition table as plain data in TypeScript. **Refined by D24:** the table survives as the internal representation, but the public surface is an imperative builder rather than a data literal.

### D5. No FSM library dependency

**Considered and rejected, the object-bound school.** These bind the machine to a live model instance and assume in-process lifetime. That is wrong here, because every hook fire is a fresh process: measured against Claude Code `2.1.229`, the dispatcher runs as a fresh `node` process per `SubagentStop`. The candidates:
- **Automat**: its stated premise is an object whose behavior varies with state, and it avoids reified input objects. This design requires reified inputs.
- **finite-state-machine**: decorator-based, subclass and set a state instance variable.
- **friendly_states**: states as classes, transitions as annotated methods.

**Considered, the machine-as-data school:**
- **`transitions` (pytransitions)**: list of dicts, `GraphMachine` for free diagrams. Maintained. Roughly 15% of it would be used.
- **`machinist` (ScatterHQ)**: closest shape: table as data, separate "world" object owning side effects. Likely unmaintained.
- **`automaton` (nazavode)**: single module; injects its transition table into the class docstring so docs stay in sync.
- **`sismic`** (YAML statecharts), **XState** (pure-transition-as-data, TS).

**Chosen:** vendor ~200 lines. The hard part is not the table, it is the guards, predicates over an evolving blob, and no library helps there. Borrow machinist's world/table split, automaton's docstring sync, and `transitions`' Mermaid output.

### D6. Authoring surface

**Chosen:** a TS script that compiles. Never in dispute.

**Rejected:** a hand-writable JSON IR fed to the compiler directly, as a second authoring surface. It cannot coexist with D24 and §1.2, which make the IR a compile target, "not something the user writes."

**Position:** the IR proper is **internal**. It is not a public contract, gets no compatibility promise, and needs no separate validator. Validation stays in the builder, at the offending line, which is what D24 bought.

**The hand-authoring use case is served instead by** a declarative **YAML front-end**, in the Keras sense, a second *front-end* that compiles to the same IR, sitting beside the builder rather than beneath it. Both surfaces produce the IR; neither is the IR. It carries its own diagnostics when built. **Deferred, not v1.** The constraint it places on everything before it: the IR must stay expressible as plain data with no builder-only constructs, which it already is.

### D7. Output artifact: a plugin

**Rejected:** loose hooks for the user to paste in, or smuggling metadata into a shared hooks config to find those entries later.

**Why:** the hooks config is shared mutable state. The user edits it, other plugins append to it, and JSON cannot hold marker comments. That means a three-way reconciler and a "did a human touch this?" heuristic, the class of bug that kills codegen tools.

**Why a plugin:** the compiler owns the directory. Regeneration is `rm -rf && emit`; uninstall is a delete. It also lets a workflow ship its skills, MCP servers, and judge agents as one portable thing, with one narrowing: MCP servers are declared at plugin level, since plugin subagents ignore per-agent `mcpServers` (L16).

### D8. Compiled output: machine as data

**Rejected:** emitting N bespoke hook scripts with logic inlined. Unreadable diffs; a runtime bug forces every user to regenerate.

**Chosen:** thin dispatcher plus `workflow.compiled.json`. Graph changes produce readable JSON diffs; runtime bugs are a version bump.

**Graph hash placement.** On Claude Code it goes in the manifest's free-form `metadata` object, not as a custom top-level field, so `claude plugin validate --strict` stays clean in CI. On Agent Plugins targets the manifest schema is closed, so it goes under `extensions["<our-namespace>"]` (D21). Same hash, two homes.

### D9. Zero idle footprint is a hard requirement

**Stated constraint:** the plugin must not affect in-repo work when no workflow is running.

**Rejected as insufficient:** a dispatcher that wakes on every `Stop`, finds no state file, exits 0. Invisible, but still a process spawn on every turn of every session, forever. Rejected on principle. This forced D12.

Now generalized as a contract every backend must satisfy (§4.3).

### D10. Natural-language guards: kept

**Initial position:** NL criteria conflict with pushing determinism into code.

**Counter-argument, accepted:** a binary criterion read in isolation is the reliable case for a 2026 model, unlike the same criterion buried at line 345 of a skill. This is a small utility library, not a nanny.

**Resolution:** supported, with mechanical guards as the ergonomic default so incentives point right. Judgment quarantined in a leaf predicate returning a typed verdict. Guidance lives in Best Practices, not enforcement.

### D11. State: transient, trace persistent

**Chosen:** an ephemeral state file, never user-managed, stored in `$CLAUDE_PLUGIN_DATA`, plus an append-only trace that survives the run, because "why did this loop review three times?" must be answerable.

**Rejected:** keying that state on `session_id` and garbage-collecting it on `SessionStart`. That works only while a run lives entirely *within one session*, and D17 makes approval gates **segmented across sessions**, with §3.9 promising a parked run "survives the user closing their laptop." Session-keyed state cannot deliver that, in two separate ways:

1. A fresh session's `/approve-plan` computes a new `session_id` and cannot find the parked state.
2. `SessionStart` GC cannot tell a run parked at a gate from an orphan, so the next session start collects the thing the gate exists to preserve.

L4's mitigation refers to "run id", and that is the concept the state design needs: **state keys on a run id**; `session_id` becomes a non-authoritative hint recorded in the trace; and GC collects only state whose status is `running` and whose session is provably gone. State whose status is `awaiting`, with the gate it is parked at named in a separate `gate` field (§3.4), is never collected by session GC and expires on an explicit TTL or user command instead. L3's "SessionStart GC is mandatory" inherits the same narrowing.

The remaining details are open, and they do not block the IR, the evaluator, or the builder. They bind when the Claude Code emitter writes state.

### D12. Dispatch mechanism

Three superseded positions. See §5.1.

### D13. Nested call stack of subagents, rejected

**Considered:** each step spawns the next inside itself.

**Rejected:** the default depth limit is three layers below the main conversation, and at the limit Claude Code withholds the `Agent` tool from every subagent except a fork. That caps the graph at three or four steps by default.

The limit is configurable via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, so a deep stack is technically reachable, but it would make the compiled output depend on a user's environment variable, and the default has changed three times in recent versions (L1). Not a foundation to build on.

**Chosen:** flat runner. Depth stays constant at two whatever the graph does, and on the current default of three layers below main that leaves one layer of headroom for a step to spawn a helper of its own.

Depth 2 is not unconditionally safe. The default was **one** on v2.1.217 and v2.1.218, where a flat runner does not work either unless `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is raised (L1, and [`VERIFICATION.md`](./VERIFICATION.md) records the same). That is one of the three observed defaults, and it is the only one that breaks this design, which is the argument for the flat runner rather than against it: a nested stack is capped on every observed default, and capped silently once the graph is long enough, whereas depth 2 fails on one release pair only, fails immediately, and is restored by an environment variable a preflight check can set.

### D14. Skill-scoped hooks via frontmatter, rejected

**Considered:** hooks in skill frontmatter, scoped to component lifecycle, only running while the component is active. Real feature; would have made the platform do the routing.

**Rejected:** frontmatter is the only mechanism delivering skill-scoping, and it requires editing the user's markdown. That violates the core UX goal.

**Sub-path rejected, vendoring copies of the skills.** Would have avoided mutating user files at the cost of divergence. Dead once frontmatter was ruled out.

**Sub-path investigated, a Skills SDK?** No. Skills must be created as filesystem artifacts; there is no programmatic registration API. Editing means a YAML frontmatter parser (reformats, drops comments) or a byte-level splice. Moot.

### D15. Loose hooks vs one dispatcher

**Decisive facts:** `Stop` has no matcher support and always fires; the `if` field is only evaluated on tool events, and on other events a hook with `if` set **never runs at all**; all matching hooks run in parallel.

**Therefore loose hooks on `Stop`** means N hooks firing every turn in parallel, each asking "is it my turn?", N−1 no-ops, one writer. The switch is not removed; it is copied N times, plus N−1 wasted spawns and a write race.

**What they buy:** the `/hooks` menu lists each entry. Obtainable more cheaply from a `--print` command.

**Rule:** loose hooks where the platform can filter (`SubagentStop` on agent type, `PostToolUse` on tool name, `UserPromptExpansion` on command name); one dispatcher where it cannot.

**Note:** the final design is a dispatcher again, but scoped by matcher rather than guarded by a state check. That resolves the apparent conflict between a single decision point and zero idle footprint.

### D16. Dynamically registered session hooks

**Considered:** registering hooks at run start, tearing them down at the end. Would allow bare skills *and* zero idle footprint.

**Verified: not found.** No documentation for a plugin registering hooks at runtime in interactive Claude Code. The `/hooks` menu lists a session-hooks source, but nothing shows how a plugin populates it; reads as an Agent SDK affordance.

### D17. Approval gates: segmented runs

See §3.9 for the mechanism.

**Rejected:** pausing mid-run. Unavailable, and it would burn a context window waiting.

**Independently confirmed:** Anthropic's own Workflow documentation prescribes the same workaround, no mid-run user input, and for sign-off between stages you run each stage as its own workflow.

### D18. Testing approach

`claude -p` runs headless; the `Setup` event fires with `--init-only`, or `--init`/`--maintenance` in `-p` mode. The transition table needs no model at all.

**Measured against 2.1.229**, two constraints on the testing tooling:

- `--debug` produces **no output at all** on stderr or stdout under `-p`. It also takes an *optional filter argument*, so a trailing positional prompt is silently consumed as the filter and the run dies with "Input must be provided either through stdin or as a prompt argument." Pass the prompt on stdin. The dispatcher's own event log, not `--debug`, is the evidence channel for headless tests.
- `claude plugin validate --strict` covers **the manifest and `hooks/hooks.json` only.** Measured: an agent with `name: bad:name` (which Claude Code refuses to load) plus an unrecognized frontmatter key passed; a skill with no `name` at all passed; a skill whose `name` did not match its directory passed. An invalid hook event key was caught. It also fails on a *missing* `author`, an advisory warning promoted to an error, so the emitter must populate it.

  Consequence: §3.6's build-time validation cannot be delegated to the platform tool. Skill checking is `skills-ref validate`; **agent frontmatter has no platform validator and the compiler must implement its own.**

Three platform tools the compiler should target directly:

- `claude --plugin-dir ./out` loads a plugin for one session with no install step, the tight loop for compiler development.
- `claude plugin validate ./out --strict` for the manifest and hook schema, with the coverage limits above.
- `claude plugin details <name>` prints the component inventory and a projected always-on token cost, which is the honest way to report what a compiled workflow costs before it runs.

Only ergonomics need a human session.

**Regression suite.** The Agent SDK's `query()` takes a `plugins: SdkPluginConfig[]` option that loads plugins from local paths, and a programmatic `hooks` option. Together those let the compiler's own tests emit a plugin, load it, run a graph, and assert against the message stream headlessly, giving a real CI suite rather than a manual `--plugin-dir` check.

### D19. Late discovery: native and third-party implementations exist

**Found, by searching for *implementations* rather than for *writing about* the pattern, which is all D1 looked for:** Claude Code's native Workflow runtime, plus several third-party projects covering substantially this idea.

- **xirothedev/claude-workflow-plugin**: workflows as TypeScript modules, with a runtime building an orchestration plan of agents, schemas, and execution stages. The same authoring model, already built.
- **mbruhler/claude-orchestration**: state persisted so a run dying at step 14 of 15 resumes by loading state, skipping 1–13, and injecting variables; plus routing on natural-language conditions. The same state design and the same NL escape hatch, both validated.
- **barkain/claude-code-workflow-orchestration**: hook-based delegation enforcement with escalating nudges.

**Decision:** no change to the v1 architecture. The hooks design retains cross-session durability, free mechanical guards, and a documented API. The native runtime is recorded as a secondary output mode ([`DYNAMIC-WORKFLOWS.md`](./DYNAMIC-WORKFLOWS.md)).

**Lesson recorded:** everyone converged on subagents as the node type, not skills. minflow's skills-first premise runs against the grain and should be held as a deliberate bet, not an assumption.

### D20. Multi-platform compiler, not a Claude Code tool

**Reframe:** skills, MCP, hooks, and now plugins are all standards. The IR is the asset; backends are platform adapters.

**Why now:** Agent Plugins 1.0.0 gives a portable container for skills and MCP but explicitly does not standardize orchestration or the execution environment. That gap is the product.

**Sequencing:** Claude Code first, because it is where the constraints are best understood and where the hard problems have been solved concretely. Portability is designed for, not deferred.

### D21. Ship against Agent Plugins for the portable parts

**Chosen:** where a platform supports Agent Plugins 1.0.0, emit skills into `skills/` and MCP servers into `mcp.json`, and confine orchestration to a **client extension namespace**, a reverse-domain identifier the project owns, used as a top-level directory (`com.example.workflows/`), an `extensions` key in the manifest, or both. Clients ignore namespaces they do not implement, so one package loads everywhere and only the matching client acts on the orchestration.

**Why:** maximises the portable surface and confines per-platform quirks to one namespace per backend, which is exactly the seam a compiler wants.

**Constraint discovered on reading the spec:** the manifest schema is closed at ten top-level fields, so the graph hash from D8 **cannot** be a custom top-level key. It goes under `extensions["<our-namespace>"]`. An unknown top-level field is reported and ignored rather than fatal, but it is still a schema violation and must not be emitted.

**Also constrained:** generated plugin names must satisfy §2.1's character rules, and MCP configuration cannot be inlined in `plugin.json`. `mcp.json` at the root is the only permitted location.

**Known gaps accepted:** no code signing or provenance verification, and no portable secrets mechanism.

### D22. Track the emerging portable orchestration API

**Observed:** a third party has ported `agent()` / `parallel()` / `pipeline()` to run against Codex, Gemini, and pi, script shape unchanged.

**Decision:** keep the IR close to that shape. If it consolidates, one emitter buys several platforms. A hedge that costs nothing today, not a commitment.

### D23. Dynamic Workflows is an output mode, not a backend

**Rejected:** listing Anthropic's Workflow runtime alongside Codex and Cursor as a peer target.

**Why:** a backend is a platform. Dynamic Workflows is a second way to emit for a platform already supported, and treating it as a peer misrepresents both the product and the effort involved. It also inverted the specification's structure: the Claude Code backend ended up described comparatively, against an alternative, rather than on its own terms.

**Chosen:** the Claude Code backend is the hooks architecture. Dynamic Workflows is a secondary output mode for that backend, opt-in, degraded, documented in [`DYNAMIC-WORKFLOWS.md`](./DYNAMIC-WORKFLOWS.md).

**Why support it at all:** a user already committed to the native runtime should not be locked out, and documenting the emitter now means it is a known quantity if the runtime stabilises. That is the entire justification.

### D24. Imperative builder as the public API; the table stays internal

**Chosen:** a LangGraph-shaped builder (`step`, `edge`, `branch`, `gate`, `entry`, `compile`). The Mealy transition table becomes the compile output and the JSON IR, not the authored artifact.

**Rejected:** exposing the transition table as the public surface. It reads well, but it is an unfamiliar shape, and errors surface as key lookups against a blob rather than at the line that caused them.

**Why the builder:** it matches the mental model anyone arriving from LangGraph already has, so the API costs nothing to learn. It gives validation a natural insertion point, since an edge to an unknown node throws immediately, with a useful stack. And it lets the guard API encode a preference: `when.*` is a library of mechanical predicates, `judge()` is one conspicuous function, which makes D10's "mechanical by default" a property of the surface rather than a line in the docs.

**Accepted cost:** the graph is no longer legible in a single glance. The Mermaid output and `wf.print()` become the primary reading path rather than a convenience (§1.3).

**Accepted risk:** an imperative builder can be driven conditionally, making the compiled graph depend on build-time environment. This is not prevented, it is detected, because the graph hash in the manifest (D8) changes and CI fails on a dirty rebuild.

**No IR change.** §1.4 is untouched by this decision, which is the compiler framing (D20) doing its job: the authoring surface moved and nothing downstream noticed.

### D25. Artifact manifest deleted

**Removed:** the "artifact manifest", a record of files each step touched, carried in state and passed onward.

**Why it existed:** in the D12c architecture a plugin-level `PostToolUse` hook was already registered, so harvesting touched paths cost nothing. It was proposed on that basis alone.

**Why it should have died with D12c:** the final design registers two matcher-scoped hooks and no `PostToolUse`. Per-step scoping needs agent frontmatter, which plugin subagents ignore (L16), and a plugin-level registration matches on tool name only, firing on every file write in every session, a worse D9 violation than the `Stop` hook rejected in D12c.

**Sub-path rejected, a `git status --porcelain` diff inside the dispatcher.** It preserves the manifest without the hook, and it patches a feature instead of re-examining whether the feature is wanted at all.

**Why it was never needed:** every path a guard reads is known when the graph compiles, and the compiler writes it into the step wrapper that will produce it (§3.5), so output paths are assigned rather than discovered. The manifest only added value for undeclared writes, and an undeclared write is one the next step was not told to consume.

**Lesson recorded:** when a decision is reversed, its dependents need re-deriving rather than carrying forward. A feature outlives the architecture that justified it otherwise, and stays plausible because nothing in it looks wrong on its own.

## §5.1 The reversal chain

```
D12a  One plugin-level dispatcher on Stop + state-file pointer
        │  superseded: skill-frontmatter hooks are real and
        │  scoped to the component's lifecycle
        ▼
D12b  Skill-scoped frontmatter hooks (+ vendored skill copies)
        │  KILLED: no touching user markdown. Frontmatter is the
        │  only path to skill-scoping, so both die together.
        ▼
D12c  Back to one plugin dispatcher on Stop
        │  KILLED by D9: a permanent process spawn on every turn
        │  is unacceptable even as a no-op. Stop cannot be filtered
        │  (no matcher, and `if` never runs on non-tool events).
        ▼
D12d  FINAL: steps as subagents, transitions on SubagentStop.
        Matcher-scoped by agent type. Flat runner keeps depth
        constant. Two hooks, both scoped. Zero idle footprint AND
        a single deterministic decision point.
```

**What made the difference each time:** a platform fact assumed rather than checked. D12a assumed hooks were global. D12b assumed frontmatter editing was acceptable. D12c assumed a no-op spawn was invisible enough. D19 assumed no implementations existed because none had been *written about*.
