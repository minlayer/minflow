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
 *   lands inside the user's repo. A `dispatch.js` that inherits
 *   `"type": "module"` from an ancestor package, however many levels up, dies
 *   with `require is not defined` on every hook fire.
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
 *   commands nothing defines never runs. The result is a correct-looking plugin
 *   with an entrypoint that cannot be invoked.
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

import { observationsFor } from "../evaluate.js";
import { canonicalize } from "../hash.js";
import type {
  Graph,
  Guard,
  JsonValue,
  Node,
  NodeId,
  PayloadSource,
  RunState,
  StepNode,
} from "../ir.js";
import { DEFAULT_PAYLOAD_SOURCE, isCommandNode, templateOf } from "../ir.js";
import type { Skill } from "../skill.js";

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
/**
 * The line a runner says to carry an ask out to the session.
 *
 * Deliberately unlike anything a model writes by accident, because the command
 * body matches on it and a false positive sends the session hunting for a
 * questions file that was never written. The emitted dispatcher carries its own
 * copy of this literal, since it is generated as raw text rather than
 * interpolated; a test holds the two together.
 */
export const ASK_MARKER = "MINFLOW-ASK";

/** Where a plugin's skills live, per the Agent Plugins layout. */
export const SKILLS_DIR = "skills";

/** The file that makes a directory a skill. */
const SKILL_FILE_NAME = "SKILL.md";

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
  /**
   * Extra files to ship inside the plugin, as relative POSIX paths to contents.
   *
   * A compiled workflow usually needs something beside the graph: a script a
   * `when.exitZero` guard runs, a template a step fills in, a fixture a check
   * compares against. Without this they have to be written separately, which
   * makes a correct plugin the product of two steps instead of one, and makes
   * `emit`'s file map an incomplete description of what ships.
   *
   * Refused rather than merged when a path is absolute, escapes the plugin root,
   * or collides with a generated file. An asset quietly replacing the dispatcher
   * is a plugin that installs, validates, and cannot route.
   */
  assets?: Record<string, string>;
  /**
   * The skills this graph's steps name, which ship inside the plugin.
   *
   * **Every emitted copy is `user-invocable: false`.** A compiled workflow has
   * exactly one public surface, its entry command; its steps are implementation,
   * and a plugin exposing nine separately invocable skills alongside the command
   * has nine surfaces that mean nothing on their own. That is a property of what
   * a compiled workflow *is*, so it is imposed here rather than left to the
   * author to remember on every skill.
   *
   * The author's own files are never touched. These are copies, which is what a
   * compiler does with source.
   *
   * Supplying any skill means supplying all of them: a partial set would emit a
   * plugin that resolves some steps from inside itself and others from whatever
   * happens to be installed, which is worse than either.
   *
   * Omit entirely for the older shape, where skills are resolved from the user's
   * environment at run time and `checkSkills` is the only guard against one
   * having gone missing.
   */
  skills?: Skill[];
}

// ---------------------------------------------------------------------------
// Delivery obligations
// ---------------------------------------------------------------------------

/**
 * What the guards leaving a node read, derived from the graph.
 *
 * The author declares a payload lane per *edge*, because delivery is a property
 * of the reader (SPEC §6.3). This is the mirror image of that, per *node*: the
 * union of every lane the node's outgoing guards read. Nobody should
 * hand-maintain this: a step that is told to write `notes/research.json` is
 * told because an edge out of it reads that path, and the compiler knows.
 *
 * The guards are not the whole of a step's payload obligation, so the wrapper's
 * delivery section comes from {@link requestedLanes} instead: a node declaring a
 * `schema` is asked for its payload whether or not a guard reads it. `inline`
 * and `payloadFiles` here answer the narrower question of what the guards
 * themselves read.
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
export function obligationsFor(ir: Graph, nodeId: NodeId): DeliveryObligations {
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

/**
 * A run sitting at `nodeId`, which is the only thing `observationsFor` reads.
 *
 * The emitter has no run and never will: this is a probe, so that the question
 * "what will this node be asked for" can be put to the evaluator's own seam
 * rather than answered a second time here.
 */
function probeState(ir: Graph, nodeId: NodeId): RunState {
  return {
    runId: "",
    graphHash: ir.hash,
    node: nodeId,
    status: "running",
    attempts: {},
    steps: 0,
    outputs: {},
  };
}

/**
 * The payload lanes a step must deliver on: exactly the ones `observationsFor`
 * will ask the host to resolve when the step finishes.
 *
 * Derived from that function rather than restated from the guards, because the
 * two do not agree and the evaluator's answer is the one that decides a run. A
 * node declaring a `schema` is asked for its payload on the default lane even
 * when every guard leaving it reads a file, so a wrapper that read the guards
 * alone would tell such a step to write only its file and then fail it at run
 * time for the inline block nobody asked it for.
 */
