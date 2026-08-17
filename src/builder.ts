/**
 * The public authoring surface.
 *
 * The formalism underneath is a Mealy transducer, and the compiled artifact is
 * the transition table in {@link ./ir.ts}. Nobody writes that by hand. What they
 * write is this builder, deliberately shaped like LangGraph (`step`, `entry`,
 * `edge`, `branch`, `gate`, `compile`) because that is the mental model most
 * people arriving with an agent graph already have, so the API costs nothing to
 * learn (SPEC §1.3, D24).
 *
 * The builder is not sugar. It exists for **error locality**. A transition table
 * handed over as a literal reports a typo'd node name as a key lookup against a
 * blob, at some later moment, with a stack that points at the compiler. Here,
 * `wf.edge("reserch", "plan")` throws on the line that contains the typo, names
 * what was typed, and lists what exists.
 *
 * **The cost of that is a forward-reference ban.** A node has to be declared
 * before any edge mentions it, because "is this a real node?" is answered at the
 * call rather than deferred to compile time. Declare your steps, then wire them.
 * This is the accepted trade, not an oversight.
 *
 * Two further properties are load-bearing and are enforced here rather than
 * documented and hoped for:
 *
 * - **Guards are data.** Every `when.*` returns a plain object. The compiled
 *   graph ships as JSON and is read back by a different process on every
 *   transition, so a closure would not survive the trip.
 * - **Mechanical by default.** `when.*` is a whole library of cheap predicates
 *   and {@link judge} is one conspicuous function, which makes D10's preference
 *   for mechanical guards a property of the surface rather than a line in a
 *   style guide.
 *
 * @packageDocumentation
 */

import { graphHash } from "./hash.js";
import type {
  AskQuestion,
  AskQuestions,
  AskSpec,
  Edge,
  End,
  FieldOp,
  Graph,
  Guard,
  JsonValue,
  Node,
  NodeId,
  Otherwise,
  PayloadSource,
} from "./ir.js";
import { COMMAND_OUTPUT_KEYS, isCommandNode, isEnd, templateOf } from "./ir.js";

export { END } from "./ir.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Scalar types the `output` shorthand understands. Anything richer than a flat
 * object of these belongs in `schema`, written as JSON Schema.
 */
export type OutputType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "string[]"
  | "number[]"
  | "integer[]"
  | "boolean[]";

/** Field name to type, e.g. `{ notes: "string", sources: "string[]" }`. */
export type OutputSpec = Record<string, OutputType>;

/** Everything a step can declare. Only `skill` is required. */
export interface StepOptions {
  /** The user's skill this node invokes. Never modified, only named. */
  skill: string;
  /** Template over the run context, producing the invocation. */
  prompt?: string;
  /** Scalars interpolated inline into the prompt. */
  params?: Record<string, JsonValue>;
  /** Structured-output contract, as JSON Schema. Mutually exclusive with `output`. */
  schema?: JsonValue;
  /** Per-node model override. */
  model?: string;
  /** Per-step turn ceiling. */
  maxTurns?: number;
  /** Tool allowlist for the step. */
  tools?: string[];
  /** Display grouping. */
  phase?: string;
  /** Shorthand that compiles into `schema`. Mutually exclusive with `schema`. */
  output?: OutputSpec;
}

/** Everything a command node can declare. Only `command` is required. */
export interface RunOptions {
  /**
   * The command to execute, as a template over the run context.
   *
   * Takes the same `{{params.key}}` and `{{ctx.node.path}}` forms a prompt does,
   * and is checked the same way, dominance included.
   */
  command: string;
  /** Scalars interpolated inline into the command. */
  params?: Record<string, JsonValue>;
  /** Ceiling in milliseconds. Past it the host kills the command and errors. */
  timeoutMs?: number;
  /** Display grouping. */
  phase?: string;
}

/**
 * What {@link retry} returns.
 *
 * It carries the limit, which the IR keeps on the edge rather than inside
 * `otherwise`, so the builder splits it. Writing `retry(3, "tests failing")`
 * therefore sets both `edge.otherwise` and `edge.limit`.
 */
export interface RetrySpec {
  kind: "retry";
  reason: string;
  limit: number;
}

/**
 * Accepted forms for `otherwise`: a retry, an explicit goto, or a bare node id.
 *
 * The raw IR form `{ kind: "retry", reason }` carries no ceiling, and nothing
 * adds one for it: such an edge retries **without a bound of its own**, stopped
 * only by the evaluator's run-wide step ceiling. {@link retry} exists so the
 * bound is not something you can forget, so prefer it.
 */
export type EdgeOtherwise = Otherwise | RetrySpec | NodeId | End;

/** Options for {@link WorkflowBuilder.edge}. */
export interface EdgeOptions {
  /** What to do when the guard does not hold. */
  otherwise?: EdgeOtherwise;
  /**
   * Ceiling on `otherwise: retry`. Set for you when you pass {@link retry}.
   *
   * It bounds the retry path and nothing else. The evaluator reads it only
   * when a guard fails and the edge's `otherwise` is a retry (see `Edge.limit`
   * in the IR). Setting it on an edge with no retry is therefore rejected rather
   * than accepted as a loop ceiling it cannot be.
   *
   * It counts retries, so it has to be a positive whole number. A ceiling below
   * one attempt is refused here rather than at run time, where the first failure
   * is already past it.
   */
  limit?: number;
  /** The discretized input this edge keys on. Defaults to `"pass"`. */
  event?: string;
  /**
   * The payload lane this edge's guards read.
   *
   * Applied as the default to every guard in this edge's tree that does not
   * name a lane of its own. Delivery is per edge because it is per *reader*: the
   * same step's payload can be read inline by one edge and out of a file by
   * another, and the evaluator never learns the difference (SPEC §6.3).
   */
  from?: PayloadSource;
}

/**
 * What {@link askFrom} returns: questions computed by the step rather than
 * written into the graph.
 */
export interface AskFromOutput {
  kind: "output";
  path: string;
}

/** Options for {@link WorkflowBuilder.ask}. */
export interface AskOptions {
  /**
   * The questions, either written here or read out of the step's own payload
   * with {@link askFrom}.
   */
  questions: AskQuestion[] | AskFromOutput;
  /**
   * The id the answers are recorded under, readable later as
   * `{{ctx.<as>.<key>}}`. Defaults to the asking node's id with `-answers`.
   */
  as?: NodeId;
}

/** Options for {@link WorkflowBuilder.gate}. */
export interface GateOptions {
  /** Names the resume command a human runs to release the run. */
  command: string;
}

/**
 * What {@link judge} returns.
 *
 * Two ways to spend it. Hand it to {@link WorkflowBuilder.branch}, which turns it
 * into one edge per route and closes the verdict set from the route keys; or name
 * a single verdict with {@link JudgeSpec.is}, which yields a plain {@link Guard}
 * that composes under `when.all`, `when.any` and `when.not` like any other.
 */
export interface JudgeSpec {
  kind: "judge";
  question: string;
  from?: PayloadSource;
  /**
   * The verdict this guard fires on, as a composable {@link Guard}.
   *
   * Unlike {@link WorkflowBuilder.branch}, this declares no closed verdict set:
   * there are no route keys to close it from, so the guard simply holds when the
   * judge answers with `verdict` and fails on anything else.
   */
  is(verdict: string): Guard;
}

/** Verdict label to destination. Insertion order is the edge order. */
export type Routes = Record<string, NodeId | End>;

/** Options accepted by {@link when.field} and {@link judge}. */
export interface LaneOptions {
  /** The lane this guard reads. Overrides any default the edge sets. */
  from?: PayloadSource;
}

/** The comparisons available on a field guard. */
export interface FieldGuard {
  /** Field is present and truthy. */
  truthy(): Guard;
  /** Deep equality against a JSON value. */
  equals(value: JsonValue): Guard;
  /** Deep inequality against a JSON value. */
  notEquals(value: JsonValue): Guard;
  /**
   * Field matches a pattern. A `RegExp` is stored as its `source`; flags are
   * refused, because they do not survive the JSON round trip.
   */
  matches(pattern: RegExp | string): Guard;
  /** Field is greater than a number. */
  gt(value: number): Guard;
  /** Field is less than a number. */
  lt(value: number): Guard;
}

