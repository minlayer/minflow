# Verification

How the platform claims in [`../SPEC.md`](../SPEC.md) were established, and what a reader would re-check against a later Claude Code release.

Every claim about Claude Code, Agent Plugins, or Agent Skills behaviour falls into one of these buckets, and the log below is sorted in exactly this order on purpose:

1. read from Claude Code documentation,
2. read from the Agent Plugins 1.0.0 specification,
3. read from the Agent Skills specification,
4. read from primary reporting,
5. measured by execution against a pinned version, in the nesting spike and then the entrypoint probe,
6. searched for and not found, which is a result rather than a gap,
7. documentation-derived but never logged individually here, weaker than anything read or measured above it,
8. community-reported and not documentation-confirmed,
9. still assumed.

The design leans hardest on the measured group, because those are the claims where the documentation was either silent or wrong.

Conventions: **§ references** are sections of [`../SPEC.md`](../SPEC.md); **D-numbers** are entries in [`DECISIONS.md`](./DECISIONS.md); **L-numbers** are rows of the limitations table in [`../SPEC.md`](../SPEC.md) §6.2; **A-numbers** are sections of [`DYNAMIC-WORKFLOWS.md`](./DYNAMIC-WORKFLOWS.md).

## Baseline

```
claude --version   2.1.229 (Claude Code)
platform           macOS 24.5.0
node               26.3.0
dates              12 August 2026 (nesting spike), 13 August 2026 (entrypoint probe)
```