function requestedLanes(ir: Graph, nodeId: NodeId): { inline: boolean; files: string[] } {
  const files: string[] = [];
  let inline = false;
  for (const request of observationsFor(ir, probeState(ir, nodeId))) {
    if (request.kind !== "payload" && request.kind !== "judge") continue;
    if (request.from.lane === "file") push(files, request.from.path);
    else inline = true;
  }
  return { inline, files };
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
export function pluginNameFor(ir: Graph, opts: EmitOptions = {}): string {
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
 * Strips the separators a command name may carry inside but not at either end.
 *
 * A name reduced to `.` or `..` by the fold is the traversal case, and it comes
 * out of here empty, which is what makes it a compile error rather than a write
 * one directory up.
 */
function trimCommandEnds(value: string): string {
  return value.replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * A command name folded into the charset a command may actually be named in.
 *
 * A command name is three things at once: the basename of a file under
 * {@link COMMANDS_DIR}, a literal embedded in an anchored matcher, and the
 * string the dispatcher compares the hook payload's `command_name` against. The
 * first of those is why a path separator can never survive: `../../evil` would
 * otherwise be written outside the plugin directory entirely. `.`, `_` and `-`
 * are kept because a command may legitimately carry a version, as in
 * `approve-v1.0`, and every matcher escapes what it embeds.
 *
 * Length is left alone, unlike a plugin or agent name. The 64-character cap on
 * those is a measured platform limit; no such limit was measured for a command,
 * and truncating would silently fold the default run command of any workflow
 * whose plugin name runs long onto its neighbours.
 */
function commandSlug(raw: string): string {
  return trimCommandEnds(raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"));
}

/**
 * A command name, or an error at compile time naming what to pass instead.
 *
 * Nothing surviving the fold is the same failure {@link pluginNameFor} refuses:
 * a command with no name defines no file, so the `UserPromptExpansion` matcher
 * that names it can never fire and the plugin installs, validates, and does
 * nothing.
 */
function commandNameFor(raw: string, source: string): string {
  const name = commandSlug(raw);
  if (name === "") {
    throw new Error(
      `minflow: cannot derive a command name from "${raw}" (${source}). Command names are ` +
        "a-z, 0-9, ., _ and -, starting and ending alphanumeric. " +
        'Pass one explicitly, e.g. emit(ir, { command: "run-my-workflow" }).',
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
export function agentNames(ir: Graph): Record<NodeId, string> {
  const names: Record<NodeId, string> = {};
  const taken = new Set<string>([RUNNER_AGENT]);
  for (const node of ir.nodes) {
    // A command node is run by the dispatcher, not spawned, so it has no agent
    // and gets no wrapper file. Leaving it out here is what makes that true
    // everywhere downstream, since the emit loop skips a node with no name.
    if (isCommandNode(node)) continue;
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

/**
 * Portable capability tiers, and what each one means on this platform.
 *
 * This is the whole of the translation the IR is missing (D28, L23). The graph
 * says how much capability a step deserves; this says which model that is here.
 * A tier is **relative to whatever ladder a deployment resolves**, not an
 * absolute capability claim, because a client is not a provider: Cursor and
 * Copilot each expose several providers' ladders at once, so "large" can only
 * ever mean the top of the ladder in play.
 *
 * Provider names still pass through, because removing them would be breaking and
 * every graph already written uses them. New graphs should use a tier: it is the
 * only one of the accepted spellings that survives a change of platform.
 */
const MODEL_TIERS: Record<string, string> = {
  small: "haiku",
  medium: "sonnet",
  large: "opus",
};

/** The names Claude Code documents for an agent's own model field. */
const MODEL_ALIASES = new Set(["haiku", "sonnet", "opus", "inherit"]);

/** An explicitly pinned Anthropic model, e.g. `claude-opus-5`. */
const MODEL_PIN = /^claude-[a-z0-9][a-z0-9.-]*$/;

/**
 * The model frontmatter value for a node, or a compile error.
 *
 * Validation lives here rather than in the builder for the reason the leak exists
 * at all: which model names are real is a fact about a platform, and the builder
 * is not allowed to know one. Putting it here also closes the hole that made this
 * worth writing down, since a misspelling used to reach the frontmatter verbatim
 * and produce an agent naming a model that does not exist.
 */
function resolveModel(model: string, nodeId: string): string {
  const tier = MODEL_TIERS[model];
  if (tier !== undefined) return tier;
  if (MODEL_ALIASES.has(model) || MODEL_PIN.test(model)) return model;
  throw new Error(
    `minflow: node "${nodeId}" asks for the model "${model}", which this backend does not ` +
      `recognise. Use a portable tier (${Object.keys(MODEL_TIERS).join(", ")}), one of Claude ` +
      `Code's own names (${[...MODEL_ALIASES].join(", ")}), or an explicit claude-* model id. ` +
      "A tier is preferred: it is the only one of the three that survives a change of platform.",
  );
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
 * Two collisions are possible and they are answered differently, because one is
 * declared and the other is derived.
 *
 * A *resume* command is the name the author wrote and the name a reviewer is
 * told to type, so a second claim on it is refused here, at compile time. A gate
 * claiming the run command is the sharp case: both would be written to
 * `commands/<name>.md`, the second overwriting the first, and the dispatcher
 * tests the run command first, so the gate could never be released. Silently
 * renaming it would leave the author's own documentation pointing at a command
 * that does something else.
 *
 * A *reject* command is derived, and deriving is lossy the same way sanitizing a
 * node id is: `approve-plan` and `plan` both derive `reject-plan`. Those step
 * aside with the same `-2`, `-3`, … scheme {@link agentNames} uses, since no
 * author wrote them down. Two gates sharing one reject command would silently
 * give the second gate no way to be rejected, and the first gate's command would
 * kill whichever run the dispatcher found first.
 */
function gatesOf(ir: Graph, runCommand: string): GateCommands[] {
  const resumes: { gate: string; resume: string }[] = [];
  const seen = new Set<string>();
  const taken = new Set<string>([runCommand]);
  for (const edge of ir.edges) {
    if (edge.gate === undefined || seen.has(edge.gate)) continue;
    seen.add(edge.gate);
    const resume = commandNameFor(edge.gate, `the gate "${edge.gate}"`);
    if (taken.has(resume)) {
      throw new Error(
        `minflow: the gate "${edge.gate}" needs the command "${resume}", which is already ` +
          (resume === runCommand
            ? "the command that starts a run. Both would be written to the same file, and the " +
              "dispatcher matches the run command first, so this gate could never be released. "
            : "another gate's resume command, and one command cannot release two gates. ") +
          "Rename the gate, or pass a different run command to emit().",
      );
    }
    taken.add(resume);
    resumes.push({ gate: edge.gate, resume });
  }

  const gates: GateCommands[] = [];
  for (const { gate, resume } of resumes) {
    // Derived from the folded resume command, never from the raw gate, so the
    // reject command is inside the command charset by construction.
    const base = rejectCommandFor(resume);
    let reject = base;
    let ordinal = 2;
    while (taken.has(reject)) {
      reject = `${base}-${ordinal}`;
      ordinal += 1;
    }
    taken.add(reject);
    gates.push({ gate, resume, reject });
  }
  return gates;
}

/** The two commands of each gate, by the gate's own name. */
function gateIndex(gates: GateCommands[]): Map<string, GateCommands> {
  return new Map(gates.map((gate) => [gate.gate, gate]));
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
// Prompt templates
// ---------------------------------------------------------------------------

/**
 * The two placeholder forms a node's prompt may carry (see `Node.prompt`).
 *
 * Held as sources rather than as regular expressions because a `g` flag carries
 * a `lastIndex` between calls, and the same pattern is both replaced with and
 * tested against. Surrounding whitespace is tolerated so that `{{ ctx.a.b }}`
 * and `{{ctx.a.b}}` are one reference rather than one reference and one hole.
 *
 * The dispatcher carries the same two patterns, because the compiled graph is
 * the IR verbatim and a run therefore sees the template rather than the copy
 * substituted into a wrapper here.
 */
const PARAM_REFERENCE = String.raw`\{\{\s*params\.([^{}\s]+?)\s*\}\}`;
const CTX_REFERENCE = String.raw`\{\{\s*ctx\.([^{}\s]+?)\s*\}\}`;
/**
 * Either form, so any rendered fragment can be tested for one. Composed from the
 * two above rather than written out a third time, since a placeholder minflow
 * substitutes has exactly one spelling and this file is where it is fixed.
 */
const ANY_REFERENCE = `(?:${PARAM_REFERENCE})|(?:${CTX_REFERENCE})`;

/**
 * A value interpolated into prose: a string as itself, anything else as its
 * canonical JSON.
 *
 * The string case is the one that has to be special. `canonicalize("notes.md")`
 * is `"notes.md"` with the quotes, and a quoted JSON literal dropped into the
 * middle of a sentence the author wrote is a different sentence.
 */
function interpolated(value: JsonValue): string {
  return typeof value === "string" ? value : canonicalize(value);
}

/**
 * Whether rendered text still names a value nothing here can supply.
 *
 * Both forms count, and a wrapper is checked for them wherever it quotes the
 * graph rather than only in its task. `ctx` is the obvious one: it reads a
 * payload that does not exist until the step it names has run.
 *
 * A residual `params` reference is the same fault by another route.
 * {@link promptWithParams} substitutes in one pass and never rescans what it
 * wrote, so a param whose own value is a template comes out of it still a
 * placeholder. Either way the model is shown a placeholder and reads it as part
 * of its instructions, which is the failure the deferral exists to prevent.
 */
function hasPlaceholder(text: string): boolean {
  return new RegExp(ANY_REFERENCE).test(text);
}

/**
 * `node.prompt` with the node's own params substituted, or `undefined` when the
 * node has no prompt.
 *
 * Params are fixed when the graph compiles, so this is the half of the template
 * a backend can resolve while it writes the file. The `ctx` half cannot be
 * resolved here at all: it reads a payload that does not exist until the step it
 * names has run.
 *
 * An unknown key is a compile error rather than a placeholder left in place. A
 * step handed a literal `{{params.depth}}` reads it as part of its instructions,
 * and nothing downstream can tell that apart from a task that meant to say that.
 */
function promptWithParams(node: Node): string | undefined {
  const prompt = templateOf(node);
  if (prompt === undefined) return undefined;
  const params = node.params ?? {};
  return prompt.replace(new RegExp(PARAM_REFERENCE, "g"), (_match: string, key: string) => {
    // Own properties only, so `{{params.constructor}}` is a missing param rather
    // than a walk up the prototype chain into something that is not JSON.
    const value = Object.hasOwn(params, key) ? params[key] : undefined;
    if (value === undefined) {
      throw new Error(
        `minflow: node "${node.id}" interpolates {{params.${key}}}, but declares no param ` +
          `"${key}". Declare it on the step, or correct the name in the prompt.`,
      );
    }
    return interpolated(value);
  });
}

/**
 * What a wrapper says in place of a prompt that still names run context.
 *
 * A `{{ctx.…}}` reference reads an earlier step's payload, which exists only
 * once that step has run, so this file can hold neither the resolved text nor
 * the unresolved text: a step shown a raw placeholder reads it as part of the
 * task, which is worse than being shown no task at all. The dispatcher resolves
 * it at spawn time and hands the whole task over in the instruction, so the
 * wrapper carries the static role and the instruction carries the concrete work.
 */
const DEFERRED_TASK = [
  "Your task quotes output from an earlier step, which exists only once the run reaches you,",
  "so it arrives in the instruction you are spawned with rather than here. Do what that",
  "instruction says.",
].join("\n");

/**
 * What a wrapper prints in place of a param value that is still a template.
 *
 * The Parameters section sits directly below the task and renders each value the
 * graph declares, so a value carrying template text puts in front of the model
 * exactly what the deferral above keeps out of it. The value is deferred rather
 * than printed for the same reason the task is: nothing at compile time can fill
 * it, and a placeholder shown to a step is read as part of the step's
 * instructions.
 */
const DEFERRED_VALUE = "(not resolved here; it arrives in the instruction you are spawned with)";

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

function manifestFor(ir: Graph, opts: EmitOptions, pluginName: string): string {
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
 * carry and what the dispatcher must compare against. Using the bare name in
 * either place, or emitting no commands at all, produces a plugin that installs,
 * reads correctly, and does nothing whatsoever.
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
function commandFor(description: string, body: string, argumentHint?: string): string {
  const fields: [string, string][] = [["description", yaml(oneLine(description))]];
  if (argumentHint !== undefined) fields.push(["argument-hint", yaml(argumentHint)]);
  return frontmatter(fields, body);
}

/**
 * The body of a command is what reaches the model, and on this event that is the
 * only thing that can.
 *
 * A hook cannot instruct the conversation here. Rendering a `block` decision on
 * `UserPromptExpansion` cancels the expansion and prints the reason, so the model
 * never sees the command at all. That is the opposite of `SubagentStop`, where a
 * block does hand the runner its next instruction, and the two events must not be
 * assumed to behave alike. The dispatcher therefore seeds state silently and lets
 * the expansion through, and this text is what spawns the runner.
 *
 * Which step runs first is deliberately not stated here, because a command file
 * is written at compile time and cannot know where a resumed run is parked. The
 * runner stands by, stops, and its `SubagentStop` is redirected with the real
 * step. That indirection is what makes one static command work for a fresh run
 * and for a run resumed at any node.
 */
const STAND_BY = "Stand by. You will be told which step to spawn. Spawn nothing until then.";

function spawnRunnerBody(pluginName: string, headline: string, hasAsks: boolean): string {
  const lines = [
    headline,
    "",
    `Spawn the subagent \`${qualified(pluginName, RUNNER_AGENT)}\` with the Agent tool, and give`,
    "it exactly this instruction, verbatim:",
    "",
    `> ${STAND_BY}`,
    "",
    "Do not do any of the workflow's own work yourself, and spawn nothing else. Report",
    "back whatever the runner returns.",
  ];
  if (hasAsks) lines.push("", askProtocolSection(pluginName));
  return lines.join("\n");
}

/**
 * The half of the ask protocol that runs in the session rather than in a hook.
 *
 * It lives in a command body because that is the only text this plugin can put
 * into the main conversation, and the main conversation is the only context that
 * can reach the user: a subagent has no question tool and no channel to the
 * terminal. The hook drives everything else; this is the one hand-off it cannot
 * make on its own.
 *
 * Emitted only for a graph that actually asks, so a workflow without asks
 * carries no instructions about a marker it will never see.
 */
function askProtocolSection(pluginName: string): string {
  return [
    `## If the runner reports \`${ASK_MARKER}\``,
    "",
    `Its final message will sometimes be exactly \`${ASK_MARKER} <path>\`. That means the`,
    "workflow needs answers from the user before it can continue. Every time you see it, do",
    "exactly this and nothing else:",
    "",
    `1. Read the JSON file at \`<path>\`. It holds a \`questions\` array and an \`answersPath\`.`,
    "2. Call the `AskUserQuestion` tool with those questions, verbatim. Do not add to them,",
    "   reword them, drop any of them, or answer them yourself.",
    "3. Write the user's answers to `answersPath` as a JSON object mapping each question's",
    "   `header` to the label the user picked. For a multi-select question, use an array of",
    "   labels. Create the file if it does not exist.",
    `4. Spawn \`${qualified(pluginName, RUNNER_AGENT)}\` again with the Agent tool and give it`,
    "   exactly this instruction, verbatim:",
    "",
    `   > ${STAND_BY}`,
    "",
    "Step 4 is not optional. The run is parked until that runner stops, and nothing else will",
    "restart it. This can happen several times in one run, so apply it on every marker.",
  ].join("\n");
}

function runCommandFile(ir: Graph, pluginName: string): string {
  // `--new` and `--from` are always offered, unlike `--auto`: every workflow can be
  // interrupted, so every workflow can be resumed, and every workflow gets edited, so
  // every workflow gets re-entered. The flags are how you say you meant to start over
  // rather than continue, and where you meant to start.
  const resumeHints =
    "[--new to start over instead of resuming] [--from <step> to start at one step with " +
    "an earlier run's results]";
  const hints = graphAsks(ir)
    ? `[--auto to answer the run's own questions instead of asking you] ${resumeHints}`
    : resumeHints;
  return commandFor(
    `Start or resume the "${ir.name}" workflow.`,
    spawnRunnerBody(
      pluginName,
      `Start the **${oneLine(ir.name)}** workflow, which begins at \`${ir.entry}\`.\n\n` +
        "If a previous run stopped part way through, this picks it up where it left off " +
        "instead of starting again, and says so. Everything already finished is kept.\n\n" +
        "`--from <step>` starts a fresh run at one step, carrying what an earlier run " +
        "produced, so nothing before that step runs again. It is how a workflow is tuned " +
        "without paying for every step in front of the one being changed.",
      graphAsks(ir),
    ),
    hints,
  );
}

/** Whether any edge in the graph raises an ask, which decides whether the protocol ships. */
function graphAsks(ir: Graph): boolean {
  return ir.edges.some((edge) => edge.ask !== undefined);
}

function gateCommandFiles(
  ir: Graph,
  pluginName: string,
  gates: GateCommands[],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const gate of gates) {
    files[`${COMMANDS_DIR}/${gate.resume}.md`] = commandFor(
      `Approve the "${gate.gate}" gate and continue the run.`,
      spawnRunnerBody(
        pluginName,
        `Release the **${oneLine(gate.gate)}** gate on the "${oneLine(ir.name)}" workflow, ` +
          "which is parked awaiting sign-off. It continues at whichever node it parked into.",
        graphAsks(ir),
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

function runnerFor(ir: Graph, pluginName: string, runCommand: string): string {
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

function stepBody(
  ir: Graph,
  node: StepNode,
  obligations: DeliveryObligations,
  pluginName: string,
  gates: Map<string, GateCommands>,
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

  const prompt = promptWithParams(node);
  if (prompt !== undefined) {
    sections.push(
      ["## Task", "", hasPlaceholder(prompt) ? DEFERRED_TASK : prompt.trimEnd()].join("\n"),
    );
  }

  const params = node.params;
  if (params !== undefined) {
    // Sorted, and each value canonically encoded: `params` is a record, so its
    // key order carries no meaning and never reaches the hash. Rendering it in
    // insertion order would make the emitted bytes depend on how the graph was
    // typed rather than on what it says.
    //
    // A value that is still a template is deferred instead of printed. The
    // rendered form is what gets tested, so a placeholder nested inside an
    // object or an array is caught along with a bare one.
    const lines = Object.keys(params)
      .sort()
      .map((key) => {
        const rendered = canonicalize(params[key]);
        return `- \`${key}\`: ${hasPlaceholder(rendered) ? DEFERRED_VALUE : rendered}`;
      });
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

  // The lanes the evaluator will ask the host for, not the lanes the guards
  // read: a node declaring a schema is asked for its payload either way, and a
  // step told less than it will be held to fails a contract it never saw.
  const lanes = requestedLanes(ir, node.id);
  const delivery: string[] = [];
  for (const path of lanes.files) {
    delivery.push(
      `- Write your JSON payload to \`${path}\`. A transition out of this step reads it from ` +
        "there, so the run stops if it is missing or unparseable.",
    );
  }
  if (lanes.inline) {
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
  const resumes: string[] = [];
  for (const edge of ir.edges) {
    if (edge.from !== node.id || edge.gate === undefined) continue;
    // The gate's own name is not its command name: a gate is named for the
    // sign-off it represents, and the command is that name folded into what a
    // command may be called.
    const found = gates.get(edge.gate);
    if (found === undefined || resumes.includes(found.resume)) continue;
    resumes.push(found.resume);
  }
  if (resumes.length > 0) {
    // Namespaced: the bare form is an unknown command, so telling the reviewer
    // to run `/approve-plan` would send them to a dead end.
    const commands = resumes.map((resume) => `\`/${qualified(pluginName, resume)}\``).join(" or ");
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
  ir: Graph,
  node: StepNode,
  agent: string,
  obligations: DeliveryObligations,
  pluginName: string,
  gates: Map<string, GateCommands>,
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
  if (node.model !== undefined) fields.push(["model", yaml(resolveModel(node.model, node.id))]);
  if (node.maxTurns !== undefined) fields.push(["maxTurns", String(node.maxTurns)]);
  if (node.tools !== undefined) fields.push(["tools", yamlNameList(node.tools)]);

  return frontmatter(fields, stepBody(ir, node, obligations, pluginName, gates));
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

// Whether a node is contracted to produce a readable payload. A step is when it
// declares a schema; a command node always is, since its exit code and output are
// the payload every guard leaving it reads.
function declaresPayload(node) {
  if (node === undefined) return false;
  return node.kind === "command" ? true : node.schema !== undefined;
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
  if (declaresPayload(node)) {
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
  // Carried, not dropped: it is a property of the run, not of a transition.
  if (state.auto !== undefined) next.auto = state.auto;
  return next;
}

// Copies the state as a live run: no gate, status running.
//
// The host scratch comes along here as much as in cloneState. It belongs to the
// host, and only the host knows when the multi-pass work it records is finished,
// so clearing it here would silently discard work, including work tracking the
// very node a retry is about to re-run. A host that wants it gone clears it on
// its own side, where the decision is informed.
function runningClone(state) {
  const next = {
    runId: state.runId,
    graphHash: state.graphHash,
    node: state.node,
    status: "running",
    attempts: Object.assign({}, state.attempts),
    steps: state.steps,
    outputs: Object.assign({}, state.outputs),
  };
  if (state.host !== undefined) next.host = Object.assign({}, state.host);
  // Carried, not dropped: it is a property of the run, not of a transition.
  if (state.auto !== undefined) next.auto = state.auto;
  return next;
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
  if (found === undefined && declaresPayload(node)) {
    return {
      ok: false,
      error:
        'node "' +
        state.node +
        '" ' +
        (node !== undefined && node.kind === "command"
          ? "is a command node, whose exit code and output are its payload, but produced none"
          : "declares a schema but produced no readable payload") +
        ": " +
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
  if (edge.ask !== undefined) {
    if (isEnd(edge.goto)) {
      return errorTransition(
        state,
        "invalid-graph",
        "edge " + edge.id + ' out of "' + state.node +
          '" asks on the way to END. A run mid-ask stores the node it will resume into, and ' +
          "END is not a node, so the answers could never be delivered anywhere.",
      );
    }
    const questions = askQuestions(ir, state, resolved, edge, edge.ask);
    if (typeof questions === "string") {
      return errorTransition(state, "invalid-graph", questions);
    }
    const next = departingState(ir, state, resolved);
    if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
    next.status = "asking";
    next.node = edge.goto;
    next.ask = {
      edge: edge.id,
      to: edge.goto,
      as: edge.ask.as,
      questions: questions,
      relayed: false,
    };
    return {
      kind: "ask",
      questions: questions,
      as: edge.ask.as,
      to: edge.goto,
      via: edge.id,
      state: next,
    };
  }
  const next = departingState(ir, state, resolved);
  if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
  return moveTo(next, edge.goto, edge.id, edge.event);
}

// The questions an ask puts, resolved to values, or the reason they cannot be.
function askQuestions(ir, state, resolved, edge, ask) {
  if (ask.questions.kind === "static") return ask.questions.items;

  const payload = payloadOutput(ir, state, resolved);
  if (!payload.ok) {
    return (
      "edge " + edge.id + ' out of "' + state.node +
        '" asks with questions read from its payload, but the payload could not be read: ' +
        payload.error
    );
  }
  const found =
    payload.value === undefined ? undefined : readPath(payload.value, ask.questions.path);
  if (found === undefined) {
    return (
      "edge " + edge.id + ' out of "' + state.node + '" asks with questions at "' +
        ask.questions.path +
        '" of its payload, and that path holds nothing. A step that raises an ask has to ' +
        "produce the questions it wants put."
    );
  }
  const problem = questionListProblem(found);
  if (problem !== undefined) {
    return (
      "edge " + edge.id + ' out of "' + state.node + '" asks with questions at "' +
        ask.questions.path + '" of its payload, but ' + problem
    );
  }
  return found;
}

// Why a value cannot be a question list, or undefined when it can. These came out
// of a model's payload and go straight into a dialog the user sees.
function questionListProblem(value) {
  if (!Array.isArray(value)) return "it is not a list of questions.";
  if (value.length === 0) return "the list is empty.";
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const at = "question " + (index + 1);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return at + " is not an object.";
    }
    if (typeof entry.question !== "string" || entry.question.trim() === "") {
      return at + " has no question text.";
    }
    if (typeof entry.header !== "string" || entry.header.trim() === "") {
      return at + " has no header.";
    }
    const options = entry.options;
    if (!Array.isArray(options) || options.length === 0) {
      return at + " offers no options.";
    }
    for (let position = 0; position < options.length; position += 1) {
      const option = options[position];
      if (option === null || typeof option !== "object" || Array.isArray(option)) {
        return at + " has an option that is not an object.";
      }
      if (typeof option.label !== "string" || option.label.trim() === "") {
        return at + " has an option with no label.";
      }
    }
  }
  return undefined;
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

// Ceiling on what a command node's stdout and stderr may carry into run state.
// Its output is recorded as the node's payload and persisted, so an unbounded
// one turns a chatty build into a state file nothing can load. A command whose
// output matters past this belongs in a file the next node reads.
const COMMAND_OUTPUT_MAX = 1048576;

// The one line that carries an ask out of a subagent and into the session. Kept
// deliberately unlike anything a model writes by accident, because the command
// body matches on it and a false positive would send the session hunting for a
// questions file that does not exist. The same literal appears in the run
// command's body; a test holds the two together.
const ASK_MARKER = "MINFLOW-ASK";

// How a run is told to answer its own questions. An argument rather than an
// environment variable, so a run that was unattended is visible in its own
// transcript, which is exactly where you look when you doubt an answer.
// A word boundary rather than whitespace after the flag: a user writing
// "--auto." or "--auto, please" means it, and a flag that silently fails to
// register is the worst way for this to be wrong, since the run then waits for
// answers nobody is coming to give.
const AUTO_FLAG = /(^|\s)--auto\b/;

// Forces a fresh run when one is sitting there half finished. The default is to
// resume, because the expensive mistake is redoing work, not continuing it.
const NEW_FLAG = /(^|\s)--new\b/;

// Starts a fresh run at a named step, seeded with what an earlier run recorded.
//
// Held as two patterns because they answer two questions. The first is whether
// re-entry was asked for at all, so that "--from" with nothing after it is a mistake
// to report rather than a flag to quietly ignore. The second lifts the step id out,
// in either spelling a person might type.
const FROM_FLAG = /(^|\s)--from\b/;
const FROM_NODE = /(^|\s)--from(?:\s+|=)([^\s]+)/;

// A test seam, and the only one in this file.
//
// Set to a path, it answers observations from that file instead of resolving
// them against the world. It exists because a generated test can force a step's
// payload by writing what the runner said, and cannot force the exit code of an
// arbitrary shell command: no harness can make somebody's build fail on demand.
//
// Keyed by node, because a fire that drains a command node resolves observations
// for two nodes at once and they share the inline payload key. One flat map would
// have the second node's payload silently overwrite the first's.
//
// The tier that uses it tests ROUTING and does not test resolution, which is the
// same line every unit test draws around a mock. A real run never sets it.
const TEST_OBSERVATIONS = process.env.MINFLOW_TEST_OBSERVATIONS || "";

// How many resolution passes this process has already run for each node.
//
// A retry sends a command node back to itself without leaving the dispatcher, so
// both visits happen inside one fire and share this process. The harness is
// blocked while that runs and cannot rewrite the file between them, which means
// the visits have to be told apart from in here or the second silently answers
// with the first's values.
const stubVisits = Object.create(null);

// A resolution pass is about to run for this node.
function advanceStubVisit(node) {
  if (TEST_OBSERVATIONS === "" || typeof node !== "string") return;
  stubVisits[node] = (stubVisits[node] === undefined ? -1 : stubVisits[node]) + 1;
}

// One stubbed answer, or null when there is none for this node and key.
function stubFor(node, key) {
  const stubs = stubbedObservations();
  if (stubs === null || typeof node !== "string") return null;
  let forNode = stubs[node];
  // A list is one entry per visit, in order. Past its end the last entry stands,
  // so a node answered the same way every time needs no list at all.
  if (Array.isArray(forNode)) {
    if (forNode.length === 0) return null;
    const visit = stubVisits[node] === undefined ? 0 : stubVisits[node];
    forNode = forNode[visit < forNode.length ? visit : forNode.length - 1];
  }
  if (forNode === null || typeof forNode !== "object" || !Object.hasOwn(forNode, key)) return null;
  return forNode[key];
}

function stubbedObservations() {
  if (TEST_OBSERVATIONS === "") return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(TEST_OBSERVATIONS, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

// One budget for a whole resolution pass, not one per command.
//
// A hook that outlives the platform's own timeout is cancelled and everything it
// wrote is discarded, so it renders no decision at all: the runner stops for
// real, the state is left at status "running", and nothing anywhere says why.
// Several slow guards on one node reach that between them while each stays
// comfortably inside a per-command limit, so they share a deadline instead, and
// a guard that finds it spent reports that where the message survives.
//
// MINFLOW_GUARD_BUDGET_MS overrides it, for a host whose hook timeout has been
// configured away from the default.
const GUARD_BUDGET_MS = 45000;

function guardBudgetMs() {
  const override = Number(process.env.MINFLOW_GUARD_BUDGET_MS);
  return Number.isFinite(override) && override > 0 ? override : GUARD_BUDGET_MS;
}

// Set once per resolution pass, so every guard command at a node shares it.
let guardDeadline = null;

function startGuardBudget() {
  guardDeadline = Date.now() + guardBudgetMs();
}

function guardTimeLeft() {
  return guardDeadline === null ? guardBudgetMs() : guardDeadline - Date.now();
}

function budgetSpent(detail) {
  return (
    "the " + guardBudgetMs() + "ms guard budget for this transition was spent " + detail +
    ". Every guard command at a node shares one budget, because a hook that outlives the " +
    "platform's timeout is cancelled and everything it wrote is discarded, which would stop " +
    "the run with nothing to read. Make the guards faster, or raise MINFLOW_GUARD_BUDGET_MS " +
    "to match a longer hook timeout."
  );
}

// Hook output is capped at 10,000 characters, and two of the things this file
// writes into it are payloads of no bounded size: the JSON a judge is asked
// about, and a value a prompt interpolates out of an earlier step. One budget
// for both, well inside the cap, so a large payload costs a marker rather than a
// decision the platform truncates or discards.
const QUOTED_PAYLOAD_LIMIT = 4000;

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

// A cap, rather than a sweep on age. A record holds every payload a run produced,
// and the loop it serves reaches back a few runs rather than a few months. Nothing
// else ever deletes one, so without a cap this directory only grows.
const RECORD_LIMIT = 20;

// What a finished or stopped run leaves behind, and the reason it is not state.
//
// State is still ephemeral and still keyed by run id (D11). A record is a different
// thing that happens to hold the same outputs: nothing resumes one, session garbage
// collection never sees one, and it sits in its own directory so that no scan of live
// runs can find it by accident.
//
// It exists because of how a workflow is actually edited. You run it, you read what
// came out, you change one prompt, and you run it again. Re-running twenty steps to
// reach the twenty-first is the whole cost of that loop. A record lets the next run
// start at the twenty-first with what the first twenty produced.
function recordPath(runId) {
  return path.join(DATA, "records", runId + ".json");
}

// Enough to seed a run, plus enough to tell two of them apart when a person is
// choosing. The outputs are the point. Everything else is the label.
function keepRecord(state, outcome, detail) {
  const record = {
    runId: state.runId,
    graphHash: state.graphHash,
    workflow: PLUGIN.workflow,
    outcome: outcome,
    node: state.node,
    steps: state.steps,
    at: new Date().toISOString(),
    outputs: state.outputs !== null && typeof state.outputs === "object" ? state.outputs : {},
  };
  if (typeof detail === "string" && detail !== "") record.detail = detail;
  try {
    writeJson(recordPath(state.runId), record);
    pruneRecords();
  } catch (error) {
    // A record that cannot be written is not a reason to fail a run that has already
    // ended. It costs the next re-entry, and saying so is better than passing silently.
    process.stderr.write(
      "minflow: could not keep a record of run " + state.runId + ": " + error.message + "\n",
    );
  }
}

// Newest first. A run id begins with the timestamp it was minted from, so the string
// order is the time order and no second index has to be kept consistent with it.
function byNewestRunId(a, b) {
  if (a.runId < b.runId) return 1;
  if (a.runId > b.runId) return -1;
  return 0;
}

function allRecords() {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(DATA, "records"));
  } catch (error) {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.slice(-5) !== ".json") continue;
    const record = readJson(path.join(DATA, "records", entry));
    if (record === null || typeof record.runId !== "string") continue;
    found.push(record);
  }
  found.sort(byNewestRunId);
  return found;
}

function pruneRecords() {
  const kept = allRecords();
  for (let index = RECORD_LIMIT; index < kept.length; index += 1) {
    try {
      fs.unlinkSync(recordPath(kept[index].runId));
    } catch (error) {
      // Already gone is the desired end state.
    }
  }
}

// The end of a run, whichever way it ended. Every terminal path goes through here, so
// there is one answer to what is left on disk afterwards rather than eight.
function concludeRun(state, outcome, detail) {
  keepRecord(state, outcome, detail);
  deleteState(state.runId);
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
// Runs whose session went away mid-flight.
//
// The state is intact and its node already points at the step the run was about to
// take, so such a run is exactly as resumable as one parked at a gate. Nothing
// was ever wired to pick it up, which is how ninety minutes of work became
// unrecoverable the first time a session limit was hit.
//
// Only "running" is claimed here. "awaiting" is a gate and has its own command.
// "asking" put questions in front of a session that is now gone, and resuming it
// means asking again rather than continuing, so it is reported rather than
// silently resumed into a destination whose answers never arrived.
function resumableRuns() {
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
    if (state === null || state.status !== "running") continue;
    found.push(state);
  }
  return found;
}

/** Runs stalled mid-ask, which need answers rather than a resume. */
function askingRuns() {
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
    if (state === null || state.status !== "asking") continue;
    found.push(state);
  }
  return found;
}

/**
 * Which stalled run the entry command meant, when it meant one at all.
 *
 * The same order of preference gate resume uses, and for the same reason:
 * resuming the wrong run is worse than asking which.
 */
function resumableRunFor(event, sessionId) {
  const named = leftoverArgument(event);
  const candidates = resumableRuns();
  // Checked before the empty case, and reported rather than discarded. A leftover that
  // names no run used to mean the same thing as no leftover at all, so a typo, or a
  // subject somebody reasonably expected to reach the workflow, started a fresh run
  // instead: the one outcome this whole path exists to prevent, reachable by
  // misspelling a word.
  if (named !== "") {
    for (const state of candidates) {
      if (state.runId === named) return { state: state };
    }
    return {
      error:
        'nothing stopped part way through is named "' + named +
        '". Text after the command names a run to resume, and there is no channel that ' +
        "would carry it to the workflow. Drop it, or pass --new to start a fresh run.",
    };
  }
  if (candidates.length === 0) return { none: true };
  const linked = runIdForSession(sessionId);
  for (const state of candidates) {
    if (state.runId === linked) return { state: state };
  }
  if (candidates.length === 1) return { state: candidates[0] };
  const ids = candidates.map(function (state) {
    return state.runId + ' at step "' + state.node + '"';
  });
  return {
    error:
      candidates.length + " runs stopped part way through: " + ids.join(", ") +
      ". Name the one to resume, or pass --new to start a fresh run.",
  };
}

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

// The two placeholder forms a node prompt may carry. Both are resolved here and
// not only in the wrapper, because the compiled graph is the IR verbatim: this
// file reads the template exactly as it was authored.
//
// A ctx reference names a step in its first segment and a path into that step's
// payload in the rest, so a node id containing a dot cannot be named. The
// emitter splits it the same way, and the two have to agree or a reference the
// author was told resolves against one step would resolve against another.
const PARAM_PLACEHOLDER = /\{\{\s*params\.([^{}\s]+?)\s*\}\}/g;
const CTX_PLACEHOLDER = /\{\{\s*ctx\.([^{}\s]+?)\s*\}\}/g;

// The params form again, unanchored and without the g flag, so whatever the
// params pass leaves behind can be reported as it reads. That pass replaces
// every reference it finds and never rescans what it wrote, so a params
// reference still standing afterwards is one a param's own value introduced.
//
// Only the params form is checked, and only between the two passes. A ctx
// reference the params pass introduced is resolved by the pass that follows it,
// and text that looks like a placeholder after that pass came out of a step's
// payload, where it is data this file did not write and must not police.
// Either form, in one pattern. Resolving both in a single scan is what makes a
// spliced placeholder impossible: String.replace walks the ORIGINAL string and
// never rescans what it substituted, so a param value that contributes a brace
// cannot combine with neighbouring text into a reference. Two sequential passes
// could, and did: a prompt reading "{{params.open}}{ctx.a.b}}" with a param
// holding a single brace assembled a ctx reference during the first pass that
// the second pass then resolved, having never faced the check that the step it
// names always runs.
const ANY_PLACEHOLDER = /\{\{\s*(params|ctx)\.([^{}\s]+?)\s*\}\}/g;

// A value interpolated into prose: a string as itself, anything else as JSON.
// Quoting a string would put a JSON literal in the middle of a sentence the
// author wrote. Clipped per value, since a payload has no size bound and the
// instruction it lands in shares the hook's output cap.
function interpolatedValue(value) {
  return clip(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// A step's recorded payload, or a path into it, read the way a field guard reads
// one: numeric segments index arrays, and only own properties count, so
// "constructor" is absent rather than a walk up the prototype chain.
function readOutputPath(outputs, reference) {
  const cut = reference.indexOf(".");
  const nodeId = cut === -1 ? reference : reference.slice(0, cut);
  const path = cut === -1 ? "" : reference.slice(cut + 1);
  if (outputs === null || typeof outputs !== "object" || !Object.hasOwn(outputs, nodeId)) {
    return { error: 'step "' + nodeId + '" has recorded no output in this run' };
  }
  let current = outputs[nodeId];
  const segments = path === "" ? [] : path.split(".");
  for (const segment of segments) {
    if (current === null || current === undefined) {
      current = undefined;
      break;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        current = undefined;
        break;
      }
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || !Object.hasOwn(current, segment)) {
      current = undefined;
      break;
    }
    current = current[segment];
  }
  if (current === undefined) {
    return { error: 'step "' + nodeId + '" produced no "' + path + '"' };
  }
  // Null stops the run; an empty string does not, and the difference is a
  // judgment call rather than something the JSON says. An empty string is a
  // value a step can genuinely have produced, so the sentence the author wrote
  // is rendered with nothing where the value goes and the run carries on. A null
  // is the step naming the key and putting no value behind it, which is the same
  // unmet contract as a path that resolves to nothing, and interpolating it
  // would write the word null into the task as though that were the answer.
  if (current === null) {
    return {
      error:
        'step "' + nodeId + '" recorded null ' +
        (path === "" ? "as its whole output" : 'at "' + path + '"') +
        ", which is a value it did not produce rather than an empty one",
    };
  }
  return { value: current };
}

// The node's prompt with both placeholder forms resolved: its own params, fixed
// when the graph compiled, and the run context, which exists only once the steps
// it names have run.
//
// An unresolvable reference stops the run rather than spawning the step with a
// hole in its task, and rather than handing it the placeholder as if it were
// prose. A graph compiled by minflow's builder cannot reach this: the builder
// refuses a ctx reference unless the step it names runs on every path to this
// one, so the value is on record by the time a run arrives. The IR is plain data
// and another front-end can hand us anything, which is what this defends.
function taskFor(graph, state) {
  const node = graph.nodes.find(function (candidate) {
    return candidate !== null && typeof candidate === "object" && candidate.id === state.node;
  });
  if (!node) return { text: "" };
  // A command node interpolates its command exactly as a step interpolates its
  // prompt, so one substitution serves both and neither can drift from the
  // dominance rule the compiler checked.
  const isCommand = node.kind === "command";
  const template = isCommand ? node.command : node.prompt;
  const noun = isCommand ? "its command" : "its prompt";
  if (typeof template !== "string") return { text: "" };
  const params = node.params !== null && typeof node.params === "object" ? node.params : {};
  const outputs = state.outputs !== null && typeof state.outputs === "object" ? state.outputs : {};

  let failure = null;
  const stop = function (detail) {
    if (failure === null) failure = detail;
    return "";
  };
  const text = template.replace(ANY_PLACEHOLDER, function (match, kind, reference) {
    if (kind === "params") {
      if (!Object.hasOwn(params, reference)) {
        return stop(
          noun + " interpolates {{params." + reference + "}}, which the node does not declare",
        );
      }
      return interpolatedValue(params[reference]);
    }
    const found = readOutputPath(outputs, reference);
    if (found.error) {
      return stop(noun + " interpolates {{ctx." + reference + "}}, but " + found.error);
    }
    return interpolatedValue(found.value);
  });
  // Nothing scans the result. Placeholder-shaped text in it came out of a param
  // value or a step's payload, where it is data this file did not write, and a
  // workflow whose subject is templates may carry it legitimately.

  if (failure !== null) {
    return {
      error:
        'step "' + state.node + '" cannot be started: ' + failure +
        ". A graph compiled by minflow's builder cannot reach this, because the builder refuses " +
        "a ctx reference unless the step it names runs on every path to this one; an IR from " +
        "another front-end can. Fix the template, or the step it reads from.",
    };
  }
  return { text: text };
}

// Where an ask's questions are written for the session to read, and where it is
// to write the answers back. Under the plugin's data directory rather than the
// user's repository: these are run plumbing, not artifacts of the work, and a
// half-answered question list committed by accident helps nobody.
function askDir() {
  return path.join(DATA, "asks");
}

function askQuestionsPath(runId) {
  return path.join(askDir(), runId + "-questions.json");
}

function askAnswersPath(runId) {
  return path.join(askDir(), runId + "-answers.json");
}

// The file the session reads. Self-describing on purpose: it carries the path
// its answers belong at, so the protocol in the command body never has to derive
// one filename from another.
function writeAskFile(state, questions) {
  const target = askQuestionsPath(state.runId);
  fs.mkdirSync(askDir(), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        runId: state.runId,
        workflow: PLUGIN.workflow,
        questions: questions,
        answersPath: askAnswersPath(state.runId),
      },
      null,
      2,
    ),
    "utf8",
  );
  return target;
}

// The answers, or why they cannot be used. An unreadable or malformed answers
// file is a broken contract rather than an empty answer: routing on nothing
// would hand the next step a blank where the user's decision should be.
function readAskAnswers(runId) {
  const target = askAnswersPath(runId);
  if (!fs.existsSync(target)) return { ok: false, missing: true };
  let text = "";
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    return { ok: false, error: "could not read the answers at " + target + ": " + error.message };
  }
  const parsed = tryParse(text);
  if (!parsed.ok) {
    return { ok: false, error: "the answers at " + target + " are not valid JSON: " + parsed.error };
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "the answers at " + target + " are not a JSON object of answers keyed by header",
    };
  }
  return { ok: true, value: value };
}

function clearAskFiles(runId) {
  for (const target of [askQuestionsPath(runId), askAnswersPath(runId)]) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) {
      // Leftover plumbing is untidy, never wrong: the next ask overwrites it.
    }
  }
}

// Whether a node needs an agent registered for it. A command node does not: the
// dispatcher runs it rather than spawning it, so demanding an agent would refuse
// a perfectly good graph whose entry, or whose node after a gate, is mechanical.
function needsAgent(nodeId) {
  const found = PLUGIN.commandNodes.indexOf(nodeId);
  return found === -1;
}

// The instruction the runner acts on: spawn one named agent, pass it one text.
// The runner has the Agent tool and nothing else, so this is the only shape it
// can execute, and paraphrase is the standing risk (SPEC L7).
//
// Returns the text, or the reason there is none. A step that cannot be given its
// task is not spawned with a partial one.
function stepInstruction(graph, state) {
  const agent = PLUGIN.agents[state.node];
  if (typeof agent !== "string") {
    return {
      error: 'no agent is registered for node "' + state.node + '". Regenerate the plugin.',
    };
  }
  const task = taskFor(graph, state);
  if (task.error) return task;

  const delivery = deliveryFor(graph, state);
  // Paragraphs, not one run-on line: a prompt is authored text and may carry its
  // own line breaks, so joining everything with spaces would reflow it.
  const paragraphs = ['Run step "' + state.node + '" of the "' + PLUGIN.workflow + '" workflow.'];
  if (task.text.trim() !== "") paragraphs.push(task.text.trim());
  const obligations = [];
  for (const file of delivery.files) {
    obligations.push("Write your JSON payload to " + file + ", relative to the project root.");
  }
  if (delivery.inline) {
    obligations.push(
      "End your final message with your JSON payload as a single fenced json block, with " +
        "nothing after it.",
    );
  }
  if (obligations.length > 0) paragraphs.push(obligations.join(" "));
  return {
    text: [
      "Spawn the subagent " + qualified(agent) + " with the Agent tool, and pass it exactly this " +
        "text, verbatim:",
      "",
      paragraphs.join("\n\n"),
    ].join("\n"),
  };
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
  const remaining = guardTimeLeft();
  if (remaining <= 0) {
    return { ok: false, error: budgetSpent("before " + command + " could start") };
  }
  const finished = childProcess.spawnSync(command, {
    shell: true,
    cwd: PROJECT,
    stdio: "ignore",
    timeout: remaining,
  });
  // A command cut off by the deadline arrives as an error on some platforms and
  // as a signal on others. The budget is what tells both apart from a command
  // that genuinely could not run: spent means this one is what ran the pass out
  // of time, and saying so is more use than naming the signal that killed it.
  if (finished.error || typeof finished.status !== "number") {
    if (guardTimeLeft() <= 0) {
      return { ok: false, error: budgetSpent("while " + command + " was running") };
    }
    if (finished.error) {
      return { ok: false, error: "could not run " + command + ": " + finished.error.message };
    }
    return {
      ok: false,
      error:
        "the guard command " + command + " was killed by " + finished.signal +
        " before it exited",
    };
  }
  return { ok: true, value: finished.status === 0 };
}

// A command node's own execution, as distinct from a guard's. The difference is
// what a failure means: a guard that could not run leaves a question unanswered,
// while a command node that could not run has failed to produce the payload its
// outgoing edges read, which is a broken contract either way but is reported
// against the node rather than against a predicate.
//
// A non-zero exit is NOT a failure here. It is the answer, and it is what
// when.field("exitCode") exists to read.
function runCommandNode(node, command) {
  const ceiling = typeof node.timeoutMs === "number" ? node.timeoutMs : guardTimeLeft();
  const remaining = Math.min(ceiling, guardTimeLeft());
  if (remaining <= 0) {
    return {
      ok: false,
      error: budgetSpent('before command node "' + node.id + '" could start'),
    };
  }
  const finished = childProcess.spawnSync(command, {
    shell: true,
    cwd: PROJECT,
    encoding: "utf8",
    timeout: remaining,
    maxBuffer: COMMAND_OUTPUT_MAX,
  });
  if (finished.error || typeof finished.status !== "number") {
    if (finished.error && finished.error.code === "ETIMEDOUT") {
      return {
        ok: false,
        error:
          'command node "' + node.id + '" was killed after ' + remaining +
          "ms without exiting. A command that never finished reported nothing, so there is no " +
          "payload to route on.",
      };
    }
    if (finished.error) {
      return {
        ok: false,
        error: 'command node "' + node.id + '" could not run: ' + finished.error.message,
      };
    }
    return {
      ok: false,
      error:
        'command node "' + node.id + '" was killed by ' + finished.signal + " before it exited",
    };
  }
  return {
    ok: true,
    value: {
      exitCode: finished.status,
      stdout: typeof finished.stdout === "string" ? finished.stdout : "",
      stderr: typeof finished.stderr === "string" ? finished.stderr : "",
    },
  };
}

// The one place delivery is visible. Above this the run is JSON; below it there
// are files, exit codes and a final message.
function resolveRequest(request, event, scratch, answered, node) {
  const stubbed = stubFor(node, request.key);
  if (stubbed !== null) return stubbed;
  if (request.kind === "exitZero" || request.kind === "fileExists") {
    // Once per visit to a node, not once per hook fire. A node carrying both a
    // mechanical guard and a judge guard is resolved again when the verdict
    // arrives, and a command run twice for one transition is a test suite run
    // twice, or a counter moved twice. The scratch is scoped to the node and the
    // step count, so a fresh visit resolves everything again.
    const cached = scratch.observations[request.key];
    if (cached !== undefined) return cached;
    const result =
      request.kind === "exitZero"
        ? runGuardCommand(request.command)
        : { ok: true, value: fs.existsSync(inProject(request.path)) };
    scratch.observations[request.key] = result;
    return result;
  }
  if (request.kind === "payload") {
    const from = request.from || { lane: "inline" };
    if (from.lane === "file") return readPayloadFile(from.path);
    // The inline payload is whatever the runner said last, so it survives only
    // as long as the runner has not said anything since. A judge round trip
    // replaces it with a verdict, which is why the first reading of it is kept
    // for the visit, failure included: a payload the step never wrote correctly
    // has to be reported as that, not as a payload the round trip took away.
    if (scratch.payload !== null) {
      if (typeof scratch.payload.error === "string") {
        return { ok: false, error: scratch.payload.error };
      }
      return { ok: true, value: scratch.payload.value };
    }
    if (answered) {
      return {
        ok: false,
        error:
          "the inline payload is gone: the runner's last message was its answer to a judge " +
          "question, and no reading of the step's own report was kept from the pass before " +
          "it. Read this payload from a file lane instead.",
      };
    }
    const parsed = parseInlinePayload(event.last_assistant_message);
    scratch.payload = parsed.ok ? { value: parsed.value } : { error: parsed.error };
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
/**
 * The spellings an answer to one judge question may legitimately take.
 *
 * A judge request carries a CLOSED verdict set when the author declared one,
 * which branch() always does, since its route keys are that set. A guard written
 * as judge(q).is("yes") declares no set. The request cannot carry the expected
 * verdict either: two edges asking one question with different expected verdicts
 * have to share a single observation, and would not if the expected verdict
 * reached the observation key.
 *
 * So the spellings are recovered from the graph instead. Every judge guard that
 * resolves to this key contributes the verdict it fires on. They are candidates
 * for normalization, not a menu: an answer matching none of them is passed
 * through unchanged, so an open question keeps comparing by equality, while an
 * answer of "Yes." still routes an edge that fires on "yes".
 */
function judgeSpellings(graph, key) {
  const found = [];
  const visit = function (guard) {
    if (guard === null || typeof guard !== "object") return;
    if (guard.kind === "judge") {
      const spec = { kind: "judge", question: guard.question, from: guard.from || runtime.DEFAULT_PAYLOAD_SOURCE };
      if (Array.isArray(guard.verdicts) && guard.verdicts.length > 0) spec.verdicts = guard.verdicts;
      if (runtime.observationKey(spec) === key && typeof guard.is === "string") {
        if (found.indexOf(guard.is) === -1) found.push(guard.is);
      }
      return;
    }
    if (guard.kind === "not") return visit(guard.guard);
    if (guard.kind === "all" || guard.kind === "any") {
      const guards = Array.isArray(guard.guards) ? guard.guards : [];
      for (const inner of guards) visit(inner);
    }
  };
  for (const edge of graph.edges) visit(edge.guard);
  return found;
}

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
  // No spellings to match against at all, so there is nothing to fold to.
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
  const fresh = {
    node: state.node,
    steps: state.steps,
    answers: {},
    asking: null,
    payload: null,
    observations: {},
    start: false,
  };
  const host = state.host;
  if (host === null || host === undefined || typeof host !== "object") return fresh;
  // Scoped to this visit of this node. Every departure and every retry bumps
  // steps, so a second lap round a loop cannot reuse the verdict the first lap
  // collected, and a stale answer or a stale exit code can never decide a fresh
  // visit.
  if (host.node !== state.node || host.steps !== state.steps) return fresh;
  return {
    node: state.node,
    steps: state.steps,
    answers:
      host.answers && typeof host.answers === "object" ? Object.assign({}, host.answers) : {},
    asking: host.asking || null,
    payload: host.payload && typeof host.payload === "object" ? host.payload : null,
    // What the mechanical observations came back as, keyed the way the evaluator
    // keys them, so each command runs once for the visit rather than once per
    // hook fire.
    observations:
      host.observations && typeof host.observations === "object"
        ? Object.assign({}, host.observations)
        : {},
    // Set when a run segment has just been started or resumed by a command, and
    // the runner has therefore not run a step yet.
    start: host.start === true,
  };
}

// The scratch a run segment begins on: nothing observed, nothing asked, and the
// marker saying the runner has been spawned by a command and has not run a step.
function startingScratch(state) {
  return {
    node: state.node,
    steps: state.steps,
    answers: {},
    asking: null,
    payload: null,
    observations: {},
    start: true,
  };
}

function withScratch(state, scratch) {
  const host = { node: scratch.node, steps: scratch.steps, answers: scratch.answers };
  if (scratch.asking !== null) host.asking = scratch.asking;
  if (scratch.payload !== null) host.payload = scratch.payload;
  if (Object.keys(scratch.observations).length > 0) host.observations = scratch.observations;
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
  if (text.length <= QUOTED_PAYLOAD_LIMIT) return text;
  return text.slice(0, QUOTED_PAYLOAD_LIMIT) + "\n... truncated: hook output is capped.";
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

/**
 * Whatever the argument holds once the flags are taken out of it.
 *
 * That leftover names a run. It is not passed to the workflow, and there is no
 * channel that would carry it there, so text nobody recognises is a mistake rather
 * than a subject.
 */
function leftoverArgument(event) {
  return commandArgument(event)
    .replace(FROM_NODE, " ")
    .replace(AUTO_FLAG, " ")
    .replace(NEW_FLAG, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The step id after --from, or "" when the flag carries none. */
function reentryNode(event) {
  const found = FROM_NODE.exec(commandArgument(event));
  return found === null ? "" : found[2];
}

/** Every step id in the graph, for an error that has to say what was available. */
function nodeIdList(graph) {
  const ids = [];
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index];
    if (node !== null && typeof node === "object" && typeof node.id === "string") ids.push(node.id);
  }
  return ids;
}

/**
 * Every node a run entering at the named step can still reach.
 *
 * Used to tell two kinds of missing value apart. A reference to a node that runs
 * later is fine, because that node will run. A reference to a node that neither ran
 * before the record was kept nor runs after this entry point is a hole, and the run
 * will stop on it however many expensive steps later.
 */
function reachableFrom(graph, start) {
  const seen = {};
  const queue = [start];
  seen[start] = true;
  while (queue.length > 0) {
    const at = queue.shift();
    for (let index = 0; index < graph.edges.length; index += 1) {
      const edge = graph.edges[index];
      if (edge === null || typeof edge !== "object" || edge.from !== at) continue;
      const targets = [edge.goto];
      if (edge.otherwise !== null && typeof edge.otherwise === "object") {
        if (edge.otherwise.kind === "goto") targets.push(edge.otherwise.node);
      }
      for (let which = 0; which < targets.length; which += 1) {
        const target = targets[which];
        if (typeof target !== "string" || seen[target] === true) continue;
        seen[target] = true;
        queue.push(target);
      }
    }
  }
  return seen;
}

/**
 * The ctx references a run entering at the named step cannot satisfy.
 *
 * Each entry names the node that reads and the reference it reads, so the report can
 * separate the fatal case from the merely likely one: a hole in the entry node itself
 * stops the run before it costs anything, and a hole further on may sit on a branch
 * this run never takes.
 */
function unsatisfiedReferences(graph, start, outputs) {
  const reachable = reachableFrom(graph, start);
  const holes = [];
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index];
    if (node === null || typeof node !== "object") continue;
    if (reachable[node.id] !== true) continue;
    const template = node.kind === "command" ? node.command : node.prompt;
    if (typeof template !== "string") continue;
    const pattern = /\{\{\s*ctx\.([^{}\s]+?)\s*\}\}/g;
    let found = pattern.exec(template);
    while (found !== null) {
      const reference = found[1];
      const producer = reference.split(".")[0];
      const carried = Object.hasOwn(outputs, producer);
      if (!carried && producer !== node.id && reachable[producer] !== true) {
        holes.push({ node: node.id, reference: reference });
      }
      found = pattern.exec(template);
    }
  }
  return holes;
}

/**
 * The record, or the stopped run, a re-entry is seeded from.
 *
 * A named one wins. Otherwise the newest, because re-entry is a loop you run several
 * times in an hour and the one you mean is the one you just watched. Stopped runs are
 * candidates too: a run interrupted mid-flight holds the same outputs a record does,
 * and refusing to seed from one would send a person to start it over first.
 */
function seedFor(named) {
  const candidates = allRecords().concat(resumableRuns().slice().sort(byNewestRunId));
  if (named !== "") {
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index].runId === named) return { seed: candidates[index] };
    }
    return {
      error:
        'no finished, stopped or interrupted run is named "' + named +
        '". Text after the command names a run to seed from, and is not passed to the ' +
        "workflow. Drop it to use the most recent run.",
    };
  }
  if (candidates.length === 0) {
    return {
      error:
        "nothing has run yet, so there is nothing to re-enter. A run leaves a record when " +
        "it finishes and when it stops, and --from starts a fresh run from one of those.",
    };
  }
  candidates.sort(byNewestRunId);
  return { seed: candidates[0] };
}

/**
 * Start a fresh run at a chosen step, carrying what an earlier run produced.
 *
 * A new run rather than a revived one, deliberately. The record stays where it is and
 * can seed the next attempt too, which is the point: you re-enter the same run at
 * three different steps while you tune three different prompts.
 *
 * A graph whose hash has moved is accepted here, unlike a resume. Resume is the
 * default and happens to a run you did not deliberately touch, so it stays
 * conservative. Re-entry is a thing you typed, at a step you named, and the reason to
 * type it is almost always that you just changed the graph. Refusing it would refuse
 * the whole use case. What replaces the hash check is the reference check below,
 * which is stricter about the thing the hash was standing in for.
 */
function reenterRun(event, sessionId, graph) {
  const node = reentryNode(event);
  if (node === "") {
    report(
      "--from needs the id of the step to start at, as in --from " + PLUGIN.entry +
        ". This graph has: " + nodeIdList(graph).join(", ") + ".",
    );
    return;
  }
  if (nodeIdList(graph).indexOf(node) === -1) {
    report(
      'this graph has no step called "' + node + '". It has: ' + nodeIdList(graph).join(", ") + ".",
    );
    return;
  }
  const found = seedFor(leftoverArgument(event));
  if (found.error) {
    report(found.error);
    return;
  }
  const seed = found.seed;
  const outputs =
    seed.outputs !== null && typeof seed.outputs === "object" ? seed.outputs : {};

  const holes = unsatisfiedReferences(graph, node, outputs);
  const here = [];
  const later = [];
  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index];
    const line = hole.node + " reads {{ctx." + hole.reference + "}}";
    if (hole.node === node) here.push(line);
    else later.push(line);
  }
  if (here.length > 0) {
    report(
      'cannot start at "' + node + '" from run ' + seed.runId + ": " + here.join(", ") +
        ", and that value is neither in the record nor produced by anything this run would " +
        "reach. Re-enter earlier, at a step that produces it.",
    );
    return;
  }
  if (needsAgent(node) && typeof PLUGIN.agents[node] !== "string") {
    report('no agent is registered for node "' + node + '". Regenerate the plugin.');
    return;
  }

  const runId = mintRunId();
  // Read fresh from the argument, unlike a resume, which carries the flag the run
  // began with. This is a new run and a person is typing the command now, so the
  // answer to whether anybody is behind it is the one they just gave.
  const state = {
    runId: runId,
    graphHash: PLUGIN.graphHash,
    node: node,
    status: "running",
    attempts: {},
    steps: 0,
    auto: AUTO_FLAG.test(commandArgument(event)),
    outputs: Object.assign({}, outputs),
    seededFrom: seed.runId,
  };
  saveState(withScratch(state, startingScratch(state)));
  linkSession(sessionId, runId);
  appendTrace(runId, {
    at: new Date().toISOString(),
    decision: "reenter",
    session: sessionId,
    run: runId,
    from: seed.runId,
    node: node,
    carried: Object.keys(outputs).length,
  });

  const lines = [
    "run " + runId + ' starts at step "' + node + '", carrying ' + Object.keys(outputs).length +
      " step outputs from run " + seed.runId + ". Nothing before that step runs again.",
  ];
  if (seed.graphHash !== PLUGIN.graphHash) {
    lines.push(
      "That run used graph " + seed.graphHash + " and this one is " + PLUGIN.graphHash +
        ". The graph moved, which is usually why you are here. Every value this run needs " +
        "was checked against the record before it started.",
    );
  }
  if (later.length > 0) {
    lines.push(
      "Watch for: " + later.join(", ") + ". Nothing carried supplies those, and no step " +
        "downstream produces them, so the run will stop if it reaches one.",
    );
  }
  report(lines.join(" "));
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
  const argument = commandArgument(event);

  // Before anything else looks at the argument. Re-entry is explicit, it names its own
  // step, and it starts a fresh run, so neither the resume path nor --new has anything
  // to say about it.
  if (FROM_FLAG.test(argument)) {
    reenterRun(event, sessionId, graph);
    return;
  }

  // SPEC section 3.5: one static command serves both a fresh run and a run
  // resumed at any node, which is why the command body tells the runner to stand
  // by rather than naming a step. Gate resume has always used that. A run whose
  // session died mid-flight can use it too, and until now nothing did, so the
  // work was simply lost.
  if (!NEW_FLAG.test(argument)) {
    const stalled = askingRuns();
    if (stalled.length > 0 && resumableRuns().length === 0) {
      const one = stalled[0];
      report(
        "run " + one.runId + ' is waiting on answers before step "' + one.node +
          '", so it needs those answers rather than a resume. Answer it, or pass --new to start ' +
          "a fresh run.",
      );
      return;
    }
    const found = resumableRunFor(event, sessionId);
    if (found.error) {
      report(found.error);
      return;
    }
    if (found.state) {
      resumeRun(found.state, graph, sessionId);
      return;
    }
  }

  const runId = mintRunId();
  // Read once, at the start, and carried for the life of the run. A run cannot
  // become unattended halfway through, and every later decision can see that the
  // answers behind it were invented.
  const auto = AUTO_FLAG.test(argument);
  const state = {
    runId: runId,
    graphHash: PLUGIN.graphHash,
    node: PLUGIN.entry,
    status: "running",
    attempts: {},
    steps: 0,
    auto: auto,
    outputs: {},
  };
  if (needsAgent(state.node) && typeof PLUGIN.agents[state.node] !== "string") {
    report(
      'no agent is registered for the entry node "' + state.node + '". Regenerate the plugin.',
    );
    return;
  }
  // Marked as not yet started, then no decision is rendered. Blocking here would
  // be wrong: on this event a block CANCELS the command's expansion and prints
  // the reason, rather than handing the conversation an instruction the way a
  // blocked SubagentStop hands one to the runner. Letting the expansion through
  // is what puts the command's own body in front of the model, and that body is
  // what spawns the runner.
  saveState(withScratch(state, startingScratch(state)));
  linkSession(sessionId, runId);
  appendTrace(runId, {
    at: new Date().toISOString(),
    decision: "start",
    session: sessionId,
    run: runId,
    node: state.node,
  });
}

/**
 * Pick a stalled run back up where it stopped.
 *
 * The same three steps gate resume takes, for the same reason: the state already
 * names the node to continue into, so resuming is flipping the status and letting
 * the command's own body spawn a fresh runner.
 *
 * The auto flag is carried, never re-read from the arguments. A run cannot change its
 * mind halfway about whether a human is behind it, and the answers already
 * recorded were given under whichever mode was in force.
 */
function resumeRun(parked, graph, sessionId) {
  if (parked.graphHash !== graph.hash) {
    report(
      "run " + parked.runId + " started against graph " + parked.graphHash + ", but " +
        PLUGIN.graphFile + " now hashes to " + graph.hash +
        ". Refusing to resume it: its nodes may have moved. Pass --new to start a fresh run.",
    );
    return;
  }
  if (needsAgent(parked.node) && typeof PLUGIN.agents[parked.node] !== "string") {
    report('no agent is registered for node "' + parked.node + '". Regenerate the plugin.');
    return;
  }
  const state = Object.assign({}, parked, { status: "running" });
  delete state.host;
  saveState(withScratch(state, startingScratch(state)));
  linkSession(sessionId, state.runId);
  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: "resume",
    session: sessionId,
    run: state.runId,
    node: state.node,
    steps: state.steps,
  });
  report(
    "resuming run " + state.runId + ' at step "' + state.node + '", ' + state.steps +
      " steps in. Everything already finished is kept. Pass --new to start over instead.",
  );
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
  if (needsAgent(state.node) && typeof PLUGIN.agents[state.node] !== "string") {
    report('no agent is registered for node "' + state.node + '". Regenerate the plugin.');
    return;
  }
  // Not blocked, for the reason given in startRun: the resume command's body is
  // what reaches the model and spawns a fresh runner.
  saveState(withScratch(state, startingScratch(state)));
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
  // No record kept, unlike every other way a run ends. This is the one command whose
  // whole meaning is throw this away, and a record is the thing a later run could be
  // seeded from. Keeping one here would make abandoning a run reversible by accident.
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

// The state to persist once a transition is decided, with the visit's scratch
// dropped. The evaluator carries the scratch through rather than deciding for
// us, because only this side knows what it was tracking: a verdict, a parsed
// payload and a guard's exit code are all answers about a step that has now run,
// and none of them may decide the next visit to a node.
function departed(state) {
  const next = Object.assign({}, state);
  delete next.host;
  return next;
}

// Where a run lands once every command node in front of it has run.
//
// A command node is not spawned, it executes here, inside the dispatcher,
// between two runner stops. So arriving at one is not a reason to instruct the
// runner: it is work to do now, followed by another transition to decide. The
// loop drains a whole chain of them for one hook fire, which is what makes a
// mechanical check cost no model call and no round trip.
//
// Returns the state to instruct the runner from, or null when the run has
// already been concluded here and there is nothing left to spawn.
function settle(graph, state) {
  let current = state;
  for (;;) {
    const node = graph.nodes.find(function (candidate) {
      return candidate !== null && typeof candidate === "object" && candidate.id === current.node;
    });
    if (!node || node.kind !== "command") {
      saveState(current);
      return current;
    }

    const resolvedCommand = taskFor(graph, current);
    if (resolvedCommand.error) {
      concludeWithError(current, "invalid-graph", resolvedCommand.error);
      return null;
    }

    const outcome = runCommandNode(node, resolvedCommand.text);
    appendTrace(current.runId, {
      at: new Date().toISOString(),
      decision: "command",
      run: current.runId,
      node: current.node,
      command: resolvedCommand.text,
      exitCode: outcome.ok ? outcome.value.exitCode : null,
      error: outcome.ok ? null : outcome.error,
    });

    // The command's own result is the node's payload, seeded into a scratch so
    // that every guard leaving the node reads it through exactly the path an
    // inline payload takes. Nothing here knows it did not come off a runner.
    const scratch = {
      node: current.node,
      steps: current.steps,
      answers: {},
      asking: null,
      payload: outcome.ok ? { value: outcome.value } : { error: outcome.error },
      observations: {},
      start: false,
    };

    advanceStubVisit(current.node);

    const resolved = {};
    for (const request of runtime.observationsFor(graph, current)) {
      if (request.kind === "judge") {
        // Refused by the compiler, so reaching this means a graph came from
        // somewhere else. Saying so beats hanging on a question nobody can ask.
        concludeWithError(
          current,
          "invalid-graph",
          'node "' + current.node +
            '" is a command node with a judge guard on an edge leaving it. There is no model in ' +
            "the loop at that moment, so the verdict can never be obtained.",
        );
        return null;
      }
      resolved[request.key] = resolveRequest(request, {}, scratch, false, current.node);
    }

    const transition = runtime.evaluate(graph, current, resolved);
    appendTrace(current.runId, {
      at: new Date().toISOString(),
      decision: transition.kind,
      run: current.runId,
      node: current.node,
      via: transition.via === undefined ? null : transition.via,
      to: transition.to === undefined ? null : transition.to,
      steps: transition.state.steps,
    });

    if (transition.kind === "advance" || transition.kind === "retry") {
      current = departed(transition.state);
      continue;
    }
    if (transition.kind === "gate") {
      saveState(departed(transition.state));
      const commands = PLUGIN.gates[transition.gate];
      report(
        "run " + current.runId + ' is parked at the "' + transition.gate + '" gate, before step "' +
          transition.to + '". Run /' + (commands ? commands.resume : transition.gate) +
          " to continue" + (commands ? ", or /" + commands.reject + " to abandon it" : "") + ".",
      );
      return null;
    }
    if (transition.kind === "end") {
      concludeRun(transition.state, "finished", "");
      report("run " + current.runId + ' finished at command node "' + current.node + '".');
      return null;
    }
    concludeWithError(current, transition.code, transition.message);
    return null;
  }
}

// An errored run must not be left on disk: at status "running" it is still live,
// so the next runner stop would load it, re-evaluate the same failure, and
// report it again. The trace is what survives a run (D11).
function concludeWithError(state, code, message) {
  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: "stopped",
    run: state.runId,
    node: state.node,
    code: code,
    message: message,
    state: state,
  });
  concludeRun(state, "stopped", "[" + code + "] " + message);
  report("run " + state.runId + " stopped: [" + code + "] " + message);
}

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
    // Where it lands may be past the transition's own target: any command nodes
    // in between run here rather than being spawned, so a run can travel several
    // nodes on one hook fire, and the message names where it actually stopped.
    const landed = settle(graph, departed(transition.state));
    if (landed === null) return;
    const instruction = stepInstruction(graph, landed);
    if (instruction.error) {
      report(instruction.error);
      return;
    }
    block(
      [
        'minflow: step "' + state.node + '" is done; the run advances to "' + landed.node + '".',
        "",
        instruction.text,
      ].join("\n"),
    );
    return;
  }

  if (transition.kind === "retry") {
    const instruction = stepInstruction(graph, transition.state);
    if (instruction.error) {
      report(instruction.error);
      return;
    }
    saveState(departed(transition.state));
    block(
      [
        'minflow: step "' + transition.node + '" runs again, attempt ' + transition.attempt + ": " +
          transition.reason,
        "",
        instruction.text,
      ].join("\n"),
    );
    return;
  }

  if (transition.kind === "ask" && state.auto === true) {
    // Unattended. The questions never leave for the session; the runner answers
    // them, which is the judge round trip of section 3.3 carrying a JSON object
    // rather than one word. Marked relayed because there is nothing to relay.
    const pending = transition.state;
    pending.ask.relayed = true;
    pending.ask.auto = true;
    saveState(departed(pending));
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "ask-auto",
      run: state.runId,
      node: state.node,
      questions: transition.questions.length,
    });
    block(autoAskReason(transition.questions));
    return;
  }

  if (transition.kind === "ask") {
    // Beat one of three. A subagent cannot reach the user, so the questions have
    // to travel out to the session, and the only channel to it is the runner's
    // final message. So the runner is blocked here and told to say one exact
    // line; it is allowed to actually stop on the beat after this one, which is
    // when that line lands where something can act on it.
    let target = "";
    try {
      target = writeAskFile(transition.state, transition.questions);
    } catch (error) {
      report(
        "run " + state.runId + " could not write its questions: " + error.message +
          ". The run is stopped rather than continued without the answers.",
      );
      concludeRun(state, "stopped", "could not write its questions");
      return;
    }
    saveState(departed(transition.state));
    block(
      [
        "minflow: the workflow needs answers from the user before it can continue.",
        "",
        "Reply with exactly this line and nothing else, then stop:",
        "",
        ASK_MARKER + " " + target,
      ].join("\n"),
    );
    return;
  }

  if (transition.kind === "gate" && state.auto === true) {
    // A gate is a wall, not a pause. An ask exists because the workflow needs a
    // fact and inventing one unattended is reasonable; a gate exists because a
    // person has to look, and waving that through would make gates meaningless.
    // A workflow that cannot be smoke tested without passing a gate has said
    // something about where its gate is.
    saveState(departed(transition.state));
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "gate-blocked-auto",
      run: state.runId,
      node: state.node,
      gate: transition.gate,
    });
    concludeRun(transition.state, "stopped", 'stopped at the "' + transition.gate + '" gate');
    report(
      "run " + state.runId + ' reached the "' + transition.gate + '" gate and stopped, because ' +
        "it was started with --auto. A gate waits for a person to look at something, so an " +
        "unattended run does not pass one. Everything before the gate ran.",
    );
    return;
  }

  if (transition.kind === "gate") {
    // No decision. A human gate ends the run segment: subagents cannot ask the
    // user anything, so sign-off arrives as a command in a later turn, possibly
    // in a later session (SPEC section 3.9).
    saveState(departed(transition.state));
    const commands = PLUGIN.gates[transition.gate];
    report(
      "run " + state.runId + ' is parked at the "' + transition.gate + '" gate, before step "' +
        transition.to + '". Run /' + (commands ? commands.resume : transition.gate) +
        " to continue" + (commands ? ", or /" + commands.reject + " to abandon it" : "") + ".",
    );
    return;
  }

  if (transition.kind === "end") {
    // No decision, and the live state is gone. What survives a finished run is the
    // trace, which says how it got here, and the record, which carries what it made.
    concludeRun(transition.state, "finished", "");
    report("run " + state.runId + ' finished at step "' + state.node + '".');
    return;
  }

  // error. The state is recorded into the trace and then deleted, and no
  // decision is rendered, so the run stops here.
  //
  // An errored run must not be left on disk. At status "running" it is still a
  // live run, so the next time any runner stops it is loaded, re-evaluated
  // against the same failed guard, and reports the same error again, once per
  // stop. It also leaks: no garbage collector would ever come for it, and a
  // later gate command in the same session could still find it. State is
  // ephemeral and the trace is what survives a run (D11), so the final state
  // belongs in the trace.
  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: "stopped",
    run: state.runId,
    node: state.node,
    code: transition.code,
    message: transition.message,
    state: transition.state,
  });
  concludeRun(transition.state, "stopped", "[" + transition.code + "] " + transition.message);
  report("run " + state.runId + " stopped: [" + transition.code + "] " + transition.message);
}