/** The builder returned by {@link workflow}. Every method returns it, so calls chain. */
export interface WorkflowBuilder {
  /** The workflow's name, as given to {@link workflow}. */
  readonly name: string;
  /** Declares a node. Throws on a duplicate id. */
  step(id: NodeId, options: StepOptions): WorkflowBuilder;
  /**
   * Declares a node that runs a shell command instead of a model.
   *
   * Its payload is `{ exitCode, stdout, stderr }`, so the guards leaving it are
   * ordinary field guards: `when.field("exitCode").equals(0)`. It costs no model
   * call, which is the whole reason to reach for it, and it has to finish inside
   * the host's hook budget, which is the reason not to.
   */
  run(id: NodeId, options: RunOptions): WorkflowBuilder;
  /** Names the starting node. Throws unless it is already declared. */
  entry(id: NodeId): WorkflowBuilder;
  /** Adds a transition. Both ends must already be declared. */
  edge(from: NodeId, to: NodeId | End, guard?: Guard, options?: EdgeOptions): WorkflowBuilder;
  /**
   * Adds a transition that parks for human sign-off.
   *
   * `to` is a real node, never `END`: a parked run stores the node it will resume
   * into, so there is no state that means "parked before the end". The type
   * cannot say so on its own, since `NodeId` is `string`, which `END` inhabits, so
   * the rejection happens at the call, with the reason.
   */
  gate(from: NodeId, to: NodeId, options: GateOptions): WorkflowBuilder;
  /**
   * Adds a transition that puts questions to the user and then continues by
   * itself, with nothing typed.
   *
   * The distinction from {@link WorkflowBuilder.gate} is what happens after the
   * human acts. A gate ends the run segment and waits for a resume command. An
   * ask hands the questions to whatever can reach the user, takes the answers,
   * records them as an output a later step can interpolate, and carries on.
   */
  ask(from: NodeId, to: NodeId, options: AskOptions): WorkflowBuilder;
  /** Adds one judged transition per route, all sharing one question. */
  branch(from: NodeId, spec: JudgeSpec, routes: Routes): WorkflowBuilder;
  /** Runs the whole-graph checks and returns the IR. Throws if anything fails. */
  compile(): Graph;
  /** Human-readable rendering. Never throws, so it can be used to debug a broken graph. */
  print(): string;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const GUARD_KINDS = new Set([
  "always",
  "exitZero",
  "fileExists",
  "field",
  "judge",
  "not",
  "all",
  "any",
]);

/**
 * The mechanical predicate library.
 *
 * Every member returns a plain data object, never a closure, because the
 * compiled graph is JSON that a separate process reads back on each transition.
 */
export const when = {
  /** Unconditional. The default guard on an edge. */
  always(): Guard {
    return { kind: "always" };
  },

  /** True when `path` exists on disk, as the host sees it. */
  fileExists(path: string): Guard {
    return { kind: "fileExists", path: requireText(path, 'when.fileExists("...")', "path") };
  },

  /** True when the shell command exits 0. */
  exitZero(command: string): Guard {
    return { kind: "exitZero", command: requireText(command, 'when.exitZero("...")', "command") };
  },

  /**
   * Reads a dot path out of the step's JSON payload, e.g.
   * `when.field("findings.count").gt(0)`.
   *
   * Returns a comparison builder, not a guard: the guard exists once you name
   * the comparison.
   */
  field(path: string, options: LaneOptions = {}): FieldGuard {
    const at = requireText(path, 'when.field("...")', "path");
    const build = (op: FieldOp, value?: JsonValue): Guard => {
      const guard: {
        kind: "field";
        path: string;
        op: FieldOp;
        value?: JsonValue;
        from?: PayloadSource;
      } = { kind: "field", path: at, op };
      if (value !== undefined) guard.value = value;
      if (options.from !== undefined) guard.from = options.from;
      return guard;
    };
    return {
      truthy: () => build("truthy"),
      equals: (value) => build("equals", value),
      notEquals: (value) => build("notEquals", value),
      gt: (value) => build("gt", value),
      lt: (value) => build("lt", value),
      matches: (pattern) => {
        if (typeof pattern !== "string" && pattern.flags !== "") {
          throw new Error(
            `minflow: when.field("${at}").matches(/${pattern.source}/${pattern.flags}): ` +
              "regular-expression flags do not survive the IR, which ships as JSON. " +
              "Pass a pattern with no flags.",
          );
        }
        return build("matches", typeof pattern === "string" ? pattern : pattern.source);
      },
    };
  },

  /** Conjunction. Empty is vacuously true, per the IR. */
  all(...guards: Guard[]): Guard {
    for (const [index, guard] of guards.entries()) {
      assertGuard(guard, "when.all()", index);
    }
    return { kind: "all", guards: [...guards] };
  },

  /** Disjunction. Empty is vacuously false, per the IR. */
  any(...guards: Guard[]): Guard {
    for (const [index, guard] of guards.entries()) {
      assertGuard(guard, "when.any()", index);
    }
    return { kind: "any", guards: [...guards] };
  },

  /** Negation. */
  not(guard: Guard): Guard {
    assertGuard(guard, "when.not()", 0);
    return { kind: "not", guard };
  },
} as const;

/**
 * The one conspicuous escape hatch into model judgment.
 *
 * It is a function rather than a member of {@link when} on purpose: judgment
 * costs a model call and can be wrong, so it should read differently on the page
 * from the mechanical predicates around it.
 *
 * Feed it to {@link WorkflowBuilder.branch} for the common shape, one edge per
 * verdict over a closed verdict set, or finish it with `.is("yes")` for a plain
 * guard that composes with the mechanical ones, e.g.
 * `when.all(when.exitZero("npm test"), judge("Is the diff small?").is("yes"))`.
 * The IR, the evaluator and every emitter already treat a judge guard as an
 * ordinary leaf, so nothing but this surface was stopping the composition.
 */
export function judge(question: string, options: LaneOptions = {}): JudgeSpec {
  const asked = requireText(question, 'judge("...")', "question");
  const lane = options.from;
  const spec: JudgeSpec = {
    kind: "judge",
    question: asked,
    is(verdict: string): Guard {
      const guard: { kind: "judge"; question: string; is: string; from?: PayloadSource } = {
        kind: "judge",
        question: asked,
        is: requireText(verdict, `judge("${asked}").is("...")`, "verdict"),
      };
      if (lane !== undefined) guard.from = lane;
      return guard;
    },
  };
  if (lane !== undefined) spec.from = lane;
  return spec;
}

/**
 * Read an ask's questions out of the asking step's own payload, at a dot path.
 *
 * The alternative is writing them into the graph, which is right when they are
 * fixed and wrong as soon as they are not: a step that has just scanned a
 * directory, read a config, or found three unresolved references knows things
 * the author did not, and this is how it gets to ask about them.
 */
export function askFrom(path: string): AskFromOutput {
  return { kind: "output", path: requireText(path, 'askFrom("...")', "path") };
}

/**
 * Validate what an author passed as `questions`, into the IR's shape.
 *
 * Every field is checked here rather than at run time because a malformed
 * question reaches the user as a dialog with no options in it, and by then the
 * run is already parked waiting for an answer to a question nobody can read.
 */
function askQuestionsSpec(questions: AskQuestion[] | AskFromOutput, context: string): AskQuestions {
  if (questions !== null && typeof questions === "object" && !Array.isArray(questions)) {
    if (questions.kind !== "output") {
      throw new Error(
        `minflow: ${context} got a { questions } it does not recognise. Pass a list, or ` +
          'askFrom("path").',
      );
    }
    return { kind: "output", path: questions.path };
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(
      `minflow: ${context} needs at least one question, or askFrom("path") to read them out ` +
        "of the step's own output.",
    );
  }
  for (const [index, entry] of questions.entries()) {
    const at = `${context} question ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`minflow: ${at} is not an object.`);
    }
    requireText(entry.question, at, "question");
    requireText(entry.header, at, "header");
    if (!Array.isArray(entry.options) || entry.options.length === 0) {
      throw new Error(
        `minflow: ${at} offers no options. A question with nothing to pick from cannot be ` +
          "answered.",
      );
    }
    for (const [position, option] of entry.options.entries()) {
      if (option === null || typeof option !== "object" || Array.isArray(option)) {
        throw new Error(`minflow: ${at} option ${position + 1} is not an object.`);
      }
      requireText(option.label, `${at} option ${position + 1}`, "label");
    }
  }
  return { kind: "static", items: clone(questions) };
}

/**
 * Re-run the current node, up to `limit` attempts, handing it `reason`.
 *
 * Pass it as `otherwise`. The builder splits it: the reason goes into
 * `edge.otherwise`, the limit onto `edge.limit`, which is where the IR keeps it
 * because retry counters are keyed by edge id.
 */
export function retry(limit: number, reason: string): RetrySpec {
  if (!isRetryBudget(limit)) {
    throw new Error(
      `minflow: retry(${String(limit)}, ...) needs a positive whole number of attempts.`,
    );
  }
  return { kind: "retry", reason: requireText(reason, 'retry(n, "...")', "reason"), limit };
}

/**
 * A retry ceiling counts attempts, so it has to admit at least one whole one.
 *
 * Anything else is an edge that reads as bounded and is not: with a ceiling of
 * zero, a negative, or a fraction below one, the evaluator computes attempt 1,
 * finds it past the ceiling, and ends the run on the very failure the retry was
 * written to absorb.
 */
function isRetryBudget(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1;
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

/**
 * One `{{...}}` occurrence in a node's prompt.
 *
 * The two legal forms differ in when they can be resolved at all. `params` names
 * a scalar the node itself declares, which is fixed once the graph compiles, so
 * a backend substitutes it at emit time. `ctx` names a path into an earlier
 * step's payload, which exists only after that step has run, so the host
 * substitutes it from `RunState.outputs` at spawn time.
 *
 * `invalid` is an occurrence that is neither. It is carried back rather than
 * thrown because the two callers want different things from it:
 * {@link WorkflowBuilder.step} throws at the authoring line, {@link lintGraph}
 * collects one line per problem.
 */
export type PromptPlaceholder =
  | { kind: "params"; key: string; text: string }
  | { kind: "ctx"; node: NodeId; path: string; text: string }
  | { kind: "invalid"; text: string; reason: string };

/** What one dotted segment of a placeholder may hold. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Keeps an unclosed placeholder from dragging the rest of the prompt into a message. */
const EXCERPT = 40;

/**
 * Every placeholder in a prompt, in the order they were written.
 *
 * Strict on purpose. Anything that is not one of the two forms is reported
 * rather than passed through, because an unsubstituted placeholder is not inert:
 * it reaches the model verbatim, so the step runs with the literal text
 * `{{ctx.research.notes}}` where its input should have been and nothing says so.
 * A third form later is an edit to this function; guessing at one here is a
 * prompt that is silently wrong.
 */
export function parsePrompt(prompt: string): PromptPlaceholder[] {
  const found: PromptPlaceholder[] = [];
  let cursor = 0;
  for (;;) {
    const open = prompt.indexOf("{{", cursor);
    if (open === -1) return found;
    const close = prompt.indexOf("}}", open + 2);
    if (close === -1) {
      found.push({
        kind: "invalid",
        text: excerpt(prompt.slice(open)),
        reason: "it opens a placeholder that is never closed",
      });
      return found;
    }
    found.push(readPlaceholder(prompt.slice(open + 2, close), prompt.slice(open, close + 2)));
    cursor = close + 2;
  }
}

/** Reads one placeholder's contents, `text` being the whole thing as written. */
function readPlaceholder(inner: string, text: string): PromptPlaceholder {
  const invalid = (reason: string): PromptPlaceholder => ({ kind: "invalid", text, reason });
  const written = inner.trim();
  if (written === "") return invalid("it names nothing");
  if (written.includes("{") || written.includes("}")) {
    return invalid("it holds a brace, so the placeholder before it was probably left unclosed");
  }

  const [head, ...rest] = written.split(".");
  if (!rest.every((segment) => SEGMENT.test(segment))) {
    return invalid(
      "one of its segments is empty or holds something other than letters, digits, underscores " +
        "and hyphens",
    );
  }

  if (head === "params") {
    const [key, ...extra] = rest;
    if (key === undefined || extra.length > 0) {
      return invalid(
        "a params reference names exactly one of this step's declared scalars, as in " +
          "{{params.depth}}",
      );
    }
    return { kind: "params", key, text };
  }

  if (head === "ctx") {
    const [producer, ...path] = rest;
    if (producer === undefined || path.length === 0) {
      return invalid(
        "a ctx reference names a node and then a path into that step's payload, as in " +
          "{{ctx.research.notes}}",
      );
    }
    return { kind: "ctx", node: producer, path: path.join("."), text };
  }

  return invalid(
    "the only forms are {{params.key}}, naming one of this step's own params, and " +
      "{{ctx.node.path}}, naming a path into an earlier step's payload",
  );
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= EXCERPT ? flat : `${flat.slice(0, EXCERPT)}...`;
}

/**
 * The unreadable-placeholder line, written once.
 *
 * The same fault is reported at two moments and has to read the same way at
 * both: `step()` throws it at the call being written, {@link lintGraph} returns
 * it for a graph that arrived from a front-end which is not the builder.
 * `subject` is the only difference.
 */
function unreadablePrompt(subject: string, placeholder: { text: string; reason: string }): string {
  return (
    `${subject} has a prompt placeholder minflow cannot read: ${placeholder.text}, because ` +
    `${placeholder.reason}. A placeholder nothing substitutes is rendered into the step verbatim.`
  );
}

/** The unknown-param line, likewise written once for both callers. */
function unknownParam(subject: string, text: string, params: Record<string, JsonValue>): string {
  const keys = Object.keys(params);
  return (
    `${subject} reads ${text}, which names no param it declares. Declared params: ` +
    `${keys.length === 0 ? "(none)" : keys.join(", ")}. A params placeholder is filled from the ` +
    "node's own params when the graph is emitted, so nothing else can supply it."
  );
}

/**
 * Every placeholder written inside a node's param values, each with the path it
 * sits at.
 *
 * A param value is text a backend splices into the prompt, and both
 * substitution passes run over that one string: params first, run context
 * second. A placeholder carried in a param value is therefore substituted like
 * any other while being invisible to every check that reads `node.prompt`, which
 * makes it a way around the dominance rule rather than a use of it.
 *
 * Param values are `JsonValue`, so the walk descends into arrays and objects
 * instead of reading top-level strings only.
 */
function paramPlaceholders(
  params: Record<string, JsonValue>,
): { path: string; placeholder: PromptPlaceholder }[] {
  const found: { path: string; placeholder: PromptPlaceholder }[] = [];
  const walk = (value: JsonValue, path: string): void => {
    if (typeof value === "string") {
      for (const placeholder of parsePrompt(value)) found.push({ path, placeholder });
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${path}.${index}`);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(params)) walk(value, key);
  return found;
}