All six spike checks pass with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` **unset**, on the v2.1.219+ default of three layers below main, so the flat runner's depth of 2 has one layer of headroom.

The version is part of the claim. L1 records that the subagent spawn depth default changed three times across patch releases, five layers on v2.1.172 through v2.1.216, one on v2.1.217 and v2.1.218, three from v2.1.219, so "it worked" means nothing without a version attached.

## The harness is not part of this repository

Both measurements ran from a local development harness: a minimal Claude Code plugin plus a shell driver. That harness is deliberately not shipped, is excluded by `.gitignore`, and nothing in this repository invokes it. This document therefore describes what it did and what it found, rather than telling a reader to run it. Re-deriving the claims means rebuilding an equivalent minimal plugin; the shape needed is described below.

## The nesting spike

Four load-bearing assumptions, asserted as six individual checks:

| | Assumption | Relates to |
|---|---|---|
| **A** | A plugin-provided subagent can spawn a child subagent, depth 2 | L1, D13, §3.2 |
| **B** | `SubagentStop` fires for an anchored, plugin-scoped matcher | §3.2 |
| **C** | A skill preloaded via the `skills:` frontmatter field reaches the child's context | §3.6, D14 |
| **D** | A `{"decision":"block","reason":...}` on `SubagentStop` redirects the runner | §3.3, L7 |

**How it ran.** A minimal plugin was loaded for a single session with `claude --plugin-dir`, so nothing was installed and nothing persisted. It was validated first with `claude plugin validate --strict`, then one graph was run headless under `claude -p` with the prompt supplied on stdin, and the assertions were made against an event log that the dispatcher appended to `$CLAUDE_PLUGIN_DATA`. The log, not the console, is the evidence: each line records which `agent_type` reached the hook and what its last message was.

**Plugin shape.** A manifest at `.claude-plugin/plugin.json` and nothing else in that directory; `agents/runner.md`, which spawns one child and stops; `agents/step-one.md`, which preloads a marker skill and reports its token; `skills/<marker-skill>/SKILL.md` containing the marker string; `hooks/hooks.json` with anchored `SubagentStop` matchers; and `hooks/dispatch.cjs`, which logs every event and redirects the runner once.

**Result: passed 12 August 2026 on `2.1.229`, six of six, three consecutive runs.** Findings are in the log below, under "verified by execution".

**Check D is the one with no workaround.** If a `block` decision on `SubagentStop` does not redirect the runner, the actuation channel §3.3 rests on does not exist and the design needs rethinking. A, B and C all have fallbacks; D does not.

**Check C was tightened after the first green run.** The child's `tools` was narrowed to `Glob`, which cannot read file contents, so returning the marker proves the skill body was injected rather than looked up from disk.

**Four harness bugs had to be fixed before the platform was reached at all**, and each would have read as a design failure if it had not been chased down:

- ESM/CJS module-type inheritance: the dispatcher emitted as `.js` inherited `"type": "module"` from an ancestor `package.json` and died with `ReferenceError: require is not defined` on every hook fire (§3.1).
- A hard-coded `~/.claude` data path: the config directory is `$CLAUDE_CONFIG_DIR` when set (§3.4).
- A `{name}` versus `{name}-inline` plugin id: a `--plugin-dir` load gets the `-inline` suffix, so `$CLAUDE_PLUGIN_DATA` must be read from the hook environment rather than reconstructed (§3.4).
- `--debug` swallowing the trailing positional prompt, because it takes an optional filter argument (D18).

## The entrypoint probe

The spike proved the transition cycle; it did not prove that a user can start a run. The probe closed that gap by measuring how a plugin command is named and what `UserPromptExpansion` matches against.

**How it ran.** A command file at `commands/<name>.md` plus a probe hook that dumped the entire `UserPromptExpansion` payload to a log, so the payload shape was read rather than guessed. Invocation forms were then tried one at a time against the same plugin, loaded again with `--plugin-dir`, and matched against several matcher spellings.

**Result: measured 13 August 2026 on `2.1.229`.** The namespace is the manifest `name`, not the plugin's data-directory id; the matcher is a full match against `command_name` for this event, unlike the unanchored search `SubagentStop` uses; and `claude plugin validate --strict` does not look at `commands/` at all. Details in the log below.

## Re-deriving these claims against a later release

The version-sensitive claims, and what confirming each one requires:

- **Spawn depth (L1, check A).** Confirm that a plugin-provided subagent can spawn one child with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` unset. If it cannot, set the variable and re-run; the flat runner needs depth 2 only. If spawning is impossible entirely, the fallback is main-thread orchestration with per-step `SubagentStop` hooks that block the step and dictate its exact final message: the decision stays deterministic, only the relay is prose.
- **Matcher semantics (checks B, and the probe).** Matcher behaviour is per-event, not global. Confirm that `SubagentStop` still evaluates its matcher unanchored against the agent type, and that `UserPromptExpansion` still full-matches `command_name` in its namespaced, slash-free form. Anchoring both is correct either way.
- **Actuation, per event (check D, and the first end-to-end run).** Confirm that a `block` with a `reason` on `SubagentStop` still redirects the runner rather than merely stopping it, and, separately, that a `block` on `UserPromptExpansion` still cancels the expansion rather than instructing. The two are opposite in effect and neither can be inferred from the other. Read the ordering out of an event log: runner stops idle, dispatcher blocks, the named child appears, runner stops again and is allowed to finish.
- **Preloading (check C).** Confirm that the `skills:` frontmatter field still injects the full skill body. Verify it with a tool set that cannot read files, or the check proves nothing. A failure here most likely means the skill's frontmatter `name` no longer matches its parent directory name, which the Agent Skills specification requires.
- **Validator coverage (D18).** Confirm what `claude plugin validate --strict` still covers. As measured it reaches the manifest and `hooks/hooks.json` only, which is why agent frontmatter validation lives in the compiler.
- **Plugin data location (§3.4).** Confirm that `$CLAUDE_PLUGIN_DATA` is present in the hook process environment, and read it from there rather than reconstructing a path from the config directory and plugin id.
- **Headless evidence channel (D18).** Confirm whether `--debug` prints anything under `-p`. As measured it prints nothing, so a dispatcher-written event log is the evidence channel for headless tests, and the prompt goes in on stdin.

## Verification log