// What the runner is told when a run answers its own questions.
//
// The options are enumerated verbatim, so the answer is a choice from a closed
// set rather than free composition, which is what makes validating it possible.
function autoAskReason(questions) {
  const lines = [
    "minflow: this run was started with --auto, so it answers its own questions.",
    "",
    "Answer each of these as the most sensible default for an unattended run. Do not ask",
    "anyone, and do not stop to think aloud.",
    "",
  ];
  for (const question of questions) {
    lines.push("- " + question.header + ": " + question.question);
    for (const option of question.options) {
      lines.push(
        "    " + option.label + (option.description ? "  (" + option.description + ")" : ""),
      );
    }
  }
  lines.push(
    "",
    "Reply with ONLY a JSON object mapping each header above to the exact label you chose,",
    "in a single fenced json block, with nothing after it.",
  );
  return lines.join("\n");
}

// The runner's answers, folded onto the options that were actually offered.
//
// A label nobody offered is replaced with the first option rather than stalling
// the run: an unattended run that hangs on its own invented answer has defeated
// its purpose. Every substitution is returned so it can be recorded, because the
// difference between "it chose this" and "it was corrected to this" is the whole
// value of the trace afterwards.
function foldAutoAnswers(questions, reported) {
  const answers = {};
  const corrections = [];
  const given = reported !== null && typeof reported === "object" && !Array.isArray(reported)
    ? reported
    : {};

  for (const question of questions) {
    const labels = question.options.map(function (option) {
      return option.label;
    });
    const fallback = labels.length > 0 ? labels[0] : "";
    const raw = given[question.header];
    const chosen = typeof raw === "string" ? raw.trim() : "";

    if (labels.indexOf(chosen) !== -1) {
      answers[question.header] = chosen;
      continue;
    }
    answers[question.header] = fallback;
    corrections.push({
      header: question.header,
      answered: chosen === "" ? null : chosen,
      used: fallback,
    });
  }
  return { answers: answers, corrections: corrections };
}