/**
 * Why a placeholder inside a param value cannot stand, or undefined when it is
 * inert.
 *
 * Only the two substitutable forms are refused. Anything else is text no
 * substitution pass replaces, and refusing it would forbid a param that
 * legitimately holds braces.
 */
function templatedParam(
  subject: string,
  path: string,
  placeholder: PromptPlaceholder,
): string | undefined {
  if (placeholder.kind === "ctx") {
    return (
      `${subject} param "${path}" holds ${placeholder.text}. A param is a compile-time constant ` +
      `and a ctx reference is not: it reads a payload that exists only once "${placeholder.node}" ` +
      "has run. Params are substituted into the prompt before run context is, so a reference " +
      "written here resolves at run time having never faced the check that the step it names " +
      "always ran. Write the reference in the prompt, which is where a ctx reference is read."
    );
  }
  if (placeholder.kind === "params") {
    return (
      `${subject} param "${path}" holds ${placeholder.text}. A param value is substituted into ` +
      "the prompt as written and is never expanded again, so this placeholder reaches the step " +
      "verbatim, and expanding it would take a second substitution pass nothing performs. Write " +
      "the value out."
    );
  }
  return undefined;
}

/** Every param-value fault on one node, as lines. Empty when the params are constants. */
function paramProblems(subject: string, params: Record<string, JsonValue>): string[] {
  const problems: string[] = [];
  for (const { path, placeholder } of paramPlaceholders(params)) {
    const problem = templatedParam(subject, path, placeholder);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** Starts a workflow. See the module doc for what the builder buys and costs. */
export function workflow(options: { name: string }): WorkflowBuilder {
  if (options === null || typeof options !== "object" || typeof options.name !== "string") {
    throw new Error('minflow: workflow() needs a { name }, e.g. workflow({ name: "ship-it" }).');
  }
  return new Builder(requireText(options.name, "workflow({ name })", "name"));
}

class Builder implements WorkflowBuilder {
  readonly name: string;
  readonly #nodes = new Map<NodeId, Node>();
  readonly #edges: Edge[] = [];
  readonly #counts = new Map<NodeId, number>();
  #entry: NodeId | undefined;

  constructor(name: string) {
    this.name = name;
  }

  step(id: NodeId, options: StepOptions): WorkflowBuilder {
    const at = requireText(id, "step(id, ...)", "id");
    if (isEnd(at)) {
      throw new Error(
        `minflow: step("${at}") uses a reserved id; END marks a terminal transition.`,
      );
    }
    if (this.#nodes.has(at)) {
      throw new Error(
        `minflow: duplicate step id "${at}". Already declared: ${this.#knownNodes()}.`,
      );
    }
    if (options === null || typeof options !== "object" || typeof options.skill !== "string") {
      throw new Error(
        `minflow: step("${at}") needs a { skill } naming the skill it invokes, ` +
          `e.g. step("${at}", { skill: "review-changes" }).`,
      );
    }
    if (options.schema !== undefined && options.output !== undefined) {
      throw new Error(
        `minflow: step("${at}") sets both "schema" and "output". "output" is shorthand ` +
          'that compiles into "schema"; use one or the other.',
      );
    }

    // An empty skill is not a smaller mistake than a missing one: the emitter
    // renders `skills: [""]` and the generated wrapper preloads nothing, so the
    // step runs with none of the instructions it exists to carry.
    const skill = requireText(
      options.skill,
      `step("${at}")`,
      'skill, e.g. { skill: "review-changes" }',
    );

    // A prompt is a template, and its two placeholder forms are answerable at
    // different moments. A params reference names one of this node's own
    // scalars, which are right here, so a typo in one is caught at the line that
    // wrote it. A ctx reference needs the whole edge set to decide whether the
    // step it names has certainly run, and no edge exists yet, so it is left to
    // lintGraph.
    const params = options.params ?? {};

    // A param is a constant, and both its value and this step's own prompt are
    // right here, so a template hidden in a value is refused at the line that
    // wrote it. This is not a stylistic rule: the substitution passes run over
    // one string, params first and run context second, so a ctx reference
    // written into a value would be resolved by the host without ever having
    // been read as a reference by anything that checks one.
    const [smuggled] = paramProblems(`step("${at}")`, params);
    if (smuggled !== undefined) throw new Error(`minflow: ${smuggled}`);

    for (const placeholder of parsePrompt(options.prompt ?? "")) {
      if (placeholder.kind === "invalid") {
        throw new Error(`minflow: ${unreadablePrompt(`step("${at}")`, placeholder)}`);
      }
      if (placeholder.kind === "params" && !Object.hasOwn(params, placeholder.key)) {
        throw new Error(`minflow: ${unknownParam(`step("${at}")`, placeholder.text, params)}`);
      }
    }

    const node: Node = { id: at, skill };
    if (options.prompt !== undefined) node.prompt = options.prompt;
    if (options.params !== undefined) node.params = options.params;
    if (options.model !== undefined) node.model = options.model;
    if (options.maxTurns !== undefined) node.maxTurns = options.maxTurns;
    if (options.tools !== undefined) node.tools = options.tools;
    if (options.phase !== undefined) node.phase = options.phase;
    if (options.output !== undefined) node.schema = outputToSchema(at, options.output);
    else if (options.schema !== undefined) node.schema = options.schema;

    this.#nodes.set(at, node);
    return this;
  }

  run(id: NodeId, options: RunOptions): WorkflowBuilder {
    const at = requireText(id, "run(id, ...)", "id");
    if (isEnd(at)) {
      throw new Error(`minflow: run("${at}") uses a reserved id; END marks a terminal transition.`);
    }
    if (this.#nodes.has(at)) {
      throw new Error(
        `minflow: duplicate node id "${at}". Already declared: ${this.#knownNodes()}.`,
      );
    }
    if (options === null || typeof options !== "object" || typeof options.command !== "string") {
      throw new Error(
        `minflow: run("${at}") needs a { command } naming what to execute, ` +
          `e.g. run("${at}", { command: "npm test" }).`,
      );
    }

    const command = requireText(
      options.command,
      `run("${at}")`,
      'command, e.g. { command: "npm test" }',
    );
    // Whitespace is the worst spelling of an empty command rather than a
    // smaller one: a shell handed it runs nothing and exits 0, so the node
    // reports success and the run routes on as though the check had passed.
    if (command.trim() === "") {
      throw new Error(
        `minflow: run("${at}") has a command of only whitespace. A shell handed it exits 0 ` +
          "without doing anything, so the node would report success it never earned.",
      );
    }

    // A ceiling that admits no time is an edge that reads as bounded and is
    // not: the host kills the command before it can report, and every run
    // fails on the timeout rather than on anything the command found.
    if (options.timeoutMs !== undefined && !isPositiveMilliseconds(options.timeoutMs)) {
      throw new Error(
        `minflow: run("${at}") needs a positive whole number of milliseconds for timeoutMs, ` +
          `got ${String(options.timeoutMs)}.`,
      );
    }

    const params = options.params ?? {};
    const [smuggled] = paramProblems(`run("${at}")`, params);
    if (smuggled !== undefined) throw new Error(`minflow: ${smuggled}`);

    for (const placeholder of parsePrompt(command)) {
      if (placeholder.kind === "invalid") {
        throw new Error(`minflow: ${unreadablePrompt(`run("${at}")`, placeholder)}`);
      }
      if (placeholder.kind === "params" && !Object.hasOwn(params, placeholder.key)) {
        throw new Error(`minflow: ${unknownParam(`run("${at}")`, placeholder.text, params)}`);
      }
    }

    const node: Node = { kind: "command", id: at, command };
    if (options.params !== undefined) node.params = options.params;
    if (options.timeoutMs !== undefined) node.timeoutMs = options.timeoutMs;
    if (options.phase !== undefined) node.phase = options.phase;

    this.#nodes.set(at, node);
    return this;
  }

  entry(id: NodeId): WorkflowBuilder {
    if (!this.#nodes.has(id)) {
      throw new Error(
        `minflow: entry("${id}") names an unknown node. Known nodes: ${this.#knownNodes()}. ` +
          "Steps must be declared before they are referenced.",
      );
    }
    this.#entry = id;
    return this;
  }

  edge(from: NodeId, to: NodeId | End, guard?: Guard, options: EdgeOptions = {}): WorkflowBuilder {
    const context = `edge("${from}", "${to}")`;
    this.#requireNode(from, context);
    this.#requireTarget(to, context);

    const declared = guard ?? when.always();
    assertGuard(declared, context);
    const resolved = options.from === undefined ? declared : withLane(declared, options.from);

    const extras: { otherwise?: Otherwise; limit?: number } = {};
    if (options.limit !== undefined) extras.limit = options.limit;

    const otherwise = options.otherwise;
    if (typeof otherwise === "string") {
      this.#requireTarget(otherwise, context);
      extras.otherwise = { kind: "goto", node: otherwise };
    } else if (otherwise !== undefined && otherwise.kind === "goto") {
      this.#requireTarget(otherwise.node, context);
      extras.otherwise = { kind: "goto", node: otherwise.node };
    } else if (otherwise !== undefined) {
      // Everything left is a retry, in one of its two forms. An object wearing
      // any other kind would fall into this arm and be rewritten as a retry with
      // no reason, so it is named and refused instead.
      const kind: string = otherwise.kind;
      if (kind !== "retry") {
        throw new Error(
          `minflow: ${context} was given an "otherwise" of kind "${kind}". It has to be a node ` +
            'id, END, a { kind: "goto", node } divert, or a retry.',
        );
      }
      // `retry(n, reason)` carries the ceiling; the IR keeps it on the edge, so
      // it is split off here rather than smuggled inside `otherwise`.
      const carried = (otherwise as { limit?: number }).limit;
      if (carried !== undefined) {
        if (options.limit !== undefined) {
          throw new Error(
            `minflow: ${context} sets a limit twice. retry(${carried}, ...) already ` +
              'carries one. Drop the "limit" option.',
          );
        }
        extras.limit = carried;
      }
      // The reason is what the retried node is handed to act on, so an empty one
      // sends the step back with nothing said about why it is running again.
      extras.otherwise = {
        kind: "retry",
        reason: requireText(otherwise.reason, `${context} otherwise retry`, "reason"),
      };
    }

    // Checked here rather than only in retry(), because a limit reaches an edge
    // by three routes: the option, the ceiling retry() carries, and a hand-built
    // spec carrying one of its own. Only the middle route passes through retry().
    if (extras.limit !== undefined && !isRetryBudget(extras.limit)) {
      throw new Error(
        `minflow: ${context} sets limit ${String(extras.limit)}, which is not a positive whole ` +
          "number of attempts. A ceiling below one attempt makes an edge that reads as bounded " +
          "and can never retry even once: the first failure is already past it, so the run ends " +
          "on the failure the retry exists to absorb.",
      );
    }

    // `limit` is the ceiling on `otherwise: retry` and is read nowhere else, so
    // the two only mean anything together. Apart, each is a graph that looks
    // bounded and is not: a lone limit bounds nothing, and a retry behind a guard
    // that always holds never runs.
    const retries = extras.otherwise?.kind === "retry";
    if (extras.limit !== undefined && !retries) {
      throw new Error(
        `minflow: ${context} sets limit ${extras.limit} with no "otherwise: retry" for it to ` +
          "bound. A limit is consulted only when the guard fails and the edge retries, so " +
          "here it bounds nothing at all. Pass otherwise: retry(" +
          `${extras.limit}, "why") to bound the retries, or drop the limit and guard the edge ` +
          "so it can stop firing.",
      );
    }
    if (retries && isUnconditional(declared)) {
      throw new Error(
        `minflow: ${context} pairs an "otherwise: retry" with a guard that always holds, so ` +
          "the retry can never fire and its limit bounds nothing. Give the edge a guard that " +
          "can fail, or drop the otherwise.",
      );
    }

    this.#emit(from, options.event ?? "pass", resolved, to, extras);
    return this;
  }

  gate(from: NodeId, to: NodeId, options: GateOptions): WorkflowBuilder {
    const context = `gate("${from}", "${to}")`;
    this.#requireNode(from, context);
    if (isEnd(to)) {
      throw new Error(
        `minflow: ${context} gates the transition into END, which cannot be parked. A parked ` +
          "run stores only the node it will resume into, and END is a terminal marker rather " +
          'than a node, so "parked before the end" has no representable state and the run ' +
          "could never be resumed. Add a terminal step and gate the transition into that " +
          "instead.",
      );
    }
    this.#requireTarget(to, context);
    if (options === null || typeof options !== "object" || typeof options.command !== "string") {
      throw new Error(
        `minflow: ${context} needs a { command } naming the resume command a human runs, ` +
          'e.g. { command: "approve-plan" }.',
      );
    }
    this.#emit(from, "pass", when.always(), to, {
      gate: requireText(options.command, `${context} { command }`, "command"),
    });
    return this;
  }

  ask(from: NodeId, to: NodeId, options: AskOptions): WorkflowBuilder {
    const context = `ask("${from}", "${to}")`;
    this.#requireNode(from, context);
    if (isEnd(to)) {
      throw new Error(
        `minflow: ${context} asks on the transition into END. The answers are recorded as a ` +
          "node's output for a later step to read, and there is no later step, so this asks " +
          "the user questions nothing will ever use. Put the ask before the step that needs " +
          "the answers.",
      );
    }
    this.#requireTarget(to, context);
    if (options === null || typeof options !== "object") {
      throw new Error(
        `minflow: ${context} needs a { questions }, either a list written here or ` +
          'askFrom("path") to read them out of the step\'s own output.',
      );
    }

    const as = options.as ?? `${from}-answers`;
    if (this.#nodes.has(as)) {
      throw new Error(
        `minflow: ${context} would record its answers as "${as}", which is already a node in ` +
          "this graph. Its output would be overwritten. Pass a different { as }.",
      );
    }

    const questions = askQuestionsSpec(options.questions, context);
    this.#emit(from, "pass", when.always(), to, { ask: { questions, as } });
    return this;
  }

  branch(from: NodeId, spec: JudgeSpec, routes: Routes): WorkflowBuilder {
    const context = `branch("${from}", ...)`;
    this.#requireNode(from, context);
    if (spec === null || typeof spec !== "object" || spec.kind !== "judge") {
      throw new Error(
        `minflow: ${context} needs a judge("...") spec as its second argument, ` +
          'e.g. branch("review", judge("Any unresolved findings?"), { yes: ..., no: END }).',
      );
    }
    const verdicts = Object.keys(routes);
    if (verdicts.length === 0) {
      throw new Error(
        `minflow: ${context} needs at least one route, e.g. { yes: "implement", no: END }.`,
      );
    }

    for (const [label, target] of Object.entries(routes)) {
      if (label === "") {
        throw new Error(`minflow: ${context} has a route with an empty verdict label.`);
      }
      if (!isEnd(target) && !this.#nodes.has(target)) {
        throw new Error(
          `minflow: ${context} route "${label}" points at unknown node "${target}". ` +
            `Known nodes: ${this.#knownNodes()}. Steps must be declared before they are ` +
            "referenced; use END for a terminal transition.",
        );
      }
      const guard: Guard = {
        kind: "judge",
        question: spec.question,
        is: label,
        verdicts: [...verdicts],
      };
      const withFrom = spec.from === undefined ? guard : { ...guard, from: spec.from };
      this.#emit(from, label, withFrom, target, {});
    }
    return this;
  }

  compile(): Graph {
    const entry = this.#entry;
    if (entry === undefined) {
      throw new Error(
        `minflow: workflow "${this.name}" has no entry. Call .entry(id) before .compile().`,
      );
    }

    const nodes = clone([...this.#nodes.values()]);
    const edges = clone(this.#edges);

    const problems = lintGraph({ entry, nodes, edges });
    if (problems.length > 0) {
      throw new Error(
        `minflow: workflow "${this.name}" does not compile:\n  - ${problems.join("\n  - ")}`,
      );
    }

    const draft = { irVersion: 1 as const, name: this.name, entry, nodes, edges };
    return { ...draft, hash: graphHash(draft) };
  }

  print(): string {
    const lines = [`workflow "${this.name}"`, `entry: ${this.#entry ?? "(unset)"}`];
    for (const node of this.#nodes.values()) {
      const label = isCommandNode(node) ? `$ ${node.command}` : node.skill;
      lines.push("", `${node.id}  [${label}]${describeNodeAttrs(node)}`);
      const outgoing = this.#edges.filter((edge) => edge.from === node.id);
      if (outgoing.length === 0) {
        lines.push("  (no outgoing edges)");
      }
      for (const edge of outgoing) {
        lines.push(
          `  ${edge.id}  --${edge.event}-->  ${edge.goto}  if ${describeGuard(edge.guard)}${describeEdgeAttrs(edge)}`,
        );
      }
    }
    return lines.join("\n");
  }

  #emit(
    from: NodeId,
    event: string,
    guard: Guard,
    goto: NodeId | End,
    extras: { otherwise?: Otherwise; limit?: number; gate?: string; ask?: AskSpec },
  ): void {
    // The ordinal is per source node, so adding a step or an edge somewhere else
    // in the graph cannot renumber this one. Retry counters are keyed by edge id
    // and must survive a recompile of an unchanged graph.
    const ordinal = (this.#counts.get(from) ?? 0) + 1;
    this.#counts.set(from, ordinal);

    const edge: Edge = { id: `${from}:${ordinal}`, from, event, guard, goto };
    if (extras.otherwise !== undefined) edge.otherwise = extras.otherwise;
    if (extras.limit !== undefined) edge.limit = extras.limit;
    if (extras.gate !== undefined) edge.gate = extras.gate;
    if (extras.ask !== undefined) edge.ask = extras.ask;
    this.#edges.push(edge);
  }

  #requireNode(id: string, context: string): void {
    if (!this.#nodes.has(id)) {
      throw new Error(
        `minflow: ${context} references unknown node "${id}". ` +
          `Known nodes: ${this.#knownNodes()}. ` +
          "Steps must be declared before they are referenced.",
      );
    }
  }

  #requireTarget(target: NodeId | End, context: string): void {
    if (isEnd(target)) return;
    if (!this.#nodes.has(target)) {
      throw new Error(
        `minflow: ${context} references unknown node "${target}". ` +
          `Known nodes: ${this.#knownNodes()}. ` +
          "Steps must be declared before they are referenced; use END for a terminal transition.",
      );
    }
  }

  #knownNodes(): string {
    return this.#nodes.size === 0 ? "(none declared yet)" : [...this.#nodes.keys()].join(", ");
  }
}

