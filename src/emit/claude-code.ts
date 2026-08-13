/**
 * The Claude Code backend emitter.
 *
 * Turns a compiled graph into a Claude Code plugin directory, as a **pure
 * function over a file map**: {@link emit} returns `path -> contents` and never
 * touches a filesystem, so the entire artifact is assertable in a unit test with
 * no temp directory and no cleanup. {@link writeFiles} is the only part that
 * does I/O, and it is deliberately trivial for that reason.
 *
 * Most of what follows looks like over-specification and is not. Each of these
 * was measured on Claude Code `2.1.229` during the verification spike (SPEC
 * §6.4), and getting any of them wrong produces a plugin that loads cleanly and
 * then silently does nothing:
 *
 * - **The dispatcher is `.cjs`, never `.js`.** Node resolves CommonJS-vs-ESM
 *   from the nearest ancestor `package.json`, and a compiled plugin usually
 *   lands inside the user's repo. The spike's `dispatch.js` inherited
 *   `"type": "module"` from two levels up and died with `require is not defined`
 *   on every hook fire.
 * - **`hooks.json` needs the top-level `hooks` wrapper.** Event names are keys
 *   inside it. Without the wrapper the registration does not load at all.
 * - **The manifest must carry `author`.** `claude plugin validate --strict`
 *   promotes a missing author from advisory warning to hard error, which would
 *   break the user's CI.
 * - **The graph hash goes in `metadata`.** That object is free-form and Claude
 *   Code does not read it. A custom *top-level* field also loads, but `--strict`
 *   turns unrecognized top-level fields into errors (SPEC D8).
 * - **Matcher semantics differ per event, so every matcher we emit is anchored
 *   with `^…$`.** For `SubagentStop` a matcher is an unanchored search, where an
 *   unanchored `my-workflow:runner` would also match
 *   `other:my-workflow:runner-helper`. For `UserPromptExpansion` it is a full
 *   match instead: `run` does not fire for `my-workflow:run` despite being a
 *   substring. Anchoring is right for both; assuming one rule covers both is not.
 * - **A command must exist for the entrypoint hook to be reachable at all.**
 *   `UserPromptExpansion` fires when a *command* expands, so a matcher naming
 *   commands nothing defines never runs. This emitter shipped exactly that bug:
 *   a correct-looking plugin, with an entrypoint that could not be invoked.
 * - **Commands are namespaced by the manifest name**: `/my-workflow:run`, never
 *   `/run`, and the payload reports `command_name` in that same form without the
 *   slash. Both the matcher and the dispatcher's own routing table have to carry
 *   the namespaced string, or the hook fires and then fails to recognise itself.
 * - **A subagent `name` may not contain `:`**, because the platform reserves it for
 *   plugin scoping and refuses to load the file. Node ids are therefore
 *   sanitized into agent names (see {@link agentNames}).
 * - **`skills:` in the wrapper's frontmatter is what makes a node out of a user
 *   skill without touching their file.** The spike proved the body genuinely
 *   arrives by narrowing the step's tools to `Glob`, which cannot read file
 *   contents, and still getting the skill's marker token back.
 * - **State lives in `$CLAUDE_PLUGIN_DATA`, read from the hook environment.**
 *   Never reconstructed (`$CLAUDE_CONFIG_DIR` moves it, and a `--plugin-dir`
 *   plugin gets the id `{name}-inline`), and never written into the plugin root,
 *   which changes on every update.
 *
 * **The evaluator travels with the plugin.** The dispatcher is CommonJS with no
 * bundler and this package is ESM, so it cannot import minflow at all. It
 * requires a vendored copy of `observationsFor` and `evaluate`, emitted beside
 * it, and reimplements no part of a transition itself; {@link RUNTIME_SOURCE}
 * records the alternatives and why a copy beats resolving the package.
 *
 * **Zero idle footprint is a hard requirement** (SPEC D9), which is why exactly
 * two registrations are emitted and both are matcher-scoped: `SubagentStop`
 * pinned to this plugin's runner, and `UserPromptExpansion` pinned to the run
 * command plus the gate commands this graph actually has. Neither fires during
 * unrelated work.
 *
 * @packageDocumentation
 */

import { canonicalize } from "../hash.js";
import type { Guard, IrNode, JsonValue, NodeId, PayloadSource, WorkflowIr } from "../ir.js";
import { DEFAULT_PAYLOAD_SOURCE } from "../ir.js";

// ---------------------------------------------------------------------------
// The artifact's shape
// ---------------------------------------------------------------------------

/** A rendered plugin: relative POSIX path to file contents. */
export type PluginFiles = Record<string, string>;

/** The manifest, and the only file permitted in `.claude-plugin/`. */
export const MANIFEST_PATH = ".claude-plugin/plugin.json";
/** The two hook registrations. */
export const HOOKS_PATH = "hooks/hooks.json";
/** The dispatcher entry. `.cjs` is load-bearing; see the module doc. */
export const DISPATCHER_PATH = "hooks/dispatch.cjs";
/**
 * The vendored transition evaluator the dispatcher requires.
 *
 * Byte-identical for every graph: it is minflow's own `observationsFor` and
 * `evaluate`, ported to CommonJS. See {@link RUNTIME_SOURCE} for why it ships
 * inside the plugin rather than being resolved from a `node_modules`.
 */
export const RUNTIME_PATH = "hooks/minflow-runtime.cjs";
/** The flat runner (SPEC §3.2): spawns one step, then stops. */
export const RUNNER_PATH = "agents/runner.md";
/** The compiled graph, pretty-printed, read back by the dispatcher. */
export const COMPILED_GRAPH_PATH = "workflow.compiled.json";

/** Commands live at the plugin root, like every component directory except the manifest. */
export const COMMANDS_DIR = "commands";

/** The name of the runner subagent, before plugin scoping. */
const RUNNER_AGENT = "runner";

/** The runner's whole toolset: it spawns one step and does nothing else. */
const RUNNER_TOOL = "Agent";

/** Prefix every generated step wrapper carries, so agents/ reads as a graph. */
const STEP_PREFIX = "step-";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Manifest author, in the object form the spike validated. */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/** Everything the emitter cannot derive from the graph. All of it optional. */
export interface EmitOptions {
  /**
   * Plugin name. Defaults to the workflow name, sanitized into the portable
   * plugin-name charset (lowercase alphanumerics, `-` and `.`, no doubled
   * separators, alphanumeric at both ends).
   */
  name?: string;
  /** Manifest version. Defaults to `"0.0.0"`. */
  version?: string;
  /** Manifest description. Defaults to a line naming the workflow and its size. */
  description?: string;
  /**
   * Manifest author.
   *
   * **Fallback: `{ name: "minflow" }`.** A missing author is a hard error under
   * `claude plugin validate --strict`, so the field can never be omitted; the
   * generator naming itself is the honest placeholder. Pass this to attribute
   * the plugin properly.
   */
  author?: string | PluginAuthor;
  /** The command that starts a run. Defaults to `run-<plugin name>`. */
  command?: string;
  /** Optional manifest `homepage`. */
  homepage?: string;
  /** Optional manifest `license`. */
  license?: string;
}

// ---------------------------------------------------------------------------
// Delivery obligations
// ---------------------------------------------------------------------------

/**
 * What a step has to produce, derived from the guards on its outgoing edges.
 *
 * The author declares a payload lane per *edge*, because delivery is a property
 * of the reader (SPEC §6.3). The obligation is the mirror image of that, per
 * *node*: the union of every lane the node's outgoing guards read. Nobody should
 * hand-maintain this: a step that is told to write `notes/research.json` is
 * told because an edge out of it reads that path, and the compiler knows.
 */
export interface DeliveryObligations {
  /** An outgoing guard reads the payload inline, i.e. from the final message. */
  inline: boolean;
  /** Paths an outgoing guard reads the payload from. First-encountered order. */
  payloadFiles: string[];
  /** Paths an outgoing `fileExists` guard checks. */
  fileChecks: string[];
  /** Commands an outgoing `exitZero` guard runs. */
  commandChecks: string[];
}

/** Records a lane, keeping first-encountered order and no duplicates. */
function push(into: string[], value: string): void {
  if (!into.includes(value)) into.push(value);
}

function walkGuard(guard: Guard, into: DeliveryObligations): void {
  switch (guard.kind) {
    case "always":
      return;
    case "exitZero":
      push(into.commandChecks, guard.command);
      return;
    case "fileExists":
      push(into.fileChecks, guard.path);
      return;
    case "field":
    case "judge": {
      const lane: PayloadSource = guard.from ?? DEFAULT_PAYLOAD_SOURCE;
      if (lane.lane === "file") push(into.payloadFiles, lane.path);
      else into.inline = true;
      return;
    }
    case "not":
      walkGuard(guard.guard, into);
      return;
    case "all":
    case "any":
      for (const inner of guard.guards) walkGuard(inner, into);
      return;
  }
}

/**
 * Everything the guards leaving `nodeId` will read, including guards nested
 * inside `all`, `any` and `not`.
 *
 * Every outgoing edge contributes, not just the first that could fire: the host
 * resolves observations before it knows which edge wins, so the obligation is
 * the union rather than the minimum. This mirrors `observationsFor` in
 * `evaluate.ts`, one level up. That produces requests for the host, this
 * produces instructions for the step.
 */