// Beats two and four of an ask.
//
// Two: the runner has just said the marker line. Rendering no decision is what
// lets it stop for real, which is what puts that line in front of the session.
//
// Four: the session has asked, written the answers, and spawned the runner
// again. The answers become an output like any other and the run carries on.
function onAskStop(event, state) {
  const ask = state.ask;
  if (ask === null || ask === undefined) {
    report(
      "run " + state.runId + " is marked as asking but carries no questions. Its state is " +
        "inconsistent and the run is stopped rather than resumed into a node it may not belong " +
        "at.",
    );
    concludeRun(state, "stopped", "marked as asking with no questions on record");
    return;
  }

  if (ask.relayed !== true) {
    const next = Object.assign({}, state);
    next.ask = Object.assign({}, ask, { relayed: true });
    saveState(next);
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "ask-relayed",
      run: state.runId,
      node: state.node,
      questions: ask.questions.length,
    });
    // No decision: the runner stops, and its last message is the marker.
    return;
  }

  if (ask.auto === true) {
    const parsed = parseInlinePayload(event.last_assistant_message);
    const folded = foldAutoAnswers(ask.questions, parsed.ok ? parsed.value : null);
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "ask-auto-answered",
      run: state.runId,
      node: state.node,
      as: ask.as,
      answers: folded.answers,
      corrections: folded.corrections,
      unparseable: parsed.ok ? null : parsed.error,
    });
    return resumeFromAsk(state, ask, folded.answers);
  }

  const answers = readAskAnswers(state.runId);
  if (!answers.ok) {
    if (answers.missing) {
      report(
        "run " + state.runId + " is waiting on answers that were never written to " +
          askAnswersPath(state.runId) + ". Answer the questions in " +
          askQuestionsPath(state.runId) + ", write them to that path, and spawn " +
          PLUGIN.runner + " again.",
      );
      return;
    }
    report("run " + state.runId + " cannot use its answers: " + answers.error);
    concludeRun(state, "stopped", "answers could not be used");
    clearAskFiles(state.runId);
    return;
  }

  appendTrace(state.runId, {
    at: new Date().toISOString(),
    decision: "ask-answered",
    run: state.runId,
    node: state.node,
    as: ask.as,
  });
  return resumeFromAsk(state, ask, answers.value);
}