// ---------------------------------------------------------------------------
// Whole-graph checks
// ---------------------------------------------------------------------------

/** The shape the graph lint needs: a compiled IR, or a draft that has no hash yet. */
export interface LintableGraph {
  entry: NodeId;
  nodes: Node[];
  edges: Edge[];
}

/**
 * Every structural problem with a graph, as human-readable lines.
 *
 * `compile()` runs this and refuses to emit if it returns anything, so a graph
 * built through the builder cannot reach an emitter in a broken state. It is
 * exported because the builder is not the only way to produce an IR: the IR is
 * plain data, a second front-end can hand us one directly, and that graph deserves
 * the same checks. Several of them, an unconditional cycle in particular,
 * describe shapes the builder refuses to author at all, so this is the only
 * place they can still be caught, and the only place they can be tested.
 *
 * One of them has no earlier moment it could run at even for a graph the builder
 * did author: a `{{ctx.node.path}}` reference is legal only when the step it
 * names runs on every route to the reference, which is a property of the whole
 * edge set and unknowable while a single step is being declared.
 *
 * @returns One line per problem, empty when the graph is sound.
 */
export function lintGraph(graph: LintableGraph): string[] {
  const reachable = reachableFrom(graph.entry, graph.edges);
  const missingEntry = entryProblems(graph.nodes, graph.entry);
  return [
    ...missingEntry,
    // Nothing is reachable from an entry that is not a node, so the unreachable
    // line would list the entire graph and say nothing about the entry that
    // stranded it. One true line beats a true list that names the wrong problem.
    ...(missingEntry.length > 0 ? [] : unreachableProblems(graph.nodes, reachable, graph.entry)),
    ...deadEndProblems(graph.nodes, graph.edges, reachable),
    ...unguardedCycleProblems(graph.edges, reachable),
    ...promptProblems(graph),
    ...commandNodeProblems(graph),
    ...askProblems(graph),
  ];
}