export function obligationsFor(ir: WorkflowIr, nodeId: NodeId): DeliveryObligations {
  const obligations: DeliveryObligations = {
    inline: false,
    payloadFiles: [],
    fileChecks: [],
    commandChecks: [],
  };
  for (const edge of ir.edges) {
    if (edge.from !== nodeId) continue;
    walkGuard(edge.guard, obligations);
  }
  return obligations;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Agent Plugins 1.0.0 caps a plugin name at 64 characters; agent names match it. */
const NAME_MAX = 64;

/**
 * Strips leading and trailing separators.
 *
 * Applied after every truncation, not only after the fold: a cut at
 * {@link NAME_MAX} can land immediately after a hyphen, and a trailing hyphen
 * breaks the "alphanumeric at both ends" rule that the portable plugin-name
 * charset and our own agent names both promise.
 */
function trimSeparators(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

/**
 * Lowercase, hyphen-separated, alphanumeric at both ends.
 *
 * Used for both plugin names and subagent names. Plugin names may also contain
 * `.`; folding those to `-` as well costs nothing and keeps one rule.
 */
function slug(raw: string): string {
  const folded = trimSeparators(raw.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  return trimSeparators(folded.slice(0, NAME_MAX));
}

/**
 * The plugin's name: `opts.name` if given, otherwise the workflow name folded
 * into the portable charset.
 *
 * Throws when nothing survives the fold, because a nameless plugin does not
 * load and failing at compile time is the only place that is cheap to fix.
 */
export function pluginNameFor(ir: WorkflowIr, opts: EmitOptions = {}): string {
  const source = opts.name ?? ir.name;
  const name = slug(source);
  if (name === "") {
    throw new Error(
      `minflow: cannot derive a plugin name from "${source}". Plugin names are 1-64 ` +
        "characters of a-z, 0-9 and -, starting and ending alphanumeric. " +
        'Pass one explicitly, e.g. emit(ir, { name: "my-workflow" }).',
    );
  }
  return name;
}

/**
 * Node id to subagent name, e.g. `review:security` -> `step-review-security`.
 *
 * Two constraints force this. A subagent `name` containing `:` is refused by the
 * platform, because `:` is reserved for the plugin-scoped identifier
 * (`my-plugin:step-review`). And the file's own basename participates in that
 * identifier, so the name and the filename must agree.
 *
 * Sanitizing is lossy, so collisions are possible, since `a:b` and `a/b` both fold to
 * `step-a-b`. They are resolved by appending `-2`, `-3`, … in node declaration
 * order, which is stable for a given graph. The true node id is never lost: it
 * stays in `workflow.compiled.json`, and this map is what the dispatcher uses to
 * get from one to the other.
 */
export function agentNames(ir: WorkflowIr): Record<NodeId, string> {
  const names: Record<NodeId, string> = {};
  const taken = new Set<string>([RUNNER_AGENT]);
  for (const node of ir.nodes) {
    const body = slug(node.id);
    // Both slices are re-trimmed: an id long enough to be cut can put the cut
    // right after a hyphen, and `step-a-` is not a legal name.
    const base = trimSeparators(`${STEP_PREFIX}${body === "" ? "node" : body}`.slice(0, NAME_MAX));
    let name = base;
    let ordinal = 2;
    while (taken.has(name)) {
      const suffix = `-${ordinal}`;
      name = `${trimSeparators(base.slice(0, NAME_MAX - suffix.length))}${suffix}`;
      ordinal += 1;
    }
    taken.add(name);
    names[node.id] = name;
  }
  return names;
}

/**
 * The command that rejects a gate, derived from the command that resumes it.
 *
 * `approve-plan` -> `reject-plan`, matching SPEC §3.2's own example; anything
 * else gets a plain `reject-` prefix. Both are matcher-scoped into the same
 * dispatcher, so a gate costs two command names and no extra machinery.
 *
 * The prefix is only stripped when something survives it: a gate named exactly
 * `approve` would otherwise derive the malformed `reject-`, which names no
 * command and matches nothing.
 */
function rejectCommandFor(gate: string): string {
  const stripped = gate.replace(/^approve[-_]?/i, "");
  return `reject-${stripped === "" ? gate : stripped}`;
}

/** A gate's two command names: the one that resumes it and the one that kills it. */
interface GateCommands {
  gate: string;
  resume: string;
  reject: string;
}

/**
 * Every gate in the graph, in edge order, with its two command names.
 *
 * Deriving a reject name is lossy the same way sanitizing a node id is:
 * `approve-plan` and `plan` both derive `reject-plan`, so the derived names are
 * de-duplicated against the resume names and against each other with the same
 * `-2`, `-3`, … scheme {@link agentNames} uses. Two gates sharing one reject
 * command would silently give the second gate no way to be rejected, and the
 * first gate's command would kill whichever run the dispatcher found first.
 */
function gatesOf(ir: WorkflowIr): GateCommands[] {
  const resumes: string[] = [];
  const taken = new Set<string>();
  for (const edge of ir.edges) {
    if (edge.gate === undefined || taken.has(edge.gate)) continue;
    taken.add(edge.gate);
    resumes.push(edge.gate);
  }

  const gates: GateCommands[] = [];
  for (const gate of resumes) {
    const base = rejectCommandFor(gate);
    let reject = base;
    let ordinal = 2;
    while (taken.has(reject)) {
      reject = `${base}-${ordinal}`;
      ordinal += 1;
    }
    taken.add(reject);
    gates.push({ gate, resume: gate, reject });
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * A JSON file this module composes itself: pretty-printed, newline-terminated.
 *
 * Key order is fixed by the literals below rather than by anything the caller
 * hands us, so insertion order is already a function of the graph's value here.
 * Anything carrying user data goes through {@link canonicalJson} instead.
 */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * `JSON.stringify(value, null, 2)`, with object keys in canonical order.
 *
 * Emitted bytes have to be a function of the graph's *value*, never of the order
 * a front-end happened to assign properties in. `graphHash` digests the
 * canonical form (`hash.ts`), so two graphs it certifies as identical must
 * produce an identical plugin; `JSON.stringify` preserves insertion order and
 * would break that for everything the emitter copies through verbatim, and a
 * node's `params` and `schema`, and the compiled graph itself.
 *
 * Implemented as a round trip through {@link canonicalize} rather than a second
 * sorted walk, so "canonical" has exactly one definition in this codebase and it
 * is the hash's. The re-parse means integer-like keys come back in ascending
 * numeric order rather than lexical order. Still a pure function of the value,
 * which is the property that matters.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalize(value)), null, 2);
}

/** A canonical JSON file: sorted keys, pretty-printed, newline-terminated. */
function canonicalJsonFile(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

/** Collapses to one line: a YAML scalar cannot carry a raw newline. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Scalars a YAML resolver reads as something other than a string.
 *
 * A plain `true`, `no`, `null` or `2` in the frontmatter arrives at the platform
 * as a boolean, a null or a number, so a skill or model genuinely named one of
 * those matches nothing and the step runs without its instructions, silently,
 * because an unresolved preload is only a debug-log warning (SPEC §3.6). Both
 * YAML editions are covered: 1.2's core schema plus 1.1's `y`/`yes`/`on`/`off`
 * family, its `0o`/`0b` and underscore-separated integers, all case-insensitive.
 *
 * Anything starting with `+`, `-`, `.` or `~` is already refused by the plain
 * form's leading-character rule, so `.inf`, `-2` and `~` never reach this.
 */
const YAML_RESOLVED_AS_NON_STRING = [
  /^(?:y|n|yes|no|true|false|on|off)$/i,
  /^(?:null)$/i,
  /^(?:0b[01_]+|0o[0-7_]+|0x[0-9a-f_]+|[0-9][0-9_]*)$/i,
  /^(?:[0-9][0-9_]*\.[0-9_]*(?:e[-+]?[0-9]+)?|[0-9][0-9_]*e[-+]?[0-9]+)$/i,
];

/**
 * A YAML scalar that is safe unquoted, or a double-quoted one.
 *
 * The plain form is refused for anything containing `:`, `#`, quotes or leading
 * punctuation, all of which change the meaning of a YAML line, and for anything
 * a scalar resolver would hand back as a non-string. The quoted form is
 * `JSON.stringify`, whose escapes are a subset of YAML's double-quoted style.
 */
function yaml(value: string): string {
  const plain =
    /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(value) &&
    !YAML_RESOLVED_AS_NON_STRING.some((pattern) => pattern.test(value));
  return plain ? value : JSON.stringify(value);
}

/** A YAML flow sequence, one quoting decision per entry: `[a, "b: c"]`. */
function yamlList(values: string[]): string {
  return `[${values.map(yaml).join(", ")}]`;
}

/**
 * A frontmatter list field, as the comma-joined plain scalar the spike measured
 * where that is available and as a flow sequence where it is not.
 *
 * Two things the naive `join(", ")` gets wrong. An empty list must not become a
 * bare `tools:` key: YAML reads that as null, which the platform treats as
 * "inherit the default tool set", the exact opposite of the empty allowlist the
 * author asked for. And quotes inside a plain scalar are literal characters, not
 * quoting, so a single entry needing them (`mcp__server__*`, anything with a
 * comma) forces the whole field into a flow sequence rather than being escaped
 * in place.
 */
function yamlNameList(values: string[]): string {
  if (values.length === 0) return "[]";
  const quoted = values.map(yaml);
  const allPlain = quoted.every((entry, index) => entry === values[index]);
  return allPlain ? values.join(", ") : `[${quoted.join(", ")}]`;
}

/** Escapes a literal for embedding in a regular-expression matcher. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `^a$`, or `^(?:a|b|c)$`. Anchored, because matchers are evaluated unanchored. */
function anchoredMatcher(alternatives: string[]): string {
  const escaped = alternatives.map(escapeRegExp);
  const first = escaped[0];
  if (escaped.length === 1 && first !== undefined) return `^${first}$`;
  return `^(?:${escaped.join("|")})$`;
}

function frontmatter(fields: [string, string][], body: string): string {
  const lines = ["---"];
  for (const [key, value] of fields) lines.push(`${key}: ${value}`);
  lines.push("---", "", body.trimEnd(), "");
  return lines.join("\n");
}

/** Kept as a constant so the emitter's own source stays readable. */
const FENCE = "```";

function fence(language: string, contents: string): string {
  return [`${FENCE}${language}`, contents.trimEnd(), FENCE].join("\n");
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function authorOf(opts: EmitOptions): JsonValue {
  const author = opts.author ?? { name: "minflow" };
  if (typeof author === "string") return { name: author };
  const rendered: Record<string, JsonValue> = { name: author.name };
  if (author.email !== undefined) rendered.email = author.email;
  if (author.url !== undefined) rendered.url = author.url;
  return rendered;
}

function manifestFor(ir: WorkflowIr, opts: EmitOptions, pluginName: string): string {
  const steps = ir.nodes.length;
  const manifest: Record<string, JsonValue> = {
    name: pluginName,
    description:
      opts.description ??
      `Compiled minflow workflow "${ir.name}": ${steps} ${steps === 1 ? "step" : "steps"}, ` +
        `entry "${ir.entry}".`,
    version: opts.version ?? "0.0.0",
    author: authorOf(opts),
  };
  if (opts.homepage !== undefined) manifest.homepage = opts.homepage;
  if (opts.license !== undefined) manifest.license = opts.license;
  // Free-form, unread by Claude Code, and the only schema-clean home for our own
  // data (D8). Values are strings because nothing here needs more, and a flat
  // string map is the shape least likely to surprise a future validator.
  manifest.metadata = {
    generator: "minflow",
    workflow: ir.name,
    graphHash: ir.hash,
    irVersion: String(ir.irVersion),
    entry: ir.entry,
    steps: String(steps),
  };
  return json(manifest);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function hookCommand(): { hooks: JsonValue[] } {
  return {
    // ${CLAUDE_PLUGIN_ROOT} is substituted by the host and moves on every update,
    // which is exactly why nothing is ever written underneath it.
    hooks: [
      {
        type: "command",
        command: "node",
        args: [`\${CLAUDE_PLUGIN_ROOT}/${DISPATCHER_PATH}`],
      },
    ],
  };
}

/**
 * A command's invocation name: the plugin's manifest name, a colon, the command.
 *
 * Measured on 2.1.229, and not guessable: a plugin command is *only* reachable in
 * its namespaced form. `/run-my-workflow` is "Unknown command"; so is the
 * data-directory id form, whose name carries an `-inline` suffix for a
 * `--plugin-dir` load. The same string is what the hook payload reports as
 * `command_name` (without the leading slash), so it is what the matcher must
 * carry and what the dispatcher must compare against. An earlier version of this
 * emitter used the bare name in both places and emitted no commands at all, which
 * produced a plugin that installed, read correctly, and did nothing whatsoever.
 */
function qualified(pluginName: string, command: string): string {
  return `${pluginName}:${command}`;
}

function hooksFor(pluginName: string, commands: string[]): string {
  const entry = hookCommand();
  return json({
    // The wrapper is required. A registration without it does not load, and
    // `claude plugin validate` reports schema errors under `hooks.<EventName>`.
    hooks: {
      UserPromptExpansion: [
        { matcher: anchoredMatcher(commands.map((c) => qualified(pluginName, c))), ...entry },
      ],
      SubagentStop: [{ matcher: anchoredMatcher([qualified(pluginName, RUNNER_AGENT)]), ...entry }],
    },
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * The entrypoint the user types, and one command per gate.
 *
 * Without these the `UserPromptExpansion` registration is unreachable: the event
 * fires when a *command* expands, so a matcher naming a command nothing defines
 * never runs. The body is the prompt the command expands into; the dispatcher
 * blocks that expansion and takes over, so the text matters only when routing is
 * disabled or the plugin is inspected by hand.
 */
function commandFor(description: string, body: string): string {
  return frontmatter([["description", yaml(oneLine(description))]], body);
}

/**
 * The body of a command is what reaches the model, and on this event that is the
 * only thing that can.
 *
 * A hook cannot instruct the conversation here. Rendering a `block` decision on
 * `UserPromptExpansion` cancels the expansion and prints the reason, so the model
 * never sees the command at all: measured, after this emitter first assumed the
 * blocked-and-redirected behaviour that `SubagentStop` really does have. The
 * dispatcher therefore seeds state silently and lets the expansion through, and
 * this text is what spawns the runner.
 *
 * Which step runs first is deliberately not stated here, because a command file
 * is written at compile time and cannot know where a resumed run is parked. The
 * runner stands by, stops, and its `SubagentStop` is redirected with the real
 * step. That indirection is what makes one static command work for a fresh run
 * and for a run resumed at any node.
 */
function spawnRunnerBody(pluginName: string, headline: string): string {
  return [
    headline,
    "",
    `Spawn the subagent \`${qualified(pluginName, RUNNER_AGENT)}\` with the Agent tool, and give`,
    "it exactly this instruction, verbatim:",
    "",
    "> Stand by. You will be told which step to spawn. Spawn nothing until then.",
    "",
    "Do not do any of the workflow's own work yourself, and spawn nothing else. Report",
    "back whatever the runner returns.",
  ].join("\n");
}

function runCommandFile(ir: WorkflowIr, pluginName: string): string {
  return commandFor(
    `Start the "${ir.name}" workflow.`,
    spawnRunnerBody(
      pluginName,
      `Start the **${oneLine(ir.name)}** workflow, which begins at \`${ir.entry}\`.`,
    ),
  );
}

function gateCommandFiles(ir: WorkflowIr, pluginName: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const gate of gatesOf(ir)) {
    files[`${COMMANDS_DIR}/${gate.resume}.md`] = commandFor(
      `Approve the "${gate.gate}" gate and continue the run.`,
      spawnRunnerBody(
        pluginName,
        `Release the **${oneLine(gate.gate)}** gate on the "${oneLine(ir.name)}" workflow, ` +
          "which is parked awaiting sign-off. It continues at whichever node it parked into.",
      ),
    );
    files[`${COMMANDS_DIR}/${gate.reject}.md`] = commandFor(
      `Reject the "${gate.gate}" gate and abandon the run.`,
      [
        `Abandon the "${oneLine(ir.name)}" workflow at the **${oneLine(gate.gate)}** gate.`,
        "",
        "The plugin's dispatcher deletes the run's state when this command is used, so there",
        "is nothing further to do. Nothing already written to the repository is undone: this",
        "ends the run, it does not roll it back.",
      ].join("\n"),
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function runnerFor(ir: WorkflowIr, pluginName: string, runCommand: string): string {
  const fields: [string, string][] = [
    ["name", RUNNER_AGENT],
    [
      "description",
      yaml(
        oneLine(
          `Runs the "${ir.name}" workflow one step at a time. Started by ` +
            `/${qualified(pluginName, runCommand)}; not for direct use.`,
        ),
      ),
    ],
    // Only the Agent tool, so the runner physically cannot do a step's work
    // itself. L7 calls the runner a compliance dependency: actuation runs
    // through prose, and a paraphrased instruction silently diverges the graph.
    // Narrowing its tools is the only part of that we can enforce rather than
    // merely ask for.
    ["tools", yamlNameList([RUNNER_TOOL])],
  ];
  // No maxTurns on purpose: one runner is redirected once per transition for the
  // whole run segment, so any ceiling here would be a ceiling on graph length.
  return frontmatter(
    fields,
    [
      "You are a dispatcher, not a worker.",
      "",
      "Spawn exactly the agent the most recent instruction names, using the Agent tool, and",
      "pass it exactly the text you were given, verbatim: no paraphrase, no additions, no",
      "improvements. Do not do the step's work yourself. Do not read, write or run anything.",
      "Do not spawn anything else.",
      "",
      "When that agent returns, stop and report its result unchanged.",
    ].join("\n"),
  );
}

/**
 * Whether the step should end its final message with the payload.
 *
 * A guard that reads the inline lane settles it. Failing that, a node that
 * declares a `schema` still has an output contract and nowhere else to put it,
 * so it goes inline, the one place the host can always see it. A node with
 * neither is asked for nothing, which is the point of deriving rather than
 * demanding.
 */
function deliversInline(node: IrNode, obligations: DeliveryObligations): boolean {
  if (obligations.inline) return true;
  return node.schema !== undefined && obligations.payloadFiles.length === 0;
}

function stepBody(
  ir: WorkflowIr,
  node: IrNode,
  obligations: DeliveryObligations,
  pluginName: string,
): string {
  const sections: string[] = [];

  sections.push(
    [
      `# Step \`${node.id}\``,
      "",
      `You are one step of the compiled workflow **${ir.name}**. The skill \`${node.skill}\` is`,
      "already loaded into your context, so follow it. Do this step's work and nothing else:",
      "do not decide what runs next, and you never spawn another agent.",
    ].join("\n"),
  );

  if (node.prompt !== undefined) {
    sections.push(["## Task", "", node.prompt.trimEnd()].join("\n"));
  }

  const params = node.params;
  if (params !== undefined) {
    // Sorted, and each value canonically encoded: `params` is a record, so its
    // key order carries no meaning and never reaches the hash. Rendering it in
    // insertion order would make the emitted bytes depend on how the graph was
    // typed rather than on what it says.
    const lines = Object.keys(params)
      .sort()
      .map((key) => `- \`${key}\`: ${canonicalize(params[key])}`);
    if (lines.length > 0) {
      sections.push(["## Parameters", "", ...lines].join("\n"));
    }
  }

  if (node.schema !== undefined) {
    sections.push(
      [
        "## Output contract",
        "",
        "Your payload is JSON and must conform to this schema exactly:",
        "",
        fence("json", canonicalJson(node.schema)),
      ].join("\n"),
    );
  }

  const delivery: string[] = [];
  for (const path of obligations.payloadFiles) {
    delivery.push(
      `- Write your JSON payload to \`${path}\`. A transition out of this step reads it from ` +
        "there, so the run stops if it is missing or unparseable.",
    );
  }
  if (deliversInline(node, obligations)) {
    delivery.push(
      "- End your final message with your JSON payload as a single fenced `json` block, with " +
        "nothing after it. It is read from the message itself, so anything following it is " +
        "noise the parser has to survive.",
    );
  }
  if (delivery.length > 0) {
    sections.push(
      [
        "## Delivery",
        "",
        "The workflow reads your output from these places. Producing them is not optional:",
        "",
        ...delivery,
      ].join("\n"),
    );
  }

  const checks: string[] = [];
  for (const path of obligations.fileChecks) {
    checks.push(`- \`${path}\` must exist on disk.`);
  }
  for (const command of obligations.commandChecks) {
    checks.push(`- \`${command}\` will be run, and the route depends on its exit code.`);
  }
  if (checks.length > 0) {
    sections.push(
      [
        "## Checked after you finish",
        "",
        "The workflow evaluates these to decide where the run goes next:",
        "",
        ...checks,
      ].join("\n"),
    );
  }

  // A gated edge ends the run *segment* (SPEC §3.9): subagents cannot ask the
  // user anything, so sign-off is a fresh run started by a command. Worth
  // saying here, because otherwise the step's own stopping looks like a failure.
  const gates: string[] = [];
  for (const edge of ir.edges) {
    if (edge.from !== node.id || edge.gate === undefined) continue;
    if (!gates.includes(edge.gate)) gates.push(edge.gate);
  }
  if (gates.length > 0) {
    // Namespaced: the bare form is an unknown command, so telling the reviewer
    // to run `/approve-plan` would send them to a dead end.
    const commands = gates.map((gate) => `\`/${qualified(pluginName, gate)}\``).join(" or ");
    sections.push(
      [
        "## After this step",
        "",
        `The run parks here for human sign-off and continues only when someone runs ${commands}.`,
        "Leave your work in a state a reviewer can judge without re-running anything.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function stepFor(
  ir: WorkflowIr,
  node: IrNode,
  agent: string,
  obligations: DeliveryObligations,
  pluginName: string,
): string {
  const fields: [string, string][] = [
    // No colon, ever: the platform reserves it for plugin scoping and refuses to
    // load a wrapper whose name contains one.
    ["name", agent],
    [
      "description",
      yaml(
        oneLine(
          `Step "${node.id}" of the "${ir.name}" workflow. Runs the "${node.skill}" skill.` +
            (node.phase === undefined ? "" : ` Phase: ${node.phase}.`),
        ),
      ),
    ],
    // The whole UX premise: the user's skill is preloaded into this wrapper, so
    // their file becomes a node without being edited or copied.
    ["skills", yamlList([node.skill])],
  ];
  if (node.model !== undefined) fields.push(["model", yaml(node.model)]);
  if (node.maxTurns !== undefined) fields.push(["maxTurns", String(node.maxTurns)]);
  if (node.tools !== undefined) fields.push(["tools", yamlNameList(node.tools)]);

  return frontmatter(fields, stepBody(ir, node, obligations, pluginName));
}

// ---------------------------------------------------------------------------
// The vendored runtime
// ---------------------------------------------------------------------------

/**
 * minflow's `observationsFor` and `evaluate`, ported to CommonJS and shipped
 * inside the plugin.
 *
 * **Why a copy travels with the artifact rather than being resolved.** The
 * dispatcher cannot import this package: it is CommonJS with no bundler, and
 * minflow is ESM. Three ways out were on the table, and only one of them holds
 * everywhere the plugin can run.
 *
 * 1. *Reimplement the transition rules in the dispatcher.* Refused outright.
 *    There would then be two definitions of what an edge means, free to drift,
 *    which is the exact failure the IR exists to prevent.
 * 2. *Resolve minflow from a `node_modules` at run time.* Works while the plugin
 *    sits inside the repository that authored it and nowhere else. This emitter
 *    ships no `package.json` and no lockfile, so Claude Code installs nothing
 *    (SPEC §3.1), and an installed plugin lives in the plugin cache with no
 *    ancestor `node_modules` to find. Routing would then work in local
 *    `--plugin-dir` development and silently stop working once the plugin was
 *    distributed, which is the worst property a router can have. It also invites
 *    version skew: the graph in `workflow.compiled.json` was compiled by one
 *    version of minflow and would be routed by whatever version the user happens
 *    to have installed, with nothing to detect the mismatch. `graphHash` pins the
 *    graph's identity, not the evaluator's.
 * 3. *Vendor the evaluator beside the dispatcher.* Chosen. The plugin is
 *    self-contained, the evaluator is always the one that compiled the graph, and
 *    there is a single code path, so what the tests exercise is what ships.
 *
 * The residual risk of a copy is drift against `src/evaluate.ts`. That is held
 * closed by a differential test rather than by discipline: the suite executes
 * this file and the real module over the same graphs, states and observations
 * and asserts the transitions are identical, so an edit to one that is not made
 * to the other fails CI at the point of the edit.
 *
 * `String.raw` so that escapes belong to the emitted file. This is source code
 * being written, not a string being computed: a plain template literal would
 * eat the backslash in `\d` and quietly emit a different regular expression.
 * The consequence is that this text may contain no backtick and no `${`.
 */
const RUNTIME_SOURCE = String.raw`"use strict";
// Generated by minflow. Do not edit: regenerate the plugin.
//
// minflow's transition evaluator, observationsFor() and evaluate(), emitted as
// CommonJS beside the dispatcher that requires it. It is a copy of the package's
// own module, not a second implementation of it: two sets of transition rules
// could drift apart, and the IR exists precisely to stop that. The generator's
// test suite runs this file and the package module over the same inputs and
// requires identical transitions.
//
// .cjs for the same reason the dispatcher is: Node reads CommonJS-vs-ESM from
// the nearest ancestor package.json, and a compiled plugin usually sits inside
// the user's repository.
//
// Pure. No filesystem, no network, no model, no clock, no randomness, and the
// state it is handed is never mutated. Everything platform-specific happens in
// the dispatcher, which resolves observations into values before calling in, so
// no code path here can branch on how a payload was delivered.

const END = "__end__";
const DEFAULT_PAYLOAD_SOURCE = { lane: "inline" };
const DEFAULT_STEP_CEILING = 1000;
const OTHERWISE_EVENT = "otherwise";

const HOLDS = { ok: true, holds: true };
const FAILS = { ok: true, holds: false };

function isEnd(target) {
  return target === END;
}

// Deterministic JSON with object keys recursively sorted. JSON.stringify keeps
// insertion order, so two structurally identical specs would key differently and
// the host would run the same observation twice. Sorted by UTF-16 code unit,
// never localeCompare, which is locale-dependent and would make the key impure
// across machines. Array order is meaningful and is preserved.
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const parts = Object.entries(value)
      .filter(function (entry) {
        return entry[1] !== undefined;
      })
      .sort(function (left, right) {
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      })
      .map(function (entry) {
        return JSON.stringify(entry[0]) + ":" + canonicalize(entry[1]);
      });
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

function jsonEquals(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalize(left) === canonicalize(right);
}

// Stable identity for an observation, used both to deduplicate requests and to
// look results back up, so observationsFor and evaluate necessarily agree on it.
function observationKey(spec) {
  switch (spec.kind) {
    case "exitZero":
      return "exitZero:" + canonicalize({ command: spec.command });
    case "fileExists":
      return "fileExists:" + canonicalize({ path: spec.path });
    case "payload":
      return "payload:" + canonicalize({ from: spec.from });
    case "judge":
      return (
        "judge:" +
        canonicalize(
          spec.verdicts === undefined
            ? { question: spec.question, from: spec.from }
            : { question: spec.question, verdicts: spec.verdicts, from: spec.from },
        )
      );
    default:
      return "unknown:" + canonicalize(spec);
  }
}

// Note what is not in a judge's spec: the edge's expected verdict. That is a
// property of the edge, not of the question, so two edges out of a branch asking
// the same question collapse to one observation and the model is asked once.
function specForLeaf(guard) {
  switch (guard.kind) {
    case "exitZero":
      return { kind: "exitZero", command: guard.command };
    case "fileExists":
      return { kind: "fileExists", path: guard.path };
    case "field":
      return {
        kind: "payload",
        from: guard.from === undefined ? DEFAULT_PAYLOAD_SOURCE : guard.from,
      };
    case "judge":
      return guard.verdicts === undefined
        ? {
            kind: "judge",
            question: guard.question,
            from: guard.from === undefined ? DEFAULT_PAYLOAD_SOURCE : guard.from,
          }
        : {
            kind: "judge",
            question: guard.question,
            verdicts: guard.verdicts,
            from: guard.from === undefined ? DEFAULT_PAYLOAD_SOURCE : guard.from,
          };
    default:
      return { kind: guard.kind };
  }
}

function requestFor(spec) {
  const key = observationKey(spec);
  switch (spec.kind) {
    case "exitZero":
      return { key: key, kind: "exitZero", command: spec.command };
    case "fileExists":
      return { key: key, kind: "fileExists", path: spec.path };
    case "payload":
      return { key: key, kind: "payload", from: spec.from };
    case "judge":
      return spec.verdicts === undefined
        ? { key: key, kind: "judge", question: spec.question, from: spec.from }
        : {
            key: key,
            kind: "judge",
            question: spec.question,
            verdicts: spec.verdicts,
            from: spec.from,
          };
    default:
      return { key: key, kind: spec.kind };
  }
}

function collectGuard(guard, into, seen) {
  switch (guard.kind) {
    case "always":
      return;
    case "not":
      collectGuard(guard.guard, into, seen);
      return;
    case "all":
    case "any":
      for (const inner of guard.guards) collectGuard(inner, into, seen);
      return;
    default: {
      const request = requestFor(specForLeaf(guard));
      if (seen.has(request.key)) return;
      seen.add(request.key);
      into.push(request);
    }
  }
}

// Everything the host must find out to decide the transitions out of state.node,
// deduplicated by key and in first-encountered order. Every outgoing edge
// contributes, including ones whose guard will never be reached: observations
// are resolved before the evaluator knows which edge wins, so the set is the
// union rather than the minimum. A node declaring a schema contributes one more
// on the default lane, so its output is recorded even when no guard reads it.
function observationsFor(ir, state) {
  const requests = [];
  const seen = new Set();
  for (const edge of ir.edges) {
    if (edge.from !== state.node) continue;
    collectGuard(edge.guard, requests, seen);
  }
  const node = ir.nodes.find(function (candidate) {
    return candidate.id === state.node;
  });
  if (node !== undefined && node.schema !== undefined) {
    const request = requestFor({ kind: "payload", from: DEFAULT_PAYLOAD_SOURCE });
    if (!seen.has(request.key)) {
      seen.add(request.key);
      requests.push(request);
    }
  }
  return requests;
}

function lookup(key, resolved) {
  const result = resolved[key];
  if (result === undefined) {
    return { ok: false, error: "no observation was resolved for " + key };
  }
  if (!result.ok) {
    return { ok: false, error: "observation " + key + " failed: " + result.error };
  }
  return { ok: true, value: result.value };
}

// Numeric segments index arrays. Only own properties count, so "constructor" and
// "__proto__" read as absent rather than leaking the prototype chain into a
// comparison. Absent is undefined, which is outside JSON, so a field that is
// present and null stays distinguishable from one that is missing.
function readPath(payload, path) {
  let current = payload;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function matchesPattern(target, source) {
  if (typeof target !== "string" || typeof source !== "string") return false;
  try {
    return new RegExp(source).test(target);
  } catch (error) {
    // A malformed pattern is a graph-authoring bug for the linter to catch, not
    // a broken host contract; it must not crash a run.
    return false;
  }
}

function evaluateField(guard, payload) {
  const target = readPath(payload, guard.path);
  if (target === undefined) {
    // An absent path is false for every op except notEquals, which is true:
    // "the payload does not say X" includes "the payload does not mention X".
    return guard.op === "notEquals";
  }
  switch (guard.op) {
    case "truthy":
      return Boolean(target);
    case "equals":
      return jsonEquals(target, guard.value);
    case "notEquals":
      return !jsonEquals(target, guard.value);
    case "matches":
      return matchesPattern(target, guard.value);
    case "gt":
      return typeof target === "number" && typeof guard.value === "number" && target > guard.value;
    case "lt":
      return typeof target === "number" && typeof guard.value === "number" && target < guard.value;
    default:
      return false;
  }
}

// Kleene three-valued combination. A conjunction with a definitely-false member
// is false whatever the unresolved members would have said, and a disjunction
// with a definitely-true member is true. Only when an unresolved member could
// still change the answer does the failure surface as an error, which keeps the
// combination order-independent while never letting a broken contract route.
function combine(outcomes, mode) {
  const decisive = mode === "any";
  let failure;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      if (failure === undefined) failure = outcome.error;
      continue;
    }
    if (outcome.holds === decisive) return decisive ? HOLDS : FAILS;
  }
  if (failure !== undefined) return { ok: false, error: failure };
  return mode === "all" ? HOLDS : FAILS;
}

function resolveGuard(guard, resolved) {
  switch (guard.kind) {
    case "always":
      return HOLDS;
    case "exitZero":
    case "fileExists": {
      const found = lookup(observationKey(specForLeaf(guard)), resolved);
      if (!found.ok) return found;
      return found.value === true ? HOLDS : FAILS;
    }
    case "field": {
      const found = lookup(observationKey(specForLeaf(guard)), resolved);
      if (!found.ok) return found;
      return evaluateField(guard, found.value) ? HOLDS : FAILS;
    }
    case "judge": {
      const key = observationKey(specForLeaf(guard));
      const found = lookup(key, resolved);
      if (!found.ok) return found;
      // A verdict is a string by definition, so anything else is a violated
      // judge contract rather than a verdict that happens not to match.
      if (typeof found.value !== "string") {
        return {
          ok: false,
          error:
            "observation " +
            key +
            " returned " +
            canonicalize(found.value) +
            ", which is not a string; a judge must return a verdict",
        };
      }
      if (guard.verdicts !== undefined && !guard.verdicts.includes(found.value)) {
        return {
          ok: false,
          error:
            "observation " +
            key +
            " returned " +
            canonicalize(found.value) +
            ", which is not one of the declared verdicts " +
            canonicalize(guard.verdicts),
        };
      }
      return found.value === guard.is ? HOLDS : FAILS;
    }
    case "not": {
      const inner = resolveGuard(guard.guard, resolved);
      return inner.ok ? (inner.holds ? FAILS : HOLDS) : inner;
    }
    case "all":
      return combine(
        guard.guards.map(function (inner) {
          return resolveGuard(inner, resolved);
        }),
        "all",
      );
    case "any":
      return combine(
        guard.guards.map(function (inner) {
          return resolveGuard(inner, resolved);
        }),
        "any",
      );
    default:
      return { ok: false, error: "unknown guard kind " + guard.kind };
  }
}

// Copies the state verbatim, including a parked gate. Payload values already in
// outputs are shared by reference and treated as immutable JSON.
function cloneState(state) {
  const next = {
    runId: state.runId,
    graphHash: state.graphHash,
    node: state.node,
    status: state.status,
    attempts: Object.assign({}, state.attempts),
    steps: state.steps,
    outputs: Object.assign({}, state.outputs),
  };
  if (state.gate !== undefined) next.gate = state.gate;
  // Carried through opaquely. The host owns this; we neither read it nor drop
  // it, and dropping it would strand whatever multi-pass work it is tracking.
  if (state.host !== undefined) next.host = Object.assign({}, state.host);
  return next;
}

// Copies the state as a live run: no gate, status running, and no host scratch.
// A transition means the host's multi-pass work at this node is finished.
function runningClone(state) {
  return {
    runId: state.runId,
    graphHash: state.graphHash,
    node: state.node,
    status: "running",
    attempts: Object.assign({}, state.attempts),
    steps: state.steps,
    outputs: Object.assign({}, state.outputs),
  };
}

// The retry budget counts consecutive failures at a node, and departing settles
// all of them, not only the edge that fired. Clearing just the firing edge would
// leak a count across visits whenever a node is left through a sibling edge.
function withoutAttemptsFrom(attempts, ir, node) {
  const departed = new Set(
    ir.edges
      .filter(function (edge) {
        return edge.from === node;
      })
      .map(function (edge) {
        return edge.id;
      }),
  );
  const next = {};
  for (const entry of Object.entries(attempts)) {
    if (!departed.has(entry[0])) next[entry[0]] = entry[1];
  }
  return next;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorTransition(state, code, message) {
  return { kind: "error", code: code, message: message, state: cloneState(state) };
}

// The payload this node produced: the first payload observation that resolved
// ok, in the enumeration order of observationsFor. A node that declares a schema
// must produce a payload on some lane, because a declared output contract that
// is not met is an error rather than an empty output. Any lane satisfies it.
function payloadOutput(ir, state, resolved) {
  let found;
  const failures = [];

  for (const request of observationsFor(ir, state)) {
    if (request.kind !== "payload") continue;
    const result = resolved[request.key];
    if (result === undefined) {
      failures.push(request.key + " (not resolved)");
    } else if (result.ok) {
      if (found === undefined) found = result.value;
    } else {
      failures.push(request.key + " (" + result.error + ")");
    }
  }

  const node = ir.nodes.find(function (candidate) {
    return candidate.id === state.node;
  });
  if (found === undefined && node !== undefined && node.schema !== undefined) {
    return {
      ok: false,
      error:
        'node "' +
        state.node +
        '" declares a schema but produced no readable payload: ' +
        failures.join(", ") +
        ". A declared output contract that is not met is an error, not an empty output.",
    };
  }

  return found === undefined ? { ok: true } : { ok: true, value: found };
}

// The state a departing transition leaves behind: the node's payload recorded as
// its output, and the retry budget of every edge out of the node cleared. The
// payload is cloned, because it arrives inside the caller's resolved map.
function departingState(ir, state, resolved) {
  const payload = payloadOutput(ir, state, resolved);
  if (!payload.ok) return { error: payload.error };

  const next = runningClone(state);
  if (payload.value !== undefined) next.outputs[state.node] = cloneJson(payload.value);
  next.attempts = withoutAttemptsFrom(next.attempts, ir, state.node);
  return next;
}

function isDepartureError(value) {
  return value !== null && typeof value === "object" && "error" in value;
}

function moveTo(next, target, via, event) {
  next.steps += 1;
  if (isEnd(target)) {
    return { kind: "end", via: via, state: next };
  }
  next.node = target;
  return { kind: "advance", to: target, via: via, event: event, state: next };
}

function fireEdge(ir, state, resolved, edge) {
  if (edge.gate !== undefined) {
    if (isEnd(edge.goto)) {
      // A park writes the destination into state.node, and END is not a node:
      // the parked run would point at a marker no lookup can resolve, so the
      // resume would come back unknown-node and the run would be stranded.
      return errorTransition(
        state,
        "invalid-graph",
        "edge " +
          edge.id +
          ' out of "' +
          state.node +
          '" is gated and goes to END, which cannot be executed: a run parked at a gate resumes ' +
          "into its destination, and END is not a node to resume into, so the parked run could " +
          "never be resumed. Route the gate at a real node and end the run from there.",
      );
    }
    const next = departingState(ir, state, resolved);
    if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
    next.status = "awaiting";
    next.gate = edge.gate;
    next.node = edge.goto;
    return { kind: "gate", gate: edge.gate, to: edge.goto, via: edge.id, state: next };
  }
  const next = departingState(ir, state, resolved);
  if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
  return moveTo(next, edge.goto, edge.id, edge.event);
}

function applyOtherwise(ir, state, resolved, edge, otherwise) {
  if (otherwise.kind === "goto") {
    // A divert is not the edge's declared event, so it is not labelled with it.
    const next = departingState(ir, state, resolved);
    if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
    return moveTo(next, otherwise.node, edge.id, OTHERWISE_EVENT);
  }

  const attempt = (state.attempts[edge.id] === undefined ? 0 : state.attempts[edge.id]) + 1;
  const next = runningClone(state);
  next.attempts[edge.id] = attempt;
  if (edge.limit !== undefined && attempt > edge.limit) {
    return {
      kind: "error",
      code: "retry-limit-exceeded",
      message:
        "edge " +
        edge.id +
        ' would retry node "' +
        state.node +
        '" a ' +
        ordinal(attempt) +
        " time, past its limit of " +
        edge.limit,
      state: next,
    };
  }
  next.steps += 1;
  return {
    kind: "retry",
    node: state.node,
    via: edge.id,
    reason: otherwise.reason,
    attempt: attempt,
    state: next,
  };
}

function ordinal(value) {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return value + "th";
  switch (value % 10) {
    case 1:
      return value + "st";
    case 2:
      return value + "nd";
    case 3:
      return value + "rd";
    default:
      return value + "th";
  }
}

// Decide the transition out of state.node. Ordered deliberately: a graph edited
// mid-run must not be resumed against nodes that may no longer mean the same
// thing, so nothing else is trusted until the hash matches.
function evaluate(ir, state, resolved, opts) {
  if (state.graphHash !== ir.hash) {
    return errorTransition(
      state,
      "graph-hash-mismatch",
      "run " +
        state.runId +
        " started against graph " +
        state.graphHash +
        ", but this graph hashes to " +
        ir.hash,
    );
  }

  if (
    !ir.nodes.some(function (node) {
      return node.id === state.node;
    })
  ) {
    return errorTransition(
      state,
      "unknown-node",
      'node "' + state.node + '" is not part of workflow "' + ir.name + '"',
    );
  }

  const ceiling =
    opts !== undefined && opts !== null && opts.stepCeiling !== undefined
      ? opts.stepCeiling
      : DEFAULT_STEP_CEILING;
  if (state.steps >= ceiling) {
    return errorTransition(
      state,
      "step-ceiling-exceeded",
      "run " +
        state.runId +
        " has taken " +
        state.steps +
        " steps, at or past its ceiling of " +
        ceiling,
    );
  }

  const edges = ir.edges.filter(function (edge) {
    return edge.from === state.node;
  });

  for (const edge of edges) {
    const outcome = resolveGuard(edge.guard, resolved);
    if (!outcome.ok) {
      return errorTransition(state, "observation-failed", outcome.error);
    }
    if (outcome.holds) {
      return fireEdge(ir, state, resolved, edge);
    }
  }

  for (const edge of edges) {
    if (edge.otherwise === undefined) continue;
    return applyOtherwise(ir, state, resolved, edge, edge.otherwise);
  }

  return errorTransition(
    state,
    "no-matching-edge",
    'no edge out of "' + state.node + '" held, and none of them declares an otherwise',
  );
}

module.exports = {
  DEFAULT_PAYLOAD_SOURCE: DEFAULT_PAYLOAD_SOURCE,
  END: END,
  evaluate: evaluate,
  isEnd: isEnd,
  observationKey: observationKey,
  observationsFor: observationsFor,
};
`;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Everything in the dispatcher below its `PLUGIN` constant.
 *
 * Held apart from the interpolated header for one reason: `String.raw`. The body
 * is source code carrying regular expressions and string escapes, and a plain
 * template literal would eat the backslash in `\d` and emit a different program.
 * The header needs interpolation and has no escapes; the body has escapes and
 * needs no interpolation. Splitting them is what lets each be written plainly.
 *
 * The same constraint as {@link RUNTIME_SOURCE} applies: no backtick, no `${`.
 */
const DISPATCHER_BODY = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// The transition evaluator, vendored beside this file by the emitter run that
// compiled the graph. Required, never reimplemented: a dispatcher carrying its
// own copy of the transition rules would be a second semantics free to drift
// from the IR's, which is the whole thing the IR exists to prevent.
const runtime = require("./minflow-runtime.cjs");

// State belongs here and nowhere else. Never reconstruct this path: the config
// dir moves with $CLAUDE_CONFIG_DIR, and a plugin loaded with --plugin-dir gets
// the id "{name}-inline". Never write state under $CLAUDE_PLUGIN_ROOT either,
// since that path changes on every plugin update.
const DATA = process.env.CLAUDE_PLUGIN_DATA || "";
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, "..");

// Guard commands and the relative paths a graph names belong to the user's
// repository, so they are resolved against the project directory the hook
// environment reports rather than against whatever cwd this process inherited.
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Comfortably inside the platform's own hook timeout, because a hook that times
// out is cancelled with its output discarded and renders no decision at all. A
// guard that hangs should be reported here, where the message survives.
const GUARD_TIMEOUT_MS = 45000;

// Hook output is capped at 10,000 characters, so a payload quoted into a judge
// question gets a budget well inside that cap.
const QUESTION_PAYLOAD_LIMIT = 4000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function statePath(runId) {
  return path.join(DATA, "runs", runId + ".json");
}

// The session pointer, not the state itself. State keys on a run id because a
// run parked at a gate has to be resumable from a session that did not start it
// (SPEC D11); session_id is a hint that finds the run, never the key.
function sessionPath(sessionId) {
  return path.join(DATA, "sessions", sessionId + ".json");
}

function loadState(runId) {
  return runId ? readJson(statePath(runId)) : null;
}

function saveState(state) {
  writeJson(statePath(state.runId), state);
}

function deleteState(runId) {
  try {
    fs.unlinkSync(statePath(runId));
  } catch (error) {
    // Already gone is the desired end state.
  }
}

function runIdForSession(sessionId) {
  const pointer = readJson(sessionPath(sessionId));
  return pointer && typeof pointer.runId === "string" ? pointer.runId : null;
}

function linkSession(sessionId, runId) {
  writeJson(sessionPath(sessionId), { runId: runId, at: new Date().toISOString() });
}

// Every run parked at a gate, which is how a resume finds its run from a session
// that never started it. Reading a directory of small JSON files is the whole
// index: there is no second one to keep consistent with the state files.
function parkedRuns(gate) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(DATA, "runs"));
  } catch (error) {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.slice(-5) !== ".json") continue;
    const state = readJson(path.join(DATA, "runs", entry));
    if (state === null || state.status !== "awaiting" || state.gate !== gate) continue;
    found.push(state);
  }
  return found;
}

// Append-only, and it outlives the run: "why did this loop three times?" has to
// stay answerable after the state file is deleted.
function appendTrace(runId, entry) {
  const file = path.join(DATA, "trace", (runId || "unassigned") + ".jsonl");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (error) {
    process.stderr.write("minflow: could not write trace: " + error.message + "\n");
  }
}

// The actuation channel: a blocked SubagentStop hands the runner its next
// instruction. Verified by the spike: the runner stops, the dispatcher blocks,
// the named child appears.
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: reason }));
}

// Everything that is not a routing decision. A run that cannot proceed says so
// here and renders no decision, because the alternative to stopping visibly is
// looping invisibly.
function report(message) {
  process.stderr.write("minflow: " + message + "\n");
}

function loadGraph() {
  const graph = readJson(path.join(ROOT, PLUGIN.graphFile));
  if (graph === null || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  if (typeof graph.hash !== "string") return null;
  return graph;
}

// The graph, or null with the reason already reported. Every route needs it, and
// a plugin whose graph file is missing or unreadable can route nothing at all.
function requireGraph() {
  const graph = loadGraph();
  if (graph === null) {
    report(
      "could not read the compiled graph at " + PLUGIN.graphFile +
        ". This plugin is incomplete; regenerate it.",
    );
  }
  return graph;
}

function mintRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return "run-" + stamp + "-" + crypto.randomBytes(3).toString("hex");
}

function inProject(target) {
  return path.isAbsolute(target) ? target : path.join(PROJECT, target);
}

function qualified(name) {
  return PLUGIN.name + ":" + name;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

// What the step at this node has to deliver, derived from the graph at run time
// rather than baked in here: the same observations the evaluator will ask for
// are the ones the step must satisfy, so the two cannot disagree.
function deliveryFor(graph, state) {
  const files = [];
  let inline = false;
  let requests = [];
  try {
    requests = runtime.observationsFor(graph, state);
  } catch (error) {
    requests = [];
  }
  for (const request of requests) {
    if (request.kind !== "payload" && request.kind !== "judge") continue;
    const from = request.from || { lane: "inline" };
    if (from.lane === "file") {
      if (files.indexOf(from.path) === -1) files.push(from.path);
    } else {
      inline = true;
    }
  }
  return { inline: inline, files: files };
}

// The instruction the runner acts on: spawn one named agent, pass it one text.
// The runner has the Agent tool and nothing else, so this is the only shape it
// can execute, and paraphrase is the standing risk (SPEC L7).
function stepInstruction(graph, state) {
  const agent = PLUGIN.agents[state.node];
  if (typeof agent !== "string") return null;
  const delivery = deliveryFor(graph, state);
  const task = ['Run step "' + state.node + '" of the "' + PLUGIN.workflow + '" workflow.'];
  for (const file of delivery.files) {
    task.push("Write your JSON payload to " + file + ", relative to the project root.");
  }
  if (delivery.inline) {
    task.push(
      "End your final message with your JSON payload as a single fenced json block, with " +
        "nothing after it.",
    );
  }
  return [
    "Spawn the subagent " + qualified(agent) + " with the Agent tool, and pass it exactly this " +
      "text, verbatim:",
    "",
    task.join(" "),
  ].join("\n");
}

// A run segment starts in the main conversation, which has to spawn the runner
// before the runner can spawn anything. Both levels are named explicitly so no
// reader has to infer which agent the instruction is for.
function runnerReason(headline, instruction) {
  return [
    "minflow: " + headline,
    "",
    "Spawn the subagent " + PLUGIN.runner + " with the Agent tool, and give it exactly this " +
      "instruction, verbatim:",
    "",
    instruction,
    "",
    "Do not do the work yourself, and spawn nothing else.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Payloads, and what the platform does to them
// ---------------------------------------------------------------------------

// Claude Code scans a subagent's final report and may prepend a marker line of
// its own (SPEC L17), so the inline lane starts by dropping any leading marker.
// Blank leading lines go with it, since neither carries payload.
function withoutMarkerLines(text) {
  const lines = String(text).split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (line === "" || /^\[harness:/i.test(line)) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
}

// The same scan can insert backslashes into instruction-shaped text (SPEC L17).
// A stray backslash is invalid JSON on its own, since a JSON string admits only
// the escapes listed here, so removing exactly those is a repair of text that
// could not have parsed anyway rather than a licence to rewrite the payload.
function withoutStrayEscapes(text) {
  return text.replace(/\\(?!["\\\/bfnrtu])/g, "");
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    try {
      return { ok: true, value: JSON.parse(withoutStrayEscapes(text)) };
    } catch (second) {
      return { ok: false, error: second.message };
    }
  }
}

// Every balanced brace or bracket span at the top level of the text, in order,
// so a payload can be recovered from a message that wraps prose around it.
// String-aware, so a brace inside a JSON string does not close the span.
function jsonSpans(text) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        spans.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return spans;
}

// The step is told to end its message with one fenced json block and nothing
// after it, so the last fenced block is tried first. The looser candidates exist
// because a parse failure is an error that stops the run, not a false guard, and
// a recoverable payload should not become one.
function parseInlinePayload(message) {
  const text = withoutMarkerLines(message === null || message === undefined ? "" : String(message));
  if (text.trim() === "") {
    return {
      ok: false,
      error: "the runner's final message was empty, so there is no payload in it",
    };
  }
  const candidates = [];
  // \x60 is a backtick. Written as an escape because this file is generated from
  // a template literal, which a literal backtick would end.
  const fenced = /\x60\x60\x60[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\x60\x60\x60/g;
  let match = fenced.exec(text);
  while (match !== null) {
    const language = (match[1] || "").toLowerCase();
    if (language === "" || language === "json") candidates.unshift(match[2]);
    match = fenced.exec(text);
  }
  const spans = jsonSpans(text);
  for (let index = spans.length - 1; index >= 0; index -= 1) candidates.push(spans[index]);
  candidates.push(text);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed;
  }
  return {
    ok: false,
    error: "no JSON payload could be parsed out of the runner's final message",
  };
}

function readPayloadFile(target) {
  const file = inProject(target);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, error: "could not read the payload at " + target + ": " + error.message };
  }
  const parsed = tryParse(text);
  if (parsed.ok) return parsed;
  return { ok: false, error: "the payload at " + target + " is not valid JSON: " + parsed.error };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

// A command that could not be run, or was killed, is not a command that failed:
// we do not know the answer, so it resolves as a broken observation and the
// evaluator turns that into an error rather than a route down an otherwise.
function runGuardCommand(command) {
  const finished = childProcess.spawnSync(command, {
    shell: true,
    cwd: PROJECT,
    stdio: "ignore",
    timeout: GUARD_TIMEOUT_MS,
  });
  if (finished.error) {
    return { ok: false, error: "could not run " + command + ": " + finished.error.message };
  }
  if (typeof finished.status !== "number") {
    return {
      ok: false,
      error:
        "the guard command " + command + " was killed by " + finished.signal +
        " before it exited",
    };
  }
  return { ok: true, value: finished.status === 0 };
}

// The one place delivery is visible. Above this the run is JSON; below it there
// are files, exit codes and a final message.
function resolveRequest(request, event, scratch, answered) {
  if (request.kind === "exitZero") return runGuardCommand(request.command);
  if (request.kind === "fileExists") {
    return { ok: true, value: fs.existsSync(inProject(request.path)) };
  }
  if (request.kind === "payload") {
    const from = request.from || { lane: "inline" };
    if (from.lane === "file") return readPayloadFile(from.path);
    // The inline payload is whatever the runner said last, so it survives only
    // as long as the runner has not said anything since. A judge round trip
    // replaces it with a verdict, which is why it is cached for the visit.
    if (scratch.payload !== null) return { ok: true, value: scratch.payload.value };
    if (answered) {
      return {
        ok: false,
        error:
          "the inline payload is gone: the runner's last message was its answer to a judge " +
          "question, not the step's report. Read this payload from a file lane instead.",
      };
    }
    const parsed = parseInlinePayload(event.last_assistant_message);
    if (parsed.ok) scratch.payload = { value: parsed.value };
    return parsed;
  }
  return { ok: false, error: "unsupported observation kind " + request.kind };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

// Quotes, emphasis and trailing punctuation are what a model adds to a one-word
// answer. Stripping them is tolerance, not interpretation: the word itself still
// has to match a declared verdict.
function stripEdges(value) {
  return String(value)
    .trim()
    .replace(/^[\s"'\x60*_(\[{<.,:;!?-]+/, "")
    .replace(/[\s"'\x60*_)\]}>.,:;!?-]+$/, "")
    .trim();
}

// The verdict a reply carries. An answer that matches nothing declared is
// recorded as it arrived rather than repaired: the evaluator refuses an
// undeclared verdict, and a run that stops on a bad answer is better than one
// that routes on a guessed one.
function normalizeVerdict(message, verdicts) {
  const text = withoutMarkerLines(message === null || message === undefined ? "" : String(message));
  const lines = text
    .split("\n")
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line !== "";
    });
  const last = lines.length === 0 ? "" : lines[lines.length - 1];
  const cleaned = stripEdges(last);
  if (!Array.isArray(verdicts) || verdicts.length === 0) return cleaned;
  const candidates = [cleaned].concat(
    cleaned.split(/\s+/).map(function (word) {
      return stripEdges(word);
    }),
  );
  for (const candidate of candidates) {
    for (const verdict of verdicts) {
      if (candidate.toLowerCase() === String(verdict).toLowerCase()) return verdict;
    }
  }
  return cleaned;
}

// A command hook cannot ask the model anything, and hooks matching one event run
// in parallel rather than in sequence, so a prompt hook cannot be piped into this
// one. A verdict is therefore obtained the only way left: ask, and be called
// again. state.host is where the asking is remembered between those two calls.
// The evaluator carries it through untouched and never reads it.
function scratchFor(state) {
  const fresh =
    { node: state.node, steps: state.steps, answers: {}, asking: null, payload: null, start: false };
  const host = state.host;
  if (host === null || host === undefined || typeof host !== "object") return fresh;
  // Scoped to this visit of this node. Every departure and every retry bumps
  // steps, so a second lap round a loop cannot reuse the verdict the first lap
  // collected, and a stale answer can never decide a fresh visit.
  if (host.node !== state.node || host.steps !== state.steps) return fresh;
  return {
    node: state.node,
    steps: state.steps,
    answers:
      host.answers && typeof host.answers === "object" ? Object.assign({}, host.answers) : {},
    asking: host.asking || null,
    payload: host.payload && typeof host.payload === "object" ? host.payload : null,
    // Set when a run segment has just been started or resumed by a command, and
    // the runner has therefore not run a step yet.
    start: host.start === true,
  };
}

function withScratch(state, scratch) {
  const host = { node: scratch.node, steps: scratch.steps, answers: scratch.answers };
  if (scratch.asking !== null) host.asking = scratch.asking;
  if (scratch.payload !== null) host.payload = scratch.payload;
  if (scratch.start === true) host.start = true;
  return Object.assign({}, state, { host: host });
}

// If a question was outstanding, this call is its answer.
function takeAnswer(scratch, event) {
  const asking = scratch.asking;
  if (asking === null) return false;
  scratch.answers[asking.key] = normalizeVerdict(event.last_assistant_message, asking.verdicts);
  scratch.asking = null;
  return true;
}

function clip(text) {
  if (text.length <= QUESTION_PAYLOAD_LIMIT) return text;
  return text.slice(0, QUESTION_PAYLOAD_LIMIT) + "\n... truncated: hook output is capped.";
}

function judgeReason(request, state) {
  const verdicts = Array.isArray(request.verdicts) && request.verdicts.length > 0
    ? request.verdicts
    : null;
  const lines = [
    'minflow: the "' + PLUGIN.workflow + '" workflow needs one verdict before it can route out ' +
      'of step "' + state.node + '".',
    "",
    "Question: " + request.question,
    "",
    verdicts === null
      ? "Answer with exactly one word and nothing else: no punctuation, no explanation, no code, " +
        "and do not spawn anything."
      : "Answer with exactly one of these words and nothing else: " + verdicts.join(", ") +
        ". No punctuation, no explanation, no code, and do not spawn anything.",
  ];
  const from = request.from || { lane: "inline" };
  if (from.lane === "file") {
    // The runner has the Agent tool and nothing else, so it cannot open the
    // file. Quoting the payload into the question is the only way it can see it.
    const payload = readPayloadFile(from.path);
    lines.push("");
    if (payload.ok) {
      lines.push("Judge this payload, read from " + from.path + ":");
      lines.push("");
      lines.push(clip(JSON.stringify(payload.value, null, 2)));
    } else {
      lines.push(
        "The payload at " + from.path + " could not be read (" + payload.error +
          "). Answer from the report you just returned.",
      );
    }
  } else {
    lines.push("");
    lines.push("Judge the JSON payload in the report you just returned.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UserPromptExpansion
// ---------------------------------------------------------------------------

function commandArgument(event) {
  const args = event.command_args;
  if (typeof args === "string") return args.trim();
  if (Array.isArray(args)) return args.join(" ").trim();
  return "";
}

function startRun(event, sessionId) {
  const graph = requireGraph();
  if (graph === null) return;
  if (graph.hash !== PLUGIN.graphHash) {
    report(
      "this dispatcher was generated for graph " + PLUGIN.graphHash + " but " + PLUGIN.graphFile +
        " hashes to " + graph.hash + ". Regenerate the plugin.",
    );
    return;
  }
  const runId = mintRunId();
  const state = {
    runId: runId,
    graphHash: PLUGIN.graphHash,
    node: PLUGIN.entry,
    status: "running",
    attempts: {},
    steps: 0,
    outputs: {},
  };
  if (typeof PLUGIN.agents[state.node] !== "string") {
    report(
      'no agent is registered for the entry node "' + state.node + '". Regenerate the plugin.',
    );
    return;
  }
  // Marked as not yet started, then no decision is rendered. Blocking here would
  // be wrong: on this event a block CANCELS the command's expansion and prints
  // the reason, rather than handing the conversation an instruction the way a
  // blocked SubagentStop hands one to the runner. Measured, after assuming
  // otherwise. Letting the expansion through is what puts the command's own body
  // in front of the model, and that body is what spawns the runner.
  saveState(withScratch(state, { node: state.node, steps: state.steps, answers: {},
    asking: null, payload: null, start: true }));
  linkSession(sessionId, runId);
  appendTrace(runId, {
    at: new Date().toISOString(),
    decision: "start",
    session: sessionId,
    run: runId,
    node: state.node,
  });
}

// A gate resume may arrive in a session that never started the run, which is the
// whole point of parking on a run id rather than a session (SPEC D11). The run is
// named explicitly if the user named it, then taken from this session, then from
// the gate if exactly one run is parked at it. Anything else is ambiguous, and
// releasing the wrong run is worse than asking.
function parkedRunFor(gate, event, sessionId) {
  const named = commandArgument(event);
  const candidates = parkedRuns(gate);
  if (named !== "") {
    for (const state of candidates) {
      if (state.runId === named) return { state: state };
    }
    return { error: 'no run named "' + named + '" is parked at the "' + gate + '" gate.' };
  }
  const linked = runIdForSession(sessionId);
  for (const state of candidates) {
    if (state.runId === linked) return { state: state };
  }
  if (candidates.length === 1) return { state: candidates[0] };
  if (candidates.length === 0) {
    return { error: 'no run is parked at the "' + gate + '" gate.' };
  }
  const ids = candidates.map(function (state) {
    return state.runId;
  });
  return {
    error:
      candidates.length + ' runs are parked at the "' + gate + '" gate: ' + ids.join(", ") +
      ". Name one, as /" + PLUGIN.gates[gate].resume + " <run id>.",
  };
}

function releaseGate(event, sessionId, gate) {
  const found = parkedRunFor(gate, event, sessionId);
  if (found.error) {
    report(found.error);
    return;
  }
  const graph = requireGraph();
  if (graph === null) return;
  const parked = found.state;
  if (parked.graphHash !== graph.hash) {
    report(
      "run " + parked.runId + " started against graph " + parked.graphHash + ", but " +
        PLUGIN.graphFile + " now hashes to " + graph.hash +
        ". Refusing to resume it: its nodes may have moved.",
    );
    return;
  }
  const state = Object.assign({}, parked, { status: "running" });
  delete state.gate;
  delete state.host;
  if (typeof PLUGIN.agents[state.node] !== "string") {
    report('no agent is registered for node "' + state.node + '". Regenerate the plugin.');
    return;
  }
  // Not blocked, for the reason given in startRun: the resume command's body is
  // what reaches the model and spawns a fresh runner.
  saveState(withScratch(state, { node: state.node, steps: state.steps, answers: {},
    asking: null, payload: null, start: true }));
  linkSession(sessionId, state.runId);
  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: "resume",
    session: sessionId,
    run: state.runId,
    gate: gate,
    node: state.node,
  });
}

function abandonGate(event, sessionId, gate) {
  const found = parkedRunFor(gate, event, sessionId);
  if (found.error) {
    report(found.error);
    return;
  }
  const parked = found.state;
  deleteState(parked.runId);
  appendTrace(parked.runId, {
    at: new Date().toISOString(),
    decision: "reject",
    session: sessionId,
    run: parked.runId,
    gate: gate,
    node: parked.node,
  });
  // No decision: rejecting is the end of the run, so there is nothing to spawn.
  report(
    "run " + parked.runId + ' is abandoned at the "' + gate + '" gate and its state is deleted. ' +
      "Work already written to the repository is untouched; this ends the run, it does not roll " +
      "it back.",
  );
}

function onCommand(event, sessionId, command) {
  if (command === PLUGIN.runCommand) return startRun(event, sessionId);
  for (const gate of Object.keys(PLUGIN.gates)) {
    if (command === PLUGIN.gates[gate].resume) return releaseGate(event, sessionId, gate);
    if (command === PLUGIN.gates[gate].reject) return abandonGate(event, sessionId, gate);
  }
  // The matcher should have kept us out of this one. Render no decision rather
  // than guess at what an unrecognised command was supposed to mean.
}

// ---------------------------------------------------------------------------
// SubagentStop
// ---------------------------------------------------------------------------

function act(graph, state, transition) {
  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: transition.kind,
    run: state.runId,
    node: state.node,
    via: transition.via === undefined ? null : transition.via,
    to: transition.to === undefined ? null : transition.to,
    steps: transition.state.steps,
  });

  if (transition.kind === "advance") {
    const instruction = stepInstruction(graph, transition.state);
    if (instruction === null) {
      report('no agent is registered for node "' + transition.to + '". Regenerate the plugin.');
      return;
    }
    saveState(transition.state);
    block(
      [
        'minflow: step "' + state.node + '" is done; the run advances to "' + transition.to + '".',
        "",
        instruction,
      ].join("\n"),
    );
    return;
  }

  if (transition.kind === "retry") {
    const instruction = stepInstruction(graph, transition.state);
    if (instruction === null) {
      report('no agent is registered for node "' + transition.node + '". Regenerate the plugin.');
      return;
    }
    saveState(transition.state);
    block(
      [
        'minflow: step "' + transition.node + '" runs again, attempt ' + transition.attempt + ": " +
          transition.reason,
        "",
        instruction,
      ].join("\n"),
    );
    return;
  }

  if (transition.kind === "gate") {
    // No decision. A human gate ends the run segment: subagents cannot ask the
    // user anything, so sign-off arrives as a command in a later turn, possibly
    // in a later session (SPEC section 3.9).
    saveState(transition.state);
    const commands = PLUGIN.gates[transition.gate];
    report(
      "run " + state.runId + ' is parked at the "' + transition.gate + '" gate, before step "' +
        transition.to + '". Run /' + (commands ? commands.resume : transition.gate) +
        " to continue" + (commands ? ", or /" + commands.reject + " to abandon it" : "") + ".",
    );
    return;
  }

  if (transition.kind === "end") {
    // No decision, and the state is gone: the trace is what survives a finished
    // run.
    deleteState(state.runId);
    report("run " + state.runId + ' finished at step "' + state.node + '".');
    return;
  }

  // error. Saved rather than deleted, so the state that could not be routed is
  // still there to look at, and no decision, so the run stops here instead of
  // looping.
  saveState(transition.state);
  report("run " + state.runId + " stopped: [" + transition.code + "] " + transition.message);
}

function onSubagentStop(event, state) {
  // No state means this runner is not ours, or its run is already finished.
  // Saying nothing is the whole of the zero-idle-footprint requirement (D9).
  if (state === null) return;
  if (state.status !== "running") return;

  const graph = requireGraph();
  if (graph === null) return;
  // Checked here as well as inside the evaluator, so that a graph edited mid-run
  // is refused before any guard command is run against it.
  if (state.graphHash !== graph.hash) {
    report(
      "run " + state.runId + " started against graph " + state.graphHash + ", but " +
        PLUGIN.graphFile + " now hashes to " + graph.hash +
        ". Refusing to resume it: its nodes may have moved. Start a fresh run.",
    );
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "graph-hash-mismatch",
      run: state.runId,
      node: state.node,
    });
    return;
  }

  const scratch = scratchFor(state);

  // The first stop of a run segment. The runner was spawned by a command and
  // told only to stand by, so no step has run and there is nothing to evaluate
  // yet: evaluating here would test this node's outgoing guards before the node
  // itself had produced anything. Hand it the step instead. This is the same
  // block-and-redirect the spike verified on this event.
  if (scratch.start === true) {
    const first = stepInstruction(graph, state);
    if (first === null) {
      report('no agent is registered for node "' + state.node + '". Regenerate the plugin.');
      return;
    }
    scratch.start = false;
    saveState(withScratch(state, scratch));
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "begin",
      run: state.runId,
      node: state.node,
    });
    block(
      runnerReason(
        'run ' + state.runId + ' of the "' + PLUGIN.workflow + '" workflow begins at step "' +
          state.node + '".',
        first,
      ),
    );
    return;
  }

  const answered = takeAnswer(scratch, event);

  const resolved = {};
  let outstanding = null;
  for (const request of runtime.observationsFor(graph, state)) {
    if (request.kind === "judge") {
      const answer = scratch.answers[request.key];
      // The loop is not cut short at the first unanswered question: the inline
      // payload has to be read on this pass, while the runner's last message is
      // still the step's report rather than the answer to come.
      if (answer === undefined) {
        if (outstanding === null) outstanding = request;
        continue;
      }
      resolved[request.key] = { ok: true, value: answer };
      continue;
    }
    resolved[request.key] = resolveRequest(request, event, scratch, answered);
  }

  if (outstanding !== null) {
    scratch.asking = {
      key: outstanding.key,
      question: outstanding.question,
      verdicts: Array.isArray(outstanding.verdicts) ? outstanding.verdicts : null,
    };
    saveState(withScratch(state, scratch));
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "ask",
      run: state.runId,
      node: state.node,
      question: outstanding.question,
    });
    block(judgeReason(outstanding, state));
    return;
  }

  act(graph, state, runtime.evaluate(graph, state, resolved));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(event) {
  if (DATA === "") {
    process.stderr.write(
      "minflow: $CLAUDE_PLUGIN_DATA is not set in the hook environment. Refusing to guess a " +
        "state directory; this run cannot be routed.\n",
    );
    return;
  }

  const sessionId = typeof event.session_id === "string" ? event.session_id : "unknown-session";
  const runId = runIdForSession(sessionId);
  const state = loadState(runId);

  appendTrace(runId, {
    at: new Date().toISOString(),
    event: event.hook_event_name || null,
    agent: event.agent_type || null,
    session: sessionId,
    run: runId,
    node: state ? state.node : null,
    status: state ? state.status : null,
    // The event's own field names, recorded because a payload that changes shape
    // under us is otherwise invisible from a trace.
    fields: Object.keys(event).sort(),
  });

  // stop_hook_active is deliberately ignored. It marks a runner that is already
  // continuing because of a stop hook, which here is every step after the first:
  // bailing on it would end every run one step in. Runaway protection is the
  // graph's own, the retry limits and the step ceiling the evaluator enforces.
  if (event.hook_event_name === "SubagentStop") return onSubagentStop(event, state);

  const command = typeof event.command_name === "string" ? event.command_name : "";
  if (command !== "") return onCommand(event, sessionId, command);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  input += chunk;
});
process.stdin.on("end", function () {
  let event = {};
  try {
    event = JSON.parse(input || "{}");
  } catch (error) {
    event = {};
  }
  try {
    main(event);
  } catch (error) {
    process.stderr.write("minflow: dispatcher failed: " + (error && error.stack) + "\n");
  }
  // Deliberately not process.exit(). Writes to a pipe are asynchronous on
  // Windows, and exiting on the spot can truncate the decision that is this
  // process's entire output. There is nothing left holding the loop open once
  // stdin has ended, so returning here exits 0 as soon as stdout has drained.
  process.exitCode = 0;
});
`;

/**
 * The generated dispatcher.
 *
 * Thin on purpose (D8): the graph is data in `workflow.compiled.json` and the
 * transition rules are data-driven code in {@link RUNTIME_PATH}, so the only
 * thing baked in here is the handful of names the hook environment cannot
 * supply. Nothing graph-shaped is inlined, which is why a guard command or a
 * judge question never appears in this file.
 *
 * It reads the hook event from stdin, finds its state under
 * `$CLAUDE_PLUGIN_DATA`, and routes: a command starts, resumes or abandons a
 * run; a stopped runner has its observations resolved, the transition evaluated
 * by the vendored evaluator, and the result actuated as a `block` decision or as
 * no decision at all.
 */
function dispatcherFor(
  ir: WorkflowIr,
  pluginName: string,
  runCommand: string,
  names: Record<NodeId, string>,
): string {
  // Namespaced, because these are compared against the hook payload's
  // `command_name`, which always arrives as `<plugin>:<command>`. Storing the
  // bare names here would leave the dispatcher unable to recognise the very
  // commands its own matcher let through.
  const gates: Record<string, JsonValue> = {};
  for (const gate of gatesOf(ir)) {
    gates[gate.gate] = {
      resume: qualified(pluginName, gate.resume),
      reject: qualified(pluginName, gate.reject),
    };
  }
  const constants: JsonValue = {
    name: pluginName,
    workflow: ir.name,
    graphHash: ir.hash,
    graphFile: COMPILED_GRAPH_PATH,
    entry: ir.entry,
    runCommand: qualified(pluginName, runCommand),
    runner: qualified(pluginName, RUNNER_AGENT),
    gates,
    agents: names,
  };

  // One line, always: this is a `//` comment, so a workflow name carrying a line
  // terminator would push the rest of the sentence onto its own line as code and
  // the .cjs would not parse, killing every hook fire, silently.
  return `#!/usr/bin/env node
"use strict";
// Generated by minflow from the workflow "${oneLine(ir.name)}". Do not edit: regenerate.
//
// This file is .cjs and not .js on purpose. Node decides CommonJS-vs-ESM from
// the nearest ancestor package.json, and a compiled plugin usually sits inside
// the user's repo. A dispatch.js under a "type": "module" package dies with
// "require is not defined" on every hook fire. Measured, not theorised.

// Names the hook environment cannot supply. Everything graph-shaped stays in
// ${COMPILED_GRAPH_PATH}, so a graph change is a JSON diff and a runtime fix is
// a version bump. No guard command, no judge question and no node id other than
// the entry appears below: this dispatcher routes any graph, and routes this one
// only because the JSON says so.
const PLUGIN = ${JSON.stringify(constants, null, 2)};

${DISPATCHER_BODY}`;
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

/**
 * Compile a graph into a Claude Code plugin, as a file map.
 *
 * Pure: no filesystem, no clock, no randomness, no mutation of `ir`. The same
 * graph and options produce a byte-identical map every time, which is what
 * makes the artifact testable and what makes a dirty rebuild in CI a real
 * signal (D24). Hand the result to {@link writeFiles} to put it on disk.
 *
 * "The same graph" means the same *value*: everything the graph carries verbatim
 * is rendered through {@link canonicalJson}, so two graphs `graphHash` certifies
 * as identical emit identical bytes even when their objects were built with
 * their keys in different orders.
 *
 * @param ir - A compiled graph, from `wf.compile()`.
 * @param opts - Naming and manifest metadata the graph cannot supply.
 * @returns Relative POSIX paths to file contents.
 */
export function emit(ir: WorkflowIr, opts: EmitOptions = {}): PluginFiles {
  const pluginName = pluginNameFor(ir, opts);
  const runCommand = opts.command ?? `run-${pluginName}`;
  const names = agentNames(ir);
  const commands = [runCommand];
  for (const gate of gatesOf(ir)) {
    commands.push(gate.resume, gate.reject);
  }

  const files: PluginFiles = {};
  files[MANIFEST_PATH] = manifestFor(ir, opts, pluginName);
  files[HOOKS_PATH] = hooksFor(pluginName, commands);
  files[DISPATCHER_PATH] = dispatcherFor(ir, pluginName, runCommand, names);
  // Byte-identical for every graph. The dispatcher requires it rather than
  // reimplementing the transition rules, and it travels with the plugin rather
  // than being resolved from a node_modules that an installed plugin does not
  // have; see {@link RUNTIME_SOURCE} for the alternatives and why they lose.
  files[RUNTIME_PATH] = RUNTIME_SOURCE;
  files[RUNNER_PATH] = runnerFor(ir, pluginName, runCommand);
  // Every alternative in the UserPromptExpansion matcher needs a command that
  // actually exists, or the hook is unreachable and the plugin is inert.
  files[`${COMMANDS_DIR}/${runCommand}.md`] = runCommandFile(ir, pluginName);
  Object.assign(files, gateCommandFiles(ir, pluginName));
  for (const node of ir.nodes) {
    const agent = names[node.id];
    if (agent === undefined) continue;
    files[`agents/${agent}.md`] = stepFor(ir, node, agent, obligationsFor(ir, node.id), pluginName);
  }
  // Canonical, not insertion-ordered: this file is the graph's value on disk, and
  // it has to match for two graphs `graphHash` calls identical.
  files[COMPILED_GRAPH_PATH] = canonicalJsonFile(ir);
  return files;
}

// ---------------------------------------------------------------------------
// writeFiles
// ---------------------------------------------------------------------------

/**
 * Write a file map under `destDir`, creating directories as needed.
 *
 * The whole of the emitter's I/O, kept trivial deliberately: everything worth
 * testing happened in {@link emit}, and this is a loop. Existing files are
 * overwritten and nothing is deleted, so regenerating over a stale directory
 * should be `rm -rf` then write (D7).
 *
 * @returns The absolute-or-relative paths written, in sorted order.
 */
export async function writeFiles(files: PluginFiles, destDir: string): Promise<string[]> {
  // Imported here rather than at module scope so that importing the pure half of
  // this module pulls in no Node built-ins at all.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const written: string[] = [];
  for (const relative of Object.keys(files).sort()) {
    const contents = files[relative];
    if (contents === undefined) continue;
    const target = path.join(destDir, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
    written.push(target);
  }
  return written;
}
