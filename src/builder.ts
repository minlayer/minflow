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
  End,
  FieldOp,
  Guard,
  IrEdge,
  IrNode,
  JsonValue,
  NodeId,
  Otherwise,
  PayloadSource,
  WorkflowIr,
} from "./ir.js";
import { isEnd } from "./ir.js";

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
   * when a guard fails and the edge's `otherwise` is a retry (see `IrEdge.limit`
   * in the IR). Setting it on an edge with no retry is therefore rejected rather
   * than accepted as a loop ceiling it cannot be.
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
  /** Adds one judged transition per route, all sharing one question. */
  branch(from: NodeId, spec: JudgeSpec, routes: Routes): WorkflowBuilder;
  /** Runs the whole-graph checks and returns the IR. Throws if anything fails. */
  compile(): WorkflowIr;
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
 * Re-run the current node, up to `limit` attempts, handing it `reason`.
 *
 * Pass it as `otherwise`. The builder splits it: the reason goes into
 * `edge.otherwise`, the limit onto `edge.limit`, which is where the IR keeps it
 * because retry counters are keyed by edge id.
 */
export function retry(limit: number, reason: string): RetrySpec {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `minflow: retry(${String(limit)}, ...) needs a positive whole number of attempts.`,
    );
  }
  return { kind: "retry", reason: requireText(reason, 'retry(n, "...")', "reason"), limit };
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
  readonly #nodes = new Map<NodeId, IrNode>();
  readonly #edges: IrEdge[] = [];
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

    const node: IrNode = { id: at, skill };
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
      extras.otherwise = { kind: "retry", reason: otherwise.reason };
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

  compile(): WorkflowIr {
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
      lines.push("", `${node.id}  [${node.skill}]${describeNodeAttrs(node)}`);
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
    extras: { otherwise?: Otherwise; limit?: number; gate?: string },
  ): void {
    // The ordinal is per source node, so adding a step or an edge somewhere else
    // in the graph cannot renumber this one. Retry counters are keyed by edge id
    // and must survive a recompile of an unchanged graph.
    const ordinal = (this.#counts.get(from) ?? 0) + 1;
    this.#counts.set(from, ordinal);

    const edge: IrEdge = { id: `${from}:${ordinal}`, from, event, guard, goto };
    if (extras.otherwise !== undefined) edge.otherwise = extras.otherwise;
    if (extras.limit !== undefined) edge.limit = extras.limit;
    if (extras.gate !== undefined) edge.gate = extras.gate;
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

/** Nodes the run can actually arrive at, following both `goto` and `otherwise`. */
/** The shape the graph lint needs: a compiled IR, or a draft that has no hash yet. */
export interface LintableGraph {
  entry: NodeId;
  nodes: IrNode[];
  edges: IrEdge[];
}

/**
 * Every structural problem with a graph, as human-readable lines.
 *
 * `compile()` runs this and refuses to emit if it returns anything, so a graph
 * built through the builder cannot reach an emitter in a broken state. It is
 * exported because the builder is not the only way to produce an IR: the IR is
 * plain data, a second front-end can hand us one directly, and that graph deserves
 * the same three checks. Several of them, an unconditional cycle in particular,
 * describe shapes the builder now refuses to author at all, so this is the only
 * place they can still be caught, and the only place they can be tested.
 *
 * @returns One line per problem, empty when the graph is sound.
 */
export function lintGraph(graph: LintableGraph): string[] {
  const reachable = reachableFrom(graph.entry, graph.edges);
  return [
    ...unreachableProblems(graph.nodes, reachable, graph.entry),
    ...deadEndProblems(graph.nodes, graph.edges, reachable),
    ...unguardedCycleProblems(graph.edges, reachable),
  ];
}

function reachableFrom(entry: NodeId, edges: IrEdge[]): Set<NodeId> {
  const outgoing = new Map<NodeId, IrEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [edge]);
    else list.push(edge);
  }

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
function edgeTargets(edge: IrEdge): (NodeId | End)[] {
  const targets: (NodeId | End)[] = [edge.goto];
  if (edge.otherwise !== undefined && edge.otherwise.kind === "goto") {
    targets.push(edge.otherwise.node);
  }
  return targets;
}

function unreachableProblems(nodes: IrNode[], reachable: Set<NodeId>, entry: NodeId): string[] {
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
function deadEndProblems(nodes: IrNode[], edges: IrEdge[], reachable: Set<NodeId>): string[] {
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
 * **A `limit` never rescues an unconditional edge, and an earlier version of this
 * function believed it did.** `limit` is consulted on exactly one path: the
 * evaluator increments it when a guard *fails* and `otherwise` is a retry. A guard
 * that cannot fail never reaches that path, so `{ guard: always, otherwise: retry,
 * limit: 3 }` is bounded by nothing at all. It just advances forever. Treating
 * the limit as a ceiling let that graph compile clean, which was the exact bug
 * this check exists to catch, wearing the costume of the fix.
 *
 * So an ungated unconditional edge is unbounded, full stop. There is no `limit`
 * term here because there is no shape in which one would be sound.
 */
function isUnbounded(edge: IrEdge): boolean {
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
function unguardedCycleProblems(edges: IrEdge[], reachable: Set<NodeId>): string[] {
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

function describeNodeAttrs(node: IrNode): string {
  const parts: string[] = [];
  if (node.model !== undefined) parts.push(`model=${node.model}`);
  if (node.maxTurns !== undefined) parts.push(`maxTurns=${node.maxTurns}`);
  if (node.phase !== undefined) parts.push(`phase=${node.phase}`);
  if (node.tools !== undefined) parts.push(`tools=${node.tools.join("|")}`);
  if (node.schema !== undefined) parts.push("schema");
  return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
}

function describeEdgeAttrs(edge: IrEdge): string {
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