/**
 * A command node runs with no model in the loop, so nothing leaving it may ask
 * one a question.
 *
 * The host executes a command node inside its own dispatch, between two of the
 * runner's stops, and decides the transition out of it on the spot. A judge
 * guard needs a round trip through a model to get its verdict, and there is no
 * model to route the question to at that moment. Refused here rather than at run
 * time, where it would present as a run that simply stops.
 */
function askProblems(graph: LintableGraph): string[] {
  const problems: string[] = [];
  const declared = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    const ask = edge.ask;
    if (ask === undefined) continue;
    // The builder cannot author both, so this is here for an IR that came from
    // somewhere else. They mean opposite things about what happens after the
    // human acts, and there is no sensible order to apply them in.
    if (edge.gate !== undefined) {
      problems.push(
        `the edge from "${edge.from}" to "${edge.goto}" both gates and asks. A gate ends the ` +
          "run segment and waits for a typed command; an ask resumes on its own. Pick one.",
      );
    }
    if (declared.has(ask.as)) {
      problems.push(
        `the edge from "${edge.from}" to "${edge.goto}" records its answers as "${ask.as}", ` +
          "which is also a node in this graph, so the answers would overwrite that node's " +
          "output. Give the ask its own id.",
      );
    }
    if (isEnd(edge.goto)) {
      problems.push(
        `the edge from "${edge.from}" asks on the way to END. The answers are recorded for a ` +
          "later step to read and there is no later step, so nothing can ever use them.",
      );
    }
  }
  return problems;
}