**Verified against Claude Code documentation:**
- `Stop` has no matcher support and always fires
- `if` is only evaluated on tool events; elsewhere a hook with `if` never runs
- All matching hooks run in parallel
- Hooks can be defined in skill and subagent frontmatter, scoped to component lifecycle
- `SubagentStop` matches on agent type and accepts plugin-scoped names
- `UserPromptExpansion` fires when a user-typed command expands into a prompt, before it reaches Claude, can block the expansion, and **matches on command name**, which is the §3.2 entrypoint. `UserPromptSubmit`, by contrast, has no matcher and always fires, so it is unusable under D9
- Subagent `Stop` hooks are converted to `SubagentStop`
- Nesting depth cap: three layers below main; Agent tool withheld at the limit except forks
- `${CLAUDE_PLUGIN_DATA}` persists across plugin updates
- `type: "prompt"` and `type: "agent"` hooks exist; 30s and 60s default timeouts
- Timed-out hooks render no decision; `StopFailure` ignores output and exit code
- `additionalContext` capped at 10,000 chars, overflow written to file
- `last_assistant_message` is the correct source for final assistant text
- Skills have no programmatic registration API
- Subagent frontmatter fields including `skills` (preloads full skill content), `model`, `maxTurns`, `tools`, `disallowedTools`, `isolation`, `background`, `effort`
- `AskUserQuestion`, `EnterPlanMode`, `Workflow`, `EndConversation`, `ScheduleWakeup`, `TaskOutput`, `WaitForMcpServers` are stripped from every subagent
- Plugin subagents ignore `hooks`, `mcpServers`, and `permissionMode`
- Subagent `name` cannot contain `:`; plugin subfolders become part of the scoped identifier
- `SubagentStop` matcher is the frontmatter `name`, or the plugin-scoped identifier, evaluated unanchored, so anchor with `^...$`
- Subagent spawn depth: default three below main, settable via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; defaults were five (v2.1.172–2.1.216), one (v2.1.217–2.1.218), three (v2.1.219+)
- Concurrent subagent limit of 20 per session
- Subagent output scanning may prepend a marker line or insert backslashes into the final report
- Subagents run in the background by default as of v2.1.198, with a reduced built-in tool set
- Plugin manifest lives at `.claude-plugin/plugin.json`; every other component directory must be at the plugin root
- The manifest is optional; `name` is the only required field when present
- Free-form `metadata` object is available for author data and is not read by Claude Code
- Unrecognized top-level fields load but are warnings; `claude plugin validate --strict` fails on them
- Manifest path fields must be relative and start with `./`; plugins cannot reference files outside their directory
- `${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/{id}/`, survives updates, deleted on final uninstall
- `${CLAUDE_PLUGIN_ROOT}` changes on update and must not hold state
- Node dependencies auto-install from `package.json` plus an npm or bun lockfile, with `--ignore-scripts` and a 60s timeout; yarn and pnpm lockfiles are skipped
- Plugin agent frontmatter field list, and the exclusion of `hooks`, `mcpServers`, `permissionMode`
- `AgentDefinition` in the Agent SDK confirms the same field set, and states that preloading uses `skills` rather than listing `Skill` in `tools`
- `getContextUsage()` returns per-skill token attribution, which is the measurement path for L21
- `workflows/` is a recognized plugin component directory
- `defaultEnabled: false` ships a plugin installed but disabled
- Tooling: `claude --plugin-dir`, `claude plugin validate --strict`, `claude plugin details`, `/reload-plugins`
- Workflow runtime: v2.1.154+, background execution, `agent()`/`pipeline()`, `args` as structured data, `schema` option, plugin `workflows/` directory with namespaced invocation, no mid-run user input, no module loading, no filesystem or shell access from the script, 16 concurrent / 1,000 total caps, resume within session only

**Verified against the Agent Plugins 1.0.0 specification:**
- Closed manifest schema, ten permitted top-level fields, `$schema` and `name` required
- Plugin name constraints (1–64 chars, `a-z 0-9 - .`, alphanumeric ends, no doubled separators)
- Fixed component locations: `skills/` and `mcp.json`; MCP cannot be inlined in `plugin.json`
- Exactly two portable component types; commands, hooks, agents, rules, and LSP servers are explicitly outside v1
- Client extensions are reverse-domain namespaces, as a manifest `extensions` key, a top-level directory, or both
- `PLUGIN_ROOT` and `PLUGIN_DATA` are guaranteed only to stdio MCP subprocesses
- No portable secrets mechanism; `env` values and headers are visible package data
- Status is Working Draft