// One resume path, whichever way the answers arrived. The answers become an
// output under the ask's own id and the run carries on from where it parked.
function resumeFromAsk(state, ask, answers) {
  const graph = requireGraph();
  if (graph === null) return;

  const next = Object.assign({}, state);
  delete next.ask;
  delete next.host;
  next.status = "running";
  next.outputs = Object.assign({}, state.outputs);
  next.outputs[ask.as] = answers;
  next.steps = state.steps + 1;

  clearAskFiles(state.runId);

  const landed = settle(graph, next);
  if (landed === null) return;
  const instruction = stepInstruction(graph, landed);
  if (instruction.error) {
    report(instruction.error);
    return;
  }
  block(
    [
      "minflow: the answers are in; the run continues at \"" + landed.node + "\".",
      "",
      instruction.text,
    ].join("\n"),
  );
}

function onSubagentStop(event, state) {
  // No state means this runner is not ours, or its run is already finished.
  // Saying nothing is the whole of the zero-idle-footprint requirement (D9).
  if (state === null) return;
  if (state.status === "asking") return onAskStop(event, state);
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
    scratch.start = false;
    // The entry node may itself be a command node, and so may every node after
    // it, so a run can be settled before any step is ever spawned.
    const landed = settle(graph, withScratch(state, scratch));
    if (landed === null) return;
    const first = stepInstruction(graph, landed);
    if (first.error) {
      report(first.error);
      return;
    }
    appendTrace(state.runId, {
      at: new Date().toISOString(),
      decision: "begin",
      run: state.runId,
      node: landed.node,
    });
    block(
      [
        'minflow: run ' + state.runId + ' of the "' + PLUGIN.workflow + '" begins at step "' +
          landed.node + '".',
        "",
        first.text,
      ].join("\n"),
    );
    return;
  }

  const answered = takeAnswer(scratch, event);

  // One deadline for everything the pass is about to resolve, so that slow
  // guards run out of budget here, visibly, rather than running out of the
  // platform's hook timeout, which would discard this process's output whole.
  startGuardBudget();
  advanceStubVisit(state.node);

  const resolved = {};
  let outstanding = null;
  let spellings = [];
  for (const request of runtime.observationsFor(graph, state)) {
    const stubbedJudge = request.kind === "judge" ? stubFor(state.node, request.key) : null;
    if (stubbedJudge !== null) {
      // Answered from the stub file, so no round trip through the runner. A
      // generated test states the verdict rather than asking a model for one.
      resolved[request.key] = stubbedJudge;
      continue;
    }
    if (request.kind === "judge") {
      const answer = scratch.answers[request.key];
      // The loop is not cut short at the first unanswered question: the inline
      // payload has to be read on this pass, while the runner's last message is
      // still the step's report rather than the answer to come.
      if (answer === undefined) {
        if (outstanding === null) {
          outstanding = request;
          // Declared set if there is one, recovered spellings otherwise, so a
          // guard written as judge(q).is("yes") still folds "Yes." onto "yes".
          spellings = Array.isArray(request.verdicts) && request.verdicts.length > 0
            ? request.verdicts
            : judgeSpellings(graph, request.key);
        }
        continue;
      }
      resolved[request.key] = { ok: true, value: answer };
      continue;
    }
    resolved[request.key] = resolveRequest(request, event, scratch, answered, state.node);
  }

  if (outstanding !== null) {
    scratch.asking = {
      key: outstanding.key,
      question: outstanding.question,
      // What the answer may be folded onto. Declared verdicts close the set and
      // an answer outside it is a broken contract; recovered spellings do not,
      // and an answer matching none of them is simply not this edge's verdict.
      verdicts: spellings.length > 0 ? spellings : null,
      closed: Array.isArray(outstanding.verdicts) && outstanding.verdicts.length > 0,
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
  ir: Graph,
  pluginName: string,
  runCommand: string,
  names: Record<NodeId, string>,
  gateCommands: GateCommands[],
): string {
  // Namespaced, because these are compared against the hook payload's
  // `command_name`, which always arrives as `<plugin>:<command>`. Storing the
  // bare names here would leave the dispatcher unable to recognise the very
  // commands its own matcher let through.
  const gates: Record<string, JsonValue> = {};
  for (const gate of gateCommands) {
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
    // Named rather than derived from the absence of an agent, so that a genuinely
    // missing agent stays the reportable fault it is instead of being read as a
    // node the dispatcher was supposed to run itself.
    commandNodes: ir.nodes.filter((node) => isCommandNode(node)).map((node) => node.id),
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
/**
 * Every gate's qualified resume and reject commands, exactly as the emitted
 * plugin registers them.
 *
 * Exported for the test harness. A gate is released by a command a person runs,
 * so without these there is no way to drive a generated case past one, and
 * everything downstream of a gate would be untestable.
 */
export function gateCommandsFor(
  ir: Graph,
  opts: EmitOptions = {},
): { gate: string; resume: string; reject: string }[] {
  const pluginName = pluginNameFor(ir, opts);
  const runCommand = commandNameFor(opts.command ?? `run-${pluginName}`, "the run command");
  return gatesOf(ir, runCommand).map((gate) => ({
    gate: gate.gate,
    resume: qualified(pluginName, gate.resume),
    reject: qualified(pluginName, gate.reject),
  }));
}

export function emit(ir: Graph, opts: EmitOptions = {}): PluginFiles {
  const pluginName = pluginNameFor(ir, opts);
  // Folded before anything is named after it: a command name is also a file name
  // under `commands/`, so an unchecked one writes wherever its separators point.
  const runCommand = commandNameFor(opts.command ?? `run-${pluginName}`, "the run command");
  const names = agentNames(ir);
  const gates = gatesOf(ir, runCommand);
  const commands = [runCommand];
  for (const gate of gates) {
    commands.push(gate.resume, gate.reject);
  }

  const files: PluginFiles = {};
  files[MANIFEST_PATH] = manifestFor(ir, opts, pluginName);
  files[HOOKS_PATH] = hooksFor(pluginName, commands);
  files[DISPATCHER_PATH] = dispatcherFor(ir, pluginName, runCommand, names, gates);
  // Byte-identical for every graph. The dispatcher requires it rather than
  // reimplementing the transition rules, and it travels with the plugin rather
  // than being resolved from a node_modules that an installed plugin does not
  // have; see {@link RUNTIME_SOURCE} for the alternatives and why they lose.
  files[RUNTIME_PATH] = RUNTIME_SOURCE;
  files[RUNNER_PATH] = runnerFor(ir, pluginName, runCommand);
  // Every alternative in the UserPromptExpansion matcher needs a command that
  // actually exists, or the hook is unreachable and the plugin is inert.
  files[`${COMMANDS_DIR}/${runCommand}.md`] = runCommandFile(ir, pluginName);
  Object.assign(files, gateCommandFiles(ir, pluginName, gates));
  const byGate = gateIndex(gates);
  for (const node of ir.nodes) {
    // A command node runs in the dispatcher and has no wrapper to write.
    if (isCommandNode(node)) continue;
    const agent = names[node.id];
    if (agent === undefined) continue;
    files[`agents/${agent}.md`] = stepFor(
      ir,
      node,
      agent,
      obligationsFor(ir, node.id),
      pluginName,
      byGate,
    );
  }
  // Canonical, not insertion-ordered: this file is the graph's value on disk, and
  // it has to match for two graphs `graphHash` calls identical.
  files[COMPILED_GRAPH_PATH] = canonicalJsonFile(ir);
  mergeSkills(files, ir, opts.skills);
  // Last, so every generated path already exists to collide against.
  mergeAssets(files, opts.assets);
  return files;
}

/**
 * Write the graph's skills into the plugin, every one of them private.
 *
 * Bundled resources come too. A skill is a directory: a body that says "see
 * `references/rules.md`" is broken by a copy that brings only the body, and
 * broken silently, because the body still loads and the step runs anyway.
 */
function mergeSkills(files: PluginFiles, ir: Graph, skills: Skill[] | undefined): void {
  if (skills === undefined) return;

  const supplied = new Map<string, Skill>();
  for (const skill of skills) supplied.set(skill.name, skill);

  const needed = new Set<string>();
  for (const node of ir.nodes) {
    if (!isCommandNode(node)) needed.add(node.skill);
  }

  const missing = [...needed].filter((name) => !supplied.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(
      `minflow: emit was given skills but not these, which steps name: ${missing.join(", ")}. ` +
        "A partial set ships a plugin that resolves some steps from inside itself and others " +
        "from whatever happens to be installed. Supply every skill the graph names, or none.",
    );
  }

  for (const name of [...needed].sort()) {
    const skill = supplied.get(name);
    if (skill === undefined) continue;

    const problems = skill.problems();
    if (problems.length > 0) {
      const detail = problems.map((problem) => `${problem.field} ${problem.detail}`).join(" ");
      throw new Error(`minflow: the skill "${name}" cannot be shipped: ${detail}`);
    }

    // A skill whose frontmatter name disagrees with its directory does not
    // resolve, and the platform reports that as a debug-log line nobody reads.
    const directory = `${SKILLS_DIR}/${name}`;
    files[`${directory}/${SKILL_FILE_NAME}`] = skill.withUserInvocable(false).toMarkdown();

    for (const [relative, contents] of Object.entries(skill.files).sort()) {
      files[`${directory}/${relative}`] = contents;
    }
  }
}

/**
 * Fold {@link EmitOptions.assets} into the generated map, or refuse.
 *
 * Every rejection here is a case where the plugin would still install and still
 * validate, so nothing downstream would report it. The path checks mirror
 * {@link writeFiles}, which cannot be the only guard: `emit` is pure and its map
 * is asserted against in tests that never touch a filesystem.
 */
function mergeAssets(files: PluginFiles, assets: EmitOptions["assets"]): void {
  if (assets === undefined) return;
  for (const raw of Object.keys(assets).sort()) {
    const contents = assets[raw];
    if (contents === undefined) continue;
    const at = `minflow: asset "${raw}"`;
    if (raw.trim() === "") {
      throw new Error("minflow: an asset path cannot be empty.");
    }
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
      throw new Error(`${at} must be relative to the plugin root, not absolute.`);
    }
    if (raw.includes("\\")) {
      throw new Error(`${at} must use POSIX separators, so "/" rather than "\\".`);
    }
    const segments = raw.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error(`${at} escapes the plugin root. Asset paths cannot contain "..".`);
    }
    if (segments.some((segment) => segment === "" || segment === ".")) {
      throw new Error(`${at} has an empty or "." path segment.`);
    }
    if (raw in files) {
      throw new Error(
        `${at} collides with a file the compiler generates. ` +
          "Pick another path: an asset overwriting a generated file produces a plugin " +
          "that installs and validates but cannot route.",
      );
    }
    files[raw] = contents;
  }
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
 * Every path is checked to land inside `destDir` before anything is written, and
 * the whole map is refused if one does not. This function takes a map, not a
 * graph, so it cannot assume the map came from {@link emit}, and writing outside
 * the directory a caller named is not a thing to do halfway.
 *
 * @returns The absolute paths written, in sorted order.
 */
export async function writeFiles(files: PluginFiles, destDir: string): Promise<string[]> {
  // Imported here rather than at module scope so that importing the pure half of
  // this module pulls in no Node built-ins at all.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const root = path.resolve(destDir);
  const targets: [relative: string, target: string, contents: string][] = [];
  for (const relative of Object.keys(files).sort()) {
    const contents = files[relative];
    if (contents === undefined) continue;
    // Resolved rather than joined, because a `..` segment only shows where it
    // leads once the path is normalized. An absolute key is refused outright
    // instead of being reinterpreted as a path inside the destination, since a
    // caller who named `/etc/hosts` did not mean `<destDir>/etc/hosts`.
    const target = path.resolve(root, ...relative.split("/"));
    if (path.isAbsolute(relative) || !target.startsWith(root + path.sep)) {
      throw new Error(
        `minflow: refusing to write "${relative}": a plugin file map may only name relative ` +
          `paths inside the directory it is written to, and this one leaves "${root}". ` +
          "Nothing was written.",
      );
    }
    targets.push([relative, target, contents]);
  }

  const written: string[] = [];
  for (const [, target, contents] of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
    written.push(target);
  }
  return written;
}