function commandNodeProblems(graph: LintableGraph): string[] {
  const commandNodes = new Set(
    graph.nodes.filter((node) => isCommandNode(node)).map((node) => node.id),
  );
  if (commandNodes.size === 0) return [];

  const problems: string[] = [];
  for (const edge of graph.edges) {
    if (!commandNodes.has(edge.from)) continue;
    const question = firstJudgeQuestion(edge.guard);
    if (question === undefined) continue;
    problems.push(
      `the edge from "${edge.from}" to "${edge.goto}" guards on judge("${question}"), but ` +
        `"${edge.from}" is a command node. A command node runs inside the host with no model ` +
        "in the loop, so the verdict can never be obtained. Read the command's own result " +
        'instead, with when.field("exitCode") or when.field("stdout"), or make it a step.',
    );
  }
  return problems;
}

/** The first judge question anywhere in a guard tree, or undefined when there is none. */
function firstJudgeQuestion(guard: Guard): string | undefined {
  if (guard.kind === "judge") return guard.question;
  if (guard.kind === "not") return firstJudgeQuestion(guard.guard);
  if (guard.kind === "all" || guard.kind === "any") {
    for (const inner of guard.guards) {
      const found = firstJudgeQuestion(inner);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The entry has to name a declared node.
 *
 * It is the one id in the graph that no edge has to mention, so nothing else
 * here can catch a typo in it: every other check reads it as the seed of the
 * walk and reports the consequences instead.
 */
function entryProblems(nodes: Node[], entry: NodeId): string[] {
  if (nodes.some((node) => node.id === entry)) return [];
  const known = nodes.length === 0 ? "(none declared)" : nodes.map((node) => node.id).join(", ");
  return [
    `entry "${entry}" is not a node in this graph. Declared nodes: ${known}. ` +
      "A run starts at entry, so it has nowhere to begin.",
  ];
}

/** Edges indexed by the node they leave, for any walk that follows the graph forwards. */
function outgoingByNode(edges: Edge[]): Map<NodeId, Edge[]> {
  const outgoing = new Map<NodeId, Edge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [edge]);
    else list.push(edge);
  }
  return outgoing;
}

/** Nodes the run can actually arrive at, following both `goto` and `otherwise`. */
function reachableFrom(entry: NodeId, edges: Edge[]): Set<NodeId> {
  const outgoing = outgoingByNode(edges);
  const seen = new Set<NodeId>([entry]);
  const queue: NodeId[] = [entry];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === undefined) break;
    for (const edge of outgoing.get(node) ?? []) {
      for (const target of edgeTargets(edge)) {
        if (isEnd(target) || seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

/** Every node an edge can land the run on. A retry stays put, so it adds none. */
function edgeTargets(edge: Edge): (NodeId | End)[] {
  const targets: (NodeId | End)[] = [edge.goto];
  if (edge.otherwise !== undefined && edge.otherwise.kind === "goto") {
    targets.push(edge.otherwise.node);
  }
  return targets;
}

function unreachableProblems(nodes: Node[], reachable: Set<NodeId>, entry: NodeId): string[] {
  const stranded = nodes.filter((node) => !reachable.has(node.id)).map((node) => node.id);
  if (stranded.length === 0) return [];
  return [
    `unreachable nodes: ${stranded.join(", ")}. ` +
      `Every node must be reachable from entry "${entry}".`,
  ];
}

/**
 * A node with no outgoing edge is a dead end: the run arrives and the evaluator
 * has nothing to match, so it stops with an error rather than ending.
 *
 * Only reachable nodes are checked. An unreachable one is already reported as
 * unreachable, and saying it twice buries the useful line. This deliberately
 * does *not* flag a node whose successors all fail to reach END; the provable
 * non-termination case is the unguarded-cycle check below.
 */
function deadEndProblems(nodes: Node[], edges: Edge[], reachable: Set<NodeId>): string[] {
  const hasOutgoing = new Set(edges.map((edge) => edge.from));
  const stuck = nodes
    .filter((node) => reachable.has(node.id) && !hasOutgoing.has(node.id))
    .map((node) => node.id);
  if (stuck.length === 0) return [];
  return [
    `dead-end nodes with no outgoing edge: ${stuck.join(", ")}. ` +
      "Give each one an edge, or route it to END.",
  ];
}

/**
 * True when a guard cannot fail, so an edge carrying it always fires.
 *
 * Strictly more than `kind === "always"`, and deliberately: `when.all()` with no
 * arguments is vacuously true and `when.any(when.always(), …)` fires regardless
 * of its other arms. Both are the same trap wearing a different hat, and the
 * cycle check has to see through the hat.
 */
function isUnconditional(guard: Guard): boolean {
  switch (guard.kind) {
    case "always":
      return true;
    case "all":
      return guard.guards.every(isUnconditional);
    case "any":
      return guard.guards.length > 0 && guard.guards.some(isUnconditional);
    default:
      return false;
  }
}

/**
 * An edge that can fire, will fire, and is bounded by nothing.
 *
 * A gated edge is excluded: it cannot fire without a human running the resume
 * command, so a loop through one is not a machine spinning. It is a machine
 * waiting.
 *
 * **A `limit` never rescues an unconditional edge.** `limit` is consulted on
 * exactly one path: the evaluator increments it when a guard *fails* and
 * `otherwise` is a retry. A guard that cannot fail never reaches that path, so
 * `{ guard: always, otherwise: retry, limit: 3 }` is bounded by nothing at all.
 * It just advances forever. Treating the limit as a ceiling would let that graph
 * compile clean, which is the exact shape this check exists to catch.
 *
 * So an ungated unconditional edge is unbounded, full stop. There is no `limit`
 * term here because there is no shape in which one would be sound.
 */
function isUnbounded(edge: Edge): boolean {
  return edge.gate === undefined && isUnconditional(edge.guard);
}

/**
 * Finds cycles made entirely of unbounded edges and reachable from entry.
 *
 * Such a cycle provably never terminates: every edge in it fires unconditionally
 * and nothing counts the trips, so the run walks it forever. That is a compile
 * error, not a warning.
 *
 * The search is a depth-first walk over the sub-graph of unbounded edges, with
 * the usual white/grey/black colouring: an edge into a grey node is a back edge,
 * and the grey nodes still on the stack from that node down are the cycle. Nodes
 * and edges are visited in declaration order, so the reported cycle is the same
 * on every run.
 */
function unguardedCycleProblems(edges: Edge[], reachable: Set<NodeId>): string[] {
  const outgoing = new Map<NodeId, NodeId[]>();
  const order: NodeId[] = [];
  for (const edge of edges) {
    if (!reachable.has(edge.from) || !isUnbounded(edge) || isEnd(edge.goto)) continue;
    if (!reachable.has(edge.goto)) continue;
    const list = outgoing.get(edge.from);
    if (list === undefined) {
      outgoing.set(edge.from, [edge.goto]);
      order.push(edge.from);
    } else {
      list.push(edge.goto);
    }
  }

  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<NodeId, number>();
  const stack: NodeId[] = [];
  const cycles: string[] = [];
  const reported = new Set<string>();

  const visit = (node: NodeId): void => {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const seen = colour.get(next);
      if (seen === GREY) {
        const start = stack.indexOf(next);
        const path = [...stack.slice(start), next];
        const key = path.join(" -> ");
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(key);
        }
      } else if (seen === undefined) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of order) {
    if (colour.get(node) === undefined) visit(node);
  }

  return cycles.map(
    (cycle) =>
      `unguarded cycle: ${cycle}. Every edge in it fires unconditionally with no limit, ` +
      "so the graph cannot terminate. Guard one of those edges, give it a limit, or gate it.",
  );
}

/**
 * Every prompt placeholder that will not be substituted when the run reaches it.
 *
 * Two of the faults are local to a node and are already refused at `step()`.
 * They are checked again here because the IR is plain data and a second
 * front-end can hand us a graph the builder never saw.
 *
 * The third is why this check exists at all. `{{ctx.node.path}}` reads an
 * earlier step's payload, so it resolves only if that step has certainly run,
 * which means the step has to **dominate** the referencing node: every route
 * from entry to the reference passes through it. Anything weaker is a template
 * that resolves on one route and not another, which the author cannot see while
 * writing it and the run discovers only on the route that skipped.
 */
function promptProblems(graph: LintableGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const problems: string[] = [];
  for (const node of graph.nodes) {
    const subject = `node "${node.id}"`;
    const params = node.params ?? {};
    // Checked whether or not the node has a prompt, and before it: a param
    // carrying a template is the one route by which a reference reaches a run
    // without appearing in `node.prompt` at all.
    problems.push(...paramProblems(subject, params));
    // A command node interpolates its command exactly as a step interpolates its
    // prompt, so both go through one check and a command node gets the same
    // dominance guarantee rather than a weaker one.
    const template = templateOf(node);
    if (template === undefined) continue;
    for (const placeholder of parsePrompt(template)) {
      if (placeholder.kind === "invalid") {
        problems.push(unreadablePrompt(subject, placeholder));
      } else if (placeholder.kind === "params") {
        if (!Object.hasOwn(params, placeholder.key)) {
          problems.push(unknownParam(subject, placeholder.text, params));
        }
      } else {
        const problem = ctxProblem(graph, byId, node.id, placeholder);
        if (problem !== undefined) problems.push(problem);
      }
    }
  }
  // One prompt can carry the same placeholder twice, and the second line would
  // repeat the first word for word.
  return [...new Set(problems)];
}

/** Why a `ctx` reference cannot be honoured, or undefined when it can be. */
function ctxProblem(
  graph: LintableGraph,
  byId: Map<NodeId, Node>,
  reader: NodeId,
  placeholder: { node: NodeId; path: string; text: string },
): string | undefined {
  const subject = `node "${reader}"`;
  const producer = placeholder.node;

  if (producer === reader) {
    return (
      `${subject} reads ${placeholder.text}, which is its own output. A step's payload ` +
      "exists only once that step has finished, so a ctx reference has to name an earlier step."
    );
  }
  const asked = asksById(graph).get(producer);
  if (asked !== undefined) return askCtxProblem(graph, asked, reader, placeholder);

  const declared = byId.get(producer);
  if (declared === undefined) {
    const asks = [...asksById(graph).keys()];
    const alsoAsks = asks.length === 0 ? "" : `. Answers recorded by asks: ${asks.join(", ")}`;
    return (
      `${subject} reads ${placeholder.text}, but "${producer}" is not a node in this ` +
      `graph. Declared nodes: ${[...byId.keys()].join(", ")}${alsoAsks}.`
    );
  }

  // A command node's payload shape is fixed by the runtime rather than declared
  // by the author, so the reference is checkable exactly and needs no schema.
  if (isCommandNode(declared)) {
    const [head] = placeholder.path.split(".");
    if (head !== undefined && !COMMAND_OUTPUT_KEYS.includes(head)) {
      return (
        `${subject} template reads ${placeholder.text}, but "${producer}" is a command node, ` +
        `whose output is exactly: ${COMMAND_OUTPUT_KEYS.join(", ")}.`
      );
    }
    return undefined;
  }

  // Dominance answers whether the producer ran, which is a weaker thing than
  // whether it recorded anything. A step declaring no output contract promises
  // no payload, and a guard that reads no payload lane leaves it having recorded
  // none, so the reference resolves to a run-time failure on a graph that
  // compiled clean.
  if (declared.schema === undefined) {
    return (
      `${subject} reads ${placeholder.text}, but "${producer}" declares no output. ` +
      "Running is not producing: a step with no schema promises no payload, so nothing obliges " +
      "it to record one and the reference has nothing to read. Declare what " +
      `"${producer}" produces, with output or with schema.`
    );
  }

  // Only the first segment, and only against a schema that names properties. A
  // declared property may hold any shape, so a deeper segment is unusual rather
  // than provably wrong, and this refuses what the schema says cannot be there
  // rather than guessing at the rest.
  const properties = declaredProperties(declared.schema);
  const [head] = placeholder.path.split(".");
  if (properties !== undefined && head !== undefined && !properties.includes(head)) {
    return (
      `${subject} reads ${placeholder.text}, but "${producer}" declares no "${head}" in ` +
      `its output. It declares: ${properties.join(", ")}. A ctx reference reads a path out of ` +
      "the producer's payload, and only what its schema names is promised to be there."
    );
  }

  const detour = routeAvoiding(graph, reader, producer);
  if (detour === undefined) return undefined;
  return (
    `${subject} reads ${placeholder.text}, but "${producer}" does not run on every route ` +
    `to "${reader}": ${detour.join(" -> ")} reaches "${reader}" without passing through ` +
    `"${producer}", so on that route there is nothing to interpolate. Read the value from a step ` +
    `every route passes through, or make "${producer}" one of them.`
  );
}

/**
 * The property names a producer's schema declares, or undefined when it names
 * none.
 *
 * Only an object schema carrying a `properties` object says what a payload
 * holds. A `$ref`, a composition, or a bare `{ "type": "object" }` promises a
 * payload without naming its fields, and an empty `properties` names none
 * either, so in all of those there is nothing a path can be checked against.
 */
function declaredProperties(schema: JsonValue): string[] | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = schema.properties;
  if (
    properties === undefined ||
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return undefined;
  }
  const names = Object.keys(properties);
  return names.length === 0 ? undefined : names;
}

/**
 * A route from entry to `target` that never passes through `avoid`, or undefined
 * when there is none.
 *
 * This is the dominance test itself rather than an approximation of it: `avoid`
 * dominates `target` exactly when deleting `avoid` disconnects `target` from
 * entry, since a surviving route is by definition a route that reaches the
 * target without it. Running the test as a breadth-first walk makes the witness
 * the same object as the answer, and the shortest such witness, so the error can
 * show the route rather than assert a property of the graph the reader has to
 * verify by hand.
 *
 * Cycles cost nothing. The walk marks a node the first time it is queued and
 * never enters it twice, so a retry loop is traversed once like any other edge,
 * and the parent links it leaves behind form a tree rather than a cycle.
 *
 * A target entry cannot reach at all has no route with or without `avoid`, so an
 * unreachable node's `ctx` references say nothing here. They are covered by the
 * unreachable check, which names the fault that actually stranded them.
 */
function routeAvoiding(graph: LintableGraph, target: NodeId, avoid: NodeId): NodeId[] | undefined {
  // Entry is on every route by construction, so nothing can route around it.
  if (graph.entry === avoid) return undefined;

  const outgoing = outgoingByNode(graph.edges);
  const cameFrom = new Map<NodeId, NodeId>();
  const queue: NodeId[] = [graph.entry];
  const seen = new Set<NodeId>(queue);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) break;
    if (node === target) return routeTo(cameFrom, node);
    for (const edge of outgoing.get(node) ?? []) {
      for (const next of edgeTargets(edge)) {
        if (isEnd(next) || next === avoid || seen.has(next)) continue;
        seen.add(next);
        cameFrom.set(next, node);
        queue.push(next);
      }
    }
  }
  return undefined;
}