**Verified against the Agent Skills specification:**
- A skill is a directory with `SKILL.md` plus optional `scripts/`, `references/`, `assets/`
- Frontmatter fields: `name` and `description` required; `license`, `compatibility`, `metadata`, and experimental `allowed-tools` optional
- `name`: 1–64 chars, lowercase alphanumeric and hyphens, no leading/trailing/consecutive hyphens, **must match the parent directory name**
- `description`: 1–1024 characters
- `metadata` is a string-to-string map for client data
- Progressive disclosure: ~100 tokens at startup, body under 5000 tokens recommended on activation, resources on demand; body under 500 lines
- File references should stay one level deep from `SKILL.md`
- `skills-ref validate ./my-skill` is the standard validation tool
- `disable-model-invocation` is a Claude Code extension, not a standard frontmatter field

**Verified against primary reporting:**
- Agent Plugins 1.0.0 published 6 August 2026 by OpenAI with AWS, Microsoft, Cursor, and Vercel; packages Agent Skills and MCP; `plugin.json` at root with `$schema` and name; launch clients ChatGPT, Codex CLI, Cursor, GitHub Copilot, VS Code, Kiro; packaging standardized but not permissions or execution; provenance and secrets deferred; TSC has no Anthropic seat

**Verified by execution, the nesting spike, `2.1.229`, 12 August 2026:**
- A plugin-provided subagent spawns a child: depth 2 works on the default depth cap, variable unset
- `SubagentStop` fires for an anchored plugin-scoped matcher `^spike:runner$`
- `$CLAUDE_PLUGIN_DATA` is present in the hook process environment
- `{"decision":"block","reason":...}` on `SubagentStop` **redirects the runner**. The log orders it: runner stops idle, dispatcher blocks, the named child appears, runner stops again and is allowed to finish. This is the actuation channel §3.3 rests on, and the check with no workaround
- A skill preloaded via `skills:` reaches the child intact. Proven, not inferred: the child's `tools` was narrowed to `Glob`, which cannot read file contents, and it still returned the marker
- `last_assistant_message` is populated on `SubagentStop` for both runner and step, and no `[harness: ...]` marker line (L17) appeared in three events
- The redirect is **invisible to the parent conversation**: the main agent reported the runner "didn't actually wait," having seen only a final summary. Evidence for L9, and a caution for L7, since the parent cannot observe compliance
- The dispatcher runs as a fresh `node` process per event, which is what D5 rests on

**Verified by execution, the entrypoint probe, `2.1.229`, 13 August 2026 (§3.2):**
- A plugin command at `commands/<name>.md` is invoked as `/<manifest-name>:<name>`. Bare `/<name>` and the data-dir id form `/<name>-inline:<name>` are both "Unknown command"
- `UserPromptExpansion` fires for it and its payload carries `command_name` (namespaced, no leading slash), `command_args`, `command_source: "plugin"`, `expansion_type: "slash_command"`, plus `session_id`, `cwd`, and `prompt`
- Its matcher is a **full match against `command_name`**: `^spike:spike-run$` fires, `^spike-run$` does not, and unanchored `spike-run` does **not** fire despite being a substring. This differs from the unanchored behaviour recorded above for `SubagentStop`, so matcher semantics must be treated as per-event rather than global
- `claude plugin validate --strict` does not validate `commands/` either, consistent with it covering only the manifest and `hooks.json`