/**
 * A route from entry to `target` that never traverses the edge `avoid`, or
 * undefined when every route uses it.
 *
 * The edge-shaped twin of {@link routeAvoiding}, and it exists because an ask's
 * answers are produced by an *edge* rather than by a node. Deleting the asking
 * node would be too strong: other edges may leave it and reach the reader
 * perfectly well without ever raising the ask.
 */
function routeAvoidingEdge(
  graph: LintableGraph,
  target: NodeId,
  avoid: string,
): NodeId[] | undefined {
  const outgoing = outgoingByNode(graph.edges);
  const cameFrom = new Map<NodeId, NodeId>();
  const queue: NodeId[] = [graph.entry];
  const seen = new Set<NodeId>(queue);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) break;
    if (node === target) return routeTo(cameFrom, node);
    for (const edge of outgoing.get(node) ?? []) {
      if (edge.id === avoid) continue;
      for (const next of edgeTargets(edge)) {
        if (isEnd(next) || seen.has(next)) continue;
        seen.add(next);
        cameFrom.set(next, node);
        queue.push(next);
      }
    }
  }
  return undefined;
}

/** Every ask in the graph, indexed by the id its answers are recorded under. */
function asksById(graph: LintableGraph): Map<NodeId, Edge> {
  const asks = new Map<NodeId, Edge>();
  for (const edge of graph.edges) {
    if (edge.ask !== undefined) asks.set(edge.ask.as, edge);
  }
  return asks;
}

/**
 * Why a `ctx` reference into an ask's answers cannot be honoured.
 *
 * Two checks, mirroring the two a reference into a step gets. The answers exist
 * only if the ask certainly happened, which is edge dominance rather than node
 * dominance. And when the questions are written into the graph their headers are
 * known, so a reference to a header nobody asked about is a compile error in
 * exactly the way a reference to an undeclared schema property is.
 */
function askCtxProblem(
  graph: LintableGraph,
  edge: Edge,
  reader: NodeId,
  placeholder: { node: NodeId; path: string; text: string },
): string | undefined {
  const subject = `node "${reader}"`;
  const detour = routeAvoidingEdge(graph, reader, edge.id);
  if (detour !== undefined) {
    return (
      `${subject} reads ${placeholder.text}, but the ask that records "${placeholder.node}" ` +
      `does not happen on every route to "${reader}". This route reaches it without asking: ` +
      `${detour.join(" -> ")}. The answers would be missing there.`
    );
  }

  const questions = edge.ask?.questions;
  if (questions === undefined || questions.kind !== "static") return undefined;
  const headers = questions.items.map((item) => item.header);
  const [head] = placeholder.path.split(".");
  if (head !== undefined && !headers.includes(head)) {
    return (
      `${subject} reads ${placeholder.text}, but that ask puts no question with the header ` +
      `"${head}". It asks: ${headers.join(", ")}. Answers are recorded under each question's ` +
      "header."
    );
  }
  return undefined;
}

/** Follows the walk's parent links back to entry, then reads them forwards. */
function routeTo(cameFrom: Map<NodeId, NodeId>, target: NodeId): NodeId[] {
  const route = [target];
  for (let node = cameFrom.get(target); node !== undefined; node = cameFrom.get(node)) {
    route.push(node);
  }
  return route.reverse();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compiles the `output` shorthand into a JSON Schema object. */
function outputToSchema(stepId: NodeId, output: OutputSpec): JsonValue {
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  for (const [field, type] of Object.entries(output)) {
    properties[field] = fieldSchema(stepId, field, type);
    required.push(field);
  }
  // Every declared field is required and nothing else is allowed: the point of
  // the shorthand is a contract the step either meets or visibly breaks.
  return { type: "object", properties, required, additionalProperties: false };
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

function fieldSchema(stepId: NodeId, field: string, type: string): JsonValue {
  const isArray = typeof type === "string" && type.endsWith("[]");
  const scalar = isArray ? type.slice(0, -2) : type;
  if (typeof type !== "string" || !SCALAR_TYPES.has(scalar)) {
    throw new Error(
      `minflow: step("${stepId}") output field "${field}" has unsupported type ` +
        `"${String(type)}". Supported: string, number, integer, boolean and their [] forms ` +
        '(e.g. "string[]"). Use "schema" for anything richer.',
    );
  }
  return isArray ? { type: "array", items: { type: scalar } } : { type: scalar };
}

/**
 * Applies an edge's payload lane as the default for every guard in its tree that
 * did not name one. Guards that read no payload are left alone.
 */
function withLane(guard: Guard, lane: PayloadSource): Guard {
  switch (guard.kind) {
    case "field":
      return guard.from === undefined ? { ...guard, from: lane } : guard;
    case "judge":
      return guard.from === undefined ? { ...guard, from: lane } : guard;
    case "not":
      return { kind: "not", guard: withLane(guard.guard, lane) };
    case "all":
      return { kind: "all", guards: guard.guards.map((inner) => withLane(inner, lane)) };
    case "any":
      return { kind: "any", guards: guard.guards.map((inner) => withLane(inner, lane)) };
    default:
      return guard;
  }
}

function assertGuard(value: Guard, context: string, index?: number): void {
  const where = index === undefined ? context : `${context} argument ${index + 1}`;
  const candidate: unknown = value;
  const isObject = candidate !== null && typeof candidate === "object";
  const kind = isObject ? (candidate as { kind?: unknown }).kind : undefined;
  // A judge() spec wears the same `kind` as a finished judge guard but has no
  // verdict, so it would slip through the kind check and compile into a guard the
  // evaluator can never satisfy.
  const unfinishedJudge =
    kind === "judge" && typeof (candidate as { is?: unknown }).is !== "string";
  if (isObject && !unfinishedJudge && GUARD_KINDS.has(String(kind))) {
    assertArms(value, where);
    return;
  }
  const unfinishedField =
    isObject && typeof (candidate as { truthy?: unknown }).truthy === "function";
  let detail: string;
  if (unfinishedJudge) {
    detail =
      'it is a judge("...") that never named a verdict. Finish it with .is("yes"), or hand ' +
      "it to branch(), which names one per route";
  } else if (unfinishedField) {
    detail =
      "it is a when.field(...) that was never compared. Finish it with .truthy(), .equals(v), " +
      ".matches(re), .gt(n) or .lt(n)";
  } else {
    detail = `got ${describeValue(candidate)}`;
  }
  throw new Error(`minflow: ${where} was given something that is not a guard: ${detail}.`);
}

/**
 * A composite is only as sound as its arms, so the check descends into them.
 *
 * `when.all`, `when.any` and `when.not` check what they are handed as they build
 * it, but a composite written as raw IR data reaches an edge without passing
 * through any of them. The evaluator switches on `kind` with no arm for anything
 * else, so a bad sub-guard is not a route that never fires: it is a transition
 * that throws mid-run, long after the line that wrote it.
 */
function assertArms(guard: Guard, where: string): void {
  if (guard.kind === "not") {
    assertGuard(guard.guard, `${where} inside not()`);
    return;
  }
  if (guard.kind !== "all" && guard.kind !== "any") return;
  const arms: unknown = guard.guards;
  if (!Array.isArray(arms)) {
    throw new Error(
      `minflow: ${where} was given a guard of kind "${guard.kind}" whose guards is not an ` +
        `array: got ${describeValue(arms)}. Build it with when.${guard.kind}(...), ` +
        "which always has one.",
    );
  }
  for (const [position, arm] of arms.entries()) {
    assertGuard(arm as Guard, `${where} inside ${guard.kind}()`, position);
  }
}

function describeValue(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const kind = (value as { kind?: unknown }).kind;
  return kind === undefined ? "an object with no guard kind" : `kind "${String(kind)}"`;
}

/** Rejects the empty string and non-strings, which are always a mistake. */
function requireText(value: string, context: string, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`minflow: ${context} needs a non-empty ${field}.`);
  }
  return value;
}

/** Fresh JSON-only copies, so a compiled graph cannot be mutated through the builder. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// print()
// ---------------------------------------------------------------------------

function describeNodeAttrs(node: Node): string {
  const parts: string[] = [];
  if (isCommandNode(node)) {
    if (node.phase !== undefined) parts.push(`phase=${node.phase}`);
    if (node.timeoutMs !== undefined) parts.push(`timeoutMs=${node.timeoutMs}`);
    return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
  }
  if (node.model !== undefined) parts.push(`model=${node.model}`);
  if (node.maxTurns !== undefined) parts.push(`maxTurns=${node.maxTurns}`);
  if (node.phase !== undefined) parts.push(`phase=${node.phase}`);
  if (node.tools !== undefined) parts.push(`tools=${node.tools.join("|")}`);
  if (node.schema !== undefined) parts.push("schema");
  return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
}

function describeEdgeAttrs(edge: Edge): string {
  const parts: string[] = [];
  if (edge.otherwise !== undefined) {
    parts.push(
      edge.otherwise.kind === "retry"
        ? `else retry("${edge.otherwise.reason}"${edge.limit === undefined ? "" : `, limit ${edge.limit}`})`
        : `else goto ${edge.otherwise.node}`,
    );
  } else if (edge.limit !== undefined) {
    parts.push(`limit ${edge.limit}`);
  }
  if (edge.gate !== undefined) parts.push(`[gate: ${edge.gate}]`);
  return parts.length === 0 ? "" : `  ${parts.join("  ")}`;
}

function describeGuard(guard: Guard): string {
  switch (guard.kind) {
    case "always":
      return "always";
    case "fileExists":
      return `fileExists("${guard.path}")`;
    case "exitZero":
      return `exitZero("${guard.command}")`;
    case "field":
      return `field(${guard.path}) ${describeFieldOp(guard.op, guard.value)}${describeLane(guard.from)}`;
    case "judge":
      return `judge("${guard.question}") is "${guard.is}"${describeLane(guard.from)}`;
    case "not":
      return `not(${describeGuard(guard.guard)})`;
    case "all":
      return `all(${guard.guards.map(describeGuard).join(", ")})`;
    case "any":
      return `any(${guard.guards.map(describeGuard).join(", ")})`;
  }
}

function describeFieldOp(op: FieldOp, value: JsonValue | undefined): string {
  const rendered = JSON.stringify(value ?? null);
  switch (op) {
    case "truthy":
      return "is truthy";
    case "equals":
      return `== ${rendered}`;
    case "notEquals":
      return `!= ${rendered}`;
    case "matches":
      return `matches ${rendered}`;
    case "gt":
      return `> ${rendered}`;
    case "lt":
      return `< ${rendered}`;
  }
}

function describeLane(from: PayloadSource | undefined): string {
  if (from === undefined) return "";
  return from.lane === "file" ? ` from file(${from.path})` : " from inline";
}

/**
 * A timeout counts elapsed milliseconds, so it has to admit at least one.
 *
 * Zero, a negative, or a fraction below one produces a command the host kills
 * before it can report anything, so every run fails on the ceiling rather than
 * on what the command actually found.
 */
function isPositiveMilliseconds(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}