**Verified by execution, the first end-to-end run, `2.1.229`, 13 August 2026 (§3.2, §3.3):**
- A `block` decision on `UserPromptExpansion` **cancels the command's expansion** and prints the reason. It does not hand the conversation an instruction, which is what the same decision does on `SubagentStop`. A dispatcher that blocks here seeds a run and strands it: nothing is spawned, and nothing remains that could spawn it. Measured after an implementation assumed the two events behaved alike
- Letting the expansion through instead puts the command's **body** in front of the model, which is what starts a run. Corroborated twice: the entrypoint probe's command body came back verbatim when its hook exited 0, and the run command's body spawns the runner
- A full two-step graph then runs to completion under the transition table. The trace reads `start`, `SubagentStop`, `begin`, `SubagentStop`, `advance` (`draft` to `check` via edge `draft:1`), `SubagentStop`, `end`, and the run's state file is deleted at the terminal node
- The parent conversation cannot see any of this. It reported that the wrong step had run and that the runner had ignored its instruction, while the trace showed both steps running in order. That is the third time a parent has misread a run it could not see inside, and it is L9 behaving exactly as documented rather than a defect

**Searched for and not found:**
- Runtime hook registration by a plugin in interactive Claude Code (D16). **Partially resolved:** the Agent SDK exposes a programmatic `hooks` option on `query()`, so an SDK host can register hooks per session. There is still no mechanism for a plugin to do this in interactive Claude Code, so D16 stands for this design
- Any Anthropic documentation of the workflow script authoring API (A.9)

**Documentation-derived, not individually logged:**

[`../SPEC.md`](../SPEC.md) presents each claim below as Claude Code behaviour, and the design uses each one, but no pass recorded above establishes it: none was executed against the pinned version, and none was logged as read while the buckets above were being filled. They are listed rather than dropped, and listed apart rather than folded into the first bucket, so that a reader can tell at a glance which claims carry weaker provenance than the executed ones. Where a claim is load-bearing, that is said.

- MCP servers are declared at plugin level in `.mcp.json` at the plugin root, or inline in the manifest (§3.8)
- A plugin server's tools are named `mcp__plugin_<plugin>_<server>__<tool>`, and a hook targeting one must use that scoped form in its tool matcher and `if` field, a bare server key never firing (§3.8)
- An `mcp_tool` hook's `server` field takes `plugin:<plugin>:<server>` (§3.8)
- A `userConfig` entry marked `sensitive: true` is stored in the OS keychain and substitutes as `${user_config.KEY}` into MCP and LSP configuration (§3.8, D21)
- The same values are rejected in shell-form hook commands, which read `CLAUDE_PLUGIN_OPTION_<KEY>` from the environment instead (§3.8, D21)
- The Agent SDK's `strictMcpConfig` option ignores plugin-provided servers entirely (§3.8)
- `disableAllHooks` silently stops hook routing (L6)
- `statusMessage` on a hook surfaces progress in the UI (L9)
- **Load-bearing:** a skill referenced from a subagent's `skills` frontmatter that is missing or disabled by policy is skipped with only a debug-log warning, so the step runs without its instructions and nothing fails loudly. §3.6's build-time validation exists because of this claim, and D18 sends that validation to the compiler after measuring that `claude plugin validate --strict` does not cover agent frontmatter
- **Load-bearing:** `CLAUDE_CODE_SUBAGENT_MODEL` resolves above a subagent's frontmatter `model`, so a user's environment overrides the per-node model the compiler emits (§3.6)

**Community-reported, not documentation-confirmed:**
- Full Workflow injected-globals surface, `agent()` options, and `meta` purity rules ([`DYNAMIC-WORKFLOWS.md`](./DYNAMIC-WORKFLOWS.md)), reverse-engineered from binary strings and the bundled `/deep-research` script
- ~~Agent tool stripped from non-fork subagents~~ **explained**: this is the documented depth-limit behaviour at the limit, not a bug
- ~~Nesting worked on 2.1.216, broke on 2.1.217~~ **explained**: the default depth changed to one in v2.1.217
- ~~Secondary sources claim a depth cap of 5~~ **both were right**: five was the default on v2.1.172 through v2.1.216

**Assumed, not verified:**
- That a runner subagent *reliably* follows a three-line spawn-only instruction (L7). The spike runner complied twice, but n=2 says nothing about the tail, and the parent cannot see a deviation
- That the dispatcher completes well inside hook timeouts (L2). It ran, but nothing timed it
