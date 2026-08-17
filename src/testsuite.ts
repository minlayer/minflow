/**
 * Deterministic test generation from a compiled graph.
 *
 * A compiled graph is a control-flow graph, so the standard structural coverage
 * argument applies. Node coverage is already static: `lintGraph` reports
 * unreachable nodes, dead ends and non-terminating cycles at compile time. This
 * aims at the next criterion up, the one normally called branch coverage, which
 * is the first that requires execution.
 *
 * **Why generation is possible here at all.** Automatic test generation over a
 * control-flow graph normally stalls on path feasibility: forcing a branch means
 * solving an arbitrary predicate, which is why coverage tools report uncovered
 * branches rather than generating inputs for them. minflow's guards are data
 * rather than code, so every kind is invertible by inspection and the inputs
 * that force a branch are derivable.
 *
 * **The unit of coverage is an outcome, not an edge.** One `Edge` is several
 * distinguishable decisions: its guard holding, its `otherwise` being taken, and
 * that retry running out. They have different preconditions and different
 * results, so counting edges would report full coverage on a graph whose retry
 * paths were never once taken.
 *
 * Generation is pure and writes nothing. It reads the IR and returns a plan.
 *
 * @packageDocumentation
 */

import RandExp from "randexp";

import { observationKey } from "./evaluate.js";
import { canonicalize } from "./hash.js";
import type {
  AskQuestion,
  Edge,
  Graph,
  Guard,
  JsonValue,
  NodeId,
  ObservationResult,
  PayloadSource,
} from "./ir.js";
import { DEFAULT_PAYLOAD_SOURCE, isCommandNode, isEnd, templateOf } from "./ir.js";

/** What a single decision in a run can turn out to be. */
export type OutcomeKind =
  /** The edge's guard held and it was the first to do so. */
  | "fire"
  /** No guard held, and this is the first edge declaring an `otherwise`. */
  | "otherwise"
  /** That `otherwise` is a retry, and it ran past its ceiling. */
  | "exhaust"
  /** No guard held and no edge out of the node declares an `otherwise`. */
  | "nomatch";

/**
 * One coverable decision.
 *
 * `nomatch` belongs to a node rather than an edge, since it is what happens when
 * every edge out of that node declined.
 */
export interface Outcome {
  /** Stable identity, e.g. `research:1/fire` or `review/nomatch`. */
  id: string;
  kind: OutcomeKind;
  /** The node the decision is made at. */
  from: NodeId;
  /** The edge it belongs to, absent for `nomatch`. */
  edge?: string;
  /** Where the run goes, when the outcome is not an error. */
  to?: NodeId | End;
  /** Why this can never happen, when it never can. */
  infeasible?: string;
}

type End = "__end__";

/** A resolved observation set, keyed as the evaluator keys them. */
export type Observations = Record<string, ObservationResult>;

/** One decision inside a case: what the host answers, and what should follow. */
export interface TestStep {
  /** The node the run is at. */
  node: NodeId;
  /** The outcome this step is arranged to produce. */
  outcome: string;
  /** Everything `observationsFor` will ask for, answered. */
  observations: Observations;
  /**
   * What this step answers, when the transition out of it asks the user.
   *
   * Written into the plan rather than decided while running, so the file says
   * what will be answered and a reader can disagree with it.
   */
  answers?: Record<string, string>;
}

/** One generated run. */
export interface TestCase {
  id: string;
  /** Outcome ids this case covers, in order. */
  covers: string[];
  steps: TestStep[];
  /** The node sequence the graph says this case should visit. */
  walk: NodeId[];
  /** How the run should finish. */
  ends: "end" | "gate" | "error";
}

/** An outcome nothing could cover, and the reason. */
export interface Uncovered {
  outcome: string;
  reason: string;
}

/** The written artifact. Readable on purpose: it is what will be run. */
export interface TestSuite {
  /** Bumped when the plan's own shape changes. */
  planVersion: 1;
  workflow: string;
  /** The graph this was generated against. A plan is refused if it moved. */
  graphHash: string;
  /** Seeds the one thing that needs randomness, string generation for `matches`. */
  seed: number;
  cases: TestCase[];
  coverage: {
    total: number;
    covered: number;
    /** Outcomes no case reached, each with why. */
    uncovered: Uncovered[];
  };
}

/** Options for {@link generateSuite}. */
export interface SuiteOptions {
  /** Seeds string generation. Same seed, same plan. */
  seed?: number;
  /** Ceiling on generated cases, so a pathological graph cannot run away. */
  maxCases?: number;
}

const DEFAULT_SEED = 1;
const DEFAULT_MAX_CASES = 200;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Edges leaving a node, in declaration order, which is the order they are tried. */
function siblingsOf(graph: Graph, node: NodeId): Edge[] {
  return graph.edges.filter((edge) => edge.from === node);
}

/**
 * Every decision the graph can make, feasible or not.
 *
 * Infeasibility is decided here rather than discovered by failing to cover
 * something, because the two are different reports. An outcome that *cannot*
 * happen is a fact about the graph; an outcome the generator merely failed to
 * reach is a fact about the generator.
 */
export function outcomesOf(graph: Graph): Outcome[] {
  const outcomes: Outcome[] = [];

  for (const node of graph.nodes) {
    const siblings = siblingsOf(graph, node.id);

    // An unconditional guard ends the search: no edge after it is ever tried,
    // and the otherwise pass is only reached when every guard failed, which one
    // of these cannot do.
    const unconditional = siblings.findIndex((edge) => isUnconditional(edge.guard));
    const shadowedFrom = unconditional === -1 ? siblings.length : unconditional + 1;

    // The otherwise pass takes the first edge declaring one, whichever failed,
    // so a later edge's otherwise is unreachable however its own guard behaves.
    const firstOtherwise = siblings.findIndex((edge) => edge.otherwise !== undefined);

    for (const [index, edge] of siblings.entries()) {
      const fire: Outcome = { id: `${edge.id}/fire`, kind: "fire", from: node.id, edge: edge.id };
      if (edge.goto !== undefined) fire.to = edge.goto;
      if (index >= shadowedFrom) {
        fire.infeasible =
          `edge ${siblings[unconditional]?.id} out of "${node.id}" is unconditional, so no ` +
          "later edge is ever tried";
      }
      outcomes.push(fire);

      const otherwise = edge.otherwise;
      if (otherwise === undefined) continue;

      const kind: OutcomeKind = otherwise.kind === "retry" ? "otherwise" : "otherwise";
      const entry: Outcome = {
        id: `${edge.id}/otherwise`,
        kind,
        from: node.id,
        edge: edge.id,
      };
      if (otherwise.kind === "goto") entry.to = otherwise.node;
      else entry.to = node.id;

      if (unconditional !== -1) {
        entry.infeasible =
          `edge ${siblings[unconditional]?.id} out of "${node.id}" is unconditional, so no ` +
          "guard at this node can fail and the otherwise pass is never reached";
      } else if (index !== firstOtherwise) {
        entry.infeasible =
          `edge ${siblings[firstOtherwise]?.id} declares an otherwise first, and the first one ` +
          "wins whichever edge failed";
      }
      outcomes.push(entry);

      if (otherwise.kind !== "retry") continue;
      const exhaust: Outcome = {
        id: `${edge.id}/exhaust`,
        kind: "exhaust",
        from: node.id,
        edge: edge.id,
      };
      if (entry.infeasible !== undefined) exhaust.infeasible = entry.infeasible;
      else if (edge.limit === undefined) {
        exhaust.infeasible =
          `edge ${edge.id} retries with no ceiling, so it never exhausts. lintGraph reports ` +
          "this separately as a cycle that cannot terminate";
      }
      outcomes.push(exhaust);
    }

    // A node whose edges can all fail with nothing to catch them.
    if (siblings.length > 0 && firstOtherwise === -1) {
      const nomatch: Outcome = { id: `${node.id}/nomatch`, kind: "nomatch", from: node.id };
      if (unconditional !== -1) {
        nomatch.infeasible =
          `edge ${siblings[unconditional]?.id} out of "${node.id}" is unconditional, so this ` +
          "node always routes somewhere";
      }
      outcomes.push(nomatch);
    }
  }

  return outcomes;
}

/** Whether a guard holds no matter what, which is what shadows later edges. */
function isUnconditional(guard: Guard): boolean {
  if (guard.kind === "always") return true;
  // An empty conjunction is vacuously true, per the IR.
  if (guard.kind === "all") return guard.guards.length === 0 || guard.guards.every(isUnconditional);
  if (guard.kind === "not") return isNever(guard.guard);
  return false;
}

/** Whether a guard can never hold, which is the mirror image. */
function isNever(guard: Guard): boolean {
  // An empty disjunction is vacuously false, per the IR.
  if (guard.kind === "any") return guard.guards.length === 0 || guard.guards.every(isNever);
  if (guard.kind === "not") return isUnconditional(guard.guard);
  return false;
}

// ---------------------------------------------------------------------------
// Forcing a guard
// ---------------------------------------------------------------------------

/** A leaf guard and the truth value it has to take. */
interface Requirement {
  guard: Extract<Guard, { kind: "exitZero" | "fileExists" | "field" | "judge" }>;
  holds: boolean;
}

/** The assignment being built, before it becomes observations. */
interface Assignment {
  /** Boolean keys: exitZero and fileExists. */
  flags: Map<string, boolean>;
  /** Judge keys, holding the verdict the model is taken to have returned. */
  verdicts: Map<string, string>;
  /** Payload keys, each a dot path to the value it must hold. */
  payloads: Map<string, Map<string, JsonValue>>;
  /** Payload keys that were touched, so a payload is emitted even when empty. */
  touched: Set<string>;
}

function emptyAssignment(): Assignment {
  return { flags: new Map(), verdicts: new Map(), payloads: new Map(), touched: new Set() };
}

function cloneAssignment(from: Assignment): Assignment {
  return {
    flags: new Map(from.flags),
    verdicts: new Map(from.verdicts),
    payloads: new Map([...from.payloads].map(([key, paths]) => [key, new Map(paths)])),
    touched: new Set(from.touched),
  };
}

/** Every leaf under a guard tree, flattened. */
function leavesOf(guard: Guard, into: Requirement["guard"][] = []): Requirement["guard"][] {
  switch (guard.kind) {
    case "always":
      return into;
    case "not":
      return leavesOf(guard.guard, into);
    case "all":
    case "any": {
      for (const inner of guard.guards) leavesOf(inner, into);
      return into;
    }
    default:
      into.push(guard);
      return into;
  }
}

/**
 * Whether a guard tree evaluates to `want` under an assignment of its leaves.
 *
 * The truth table is the evaluator's, restated over booleans rather than over
 * observations, which is what lets the search decide a whole tree without
 * building the observations first.
 */
function holdsUnder(guard: Guard, truth: Map<Requirement["guard"], boolean>): boolean {
  switch (guard.kind) {
    case "always":
      return true;
    case "not":
      return !holdsUnder(guard.guard, truth);
    case "all":
      return guard.guards.every((inner) => holdsUnder(inner, truth));
    case "any":
      return guard.guards.some((inner) => holdsUnder(inner, truth));
    default:
      return truth.get(guard) === true;
  }
}

/** The observation key a leaf reads. */
function keyOf(guard: Requirement["guard"]): string {
  switch (guard.kind) {
    case "exitZero":
      return observationKey({ kind: "exitZero", command: guard.command });
    case "fileExists":
      return observationKey({ kind: "fileExists", path: guard.path });
    case "field":
      return observationKey({ kind: "payload", from: guard.from ?? DEFAULT_PAYLOAD_SOURCE });
    case "judge":
      return guard.verdicts === undefined
        ? observationKey({
            kind: "judge",
            question: guard.question,
            from: guard.from ?? DEFAULT_PAYLOAD_SOURCE,
          })
        : observationKey({
            kind: "judge",
            question: guard.question,
            verdicts: guard.verdicts,
            from: guard.from ?? DEFAULT_PAYLOAD_SOURCE,
          });
  }
}

/**
 * Fold one leaf requirement into an assignment, or refuse.
 *
 * Refusal is the interesting half. Two edges at one node can want the same
 * observation to be two different things, and the whole point of solving over
 * the node rather than the edge is to notice.
 */
function applyRequirement(
  assignment: Assignment,
  requirement: Requirement,
  strings: (pattern: string, match: boolean) => string | undefined,
): boolean {
  const { guard, holds } = requirement;
  const key = keyOf(guard);

  if (guard.kind === "exitZero" || guard.kind === "fileExists") {
    const existing = assignment.flags.get(key);
    if (existing !== undefined && existing !== holds) return false;
    assignment.flags.set(key, holds);
    return true;
  }

  if (guard.kind === "judge") {
    const declared = guard.verdicts;
    let verdict: string;
    if (holds) {
      verdict = guard.is;
    } else {
      // A verdict outside a declared set is a broken contract rather than a
      // false guard, so falsifying has to stay inside the set.
      if (declared !== undefined) {
        const other = declared.find((candidate) => candidate !== guard.is);
        if (other === undefined) return false;
        verdict = other;
      } else {
        verdict = `not-${guard.is}`;
      }
    }
    const existing = assignment.verdicts.get(key);
    if (existing !== undefined && existing !== verdict) return false;
    assignment.verdicts.set(key, verdict);
    return true;
  }

  // field
  assignment.touched.add(key);
  const paths = assignment.payloads.get(key) ?? new Map<string, JsonValue>();
  const wanted = fieldValue(guard, holds, strings);
  if (wanted === undefined) return false;
  const existing = paths.get(guard.path);
  if (existing !== undefined && canonicalize(existing) !== canonicalize(wanted)) return false;
  paths.set(guard.path, wanted);
  assignment.payloads.set(key, paths);
  return true;
}

/** The value a field must hold to make its comparison come out as asked. */
function fieldValue(
  guard: Extract<Guard, { kind: "field" }>,
  holds: boolean,
  strings: (pattern: string, match: boolean) => string | undefined,
): JsonValue | undefined {
  switch (guard.op) {
    case "truthy":
      return holds ? true : false;
    case "equals":
      return holds ? (guard.value ?? null) : sentinelUnlike(guard.value);
    case "notEquals":
      return holds ? sentinelUnlike(guard.value) : (guard.value ?? null);
    case "gt": {
      const bound = typeof guard.value === "number" ? guard.value : 0;
      return holds ? bound + 1 : bound;
    }
    case "lt": {
      const bound = typeof guard.value === "number" ? guard.value : 0;
      return holds ? bound - 1 : bound;
    }
    case "matches": {
      const pattern = typeof guard.value === "string" ? guard.value : "";
      return strings(pattern, holds);
    }
  }
}

/** A value that is definitely not the one given, whatever that one is. */
function sentinelUnlike(value: JsonValue | undefined): JsonValue {
  return value === "minflow-not-this" ? "minflow-nor-this" : "minflow-not-this";
}

// ---------------------------------------------------------------------------
// Solving a node
// ---------------------------------------------------------------------------

/** What a solve produced, or why it could not. */
export type Solution =
  | { ok: true; observations: Observations; answers?: Record<string, string> }
  | {
      ok: false;
      reason: string;
      /**
       * Whether the decision is impossible rather than merely unreached.
       *
       * The two are different reports and belong on different sides of the
       * coverage fraction. An impossible outcome is a fact about the graph and
       * is not coverage debt; an unreached one is work still to do.
       */
      impossible: boolean;
    };

/**
 * The observations that make one node produce one outcome.
 *
 * Every edge at the node is constrained together, because the host resolves the
 * union of what they all read before the evaluator knows which one wins. Taking
 * the third edge means the first two must fail *using the same values*, and that
 * is a constraint problem rather than a lookup.
 *
 * The search is a backtracking assignment over the leaves. Leaf counts per node
 * are small, so this is exhaustive rather than heuristic, and an unsatisfiable
 * node is reported as such rather than silently skipped.
 */
export function solveOutcome(graph: Graph, outcome: Outcome, seed: number): Solution {
  if (outcome.infeasible !== undefined) {
    return { ok: false, reason: outcome.infeasible, impossible: true };
  }

  const siblings = siblingsOf(graph, outcome.from);
  const target = siblings.findIndex((edge) => edge.id === outcome.edge);

  // Which guards must hold and which must fail, per the evaluator's two passes.
  const demands: { guard: Guard; holds: boolean }[] = [];
  if (outcome.kind === "fire") {
    for (let index = 0; index < target; index += 1) {
      const sibling = siblings[index];
      if (sibling !== undefined) demands.push({ guard: sibling.guard, holds: false });
    }
    const own = siblings[target];
    if (own === undefined) {
      return { ok: false, reason: `no edge ${String(outcome.edge)}`, impossible: true };
    }
    demands.push({ guard: own.guard, holds: true });
  } else {
    // otherwise, exhaust and nomatch all need every guard at the node to fail.
    for (const sibling of siblings) demands.push({ guard: sibling.guard, holds: false });
  }

  const leaves: Requirement["guard"][] = [];
  for (const demand of demands) leavesOf(demand.guard, leaves);

  // Patterns nothing can fail, collected while solving so that a failed solve
  // can say which one blocked it rather than blaming the sibling edges.
  const unfalsifiable = new Set<string>();
  const strings = stringGenerator(seed, unfalsifiable);
  const truth = new Map<Requirement["guard"], boolean>();

  const search = (index: number, assignment: Assignment): Assignment | undefined => {
    if (index === leaves.length) {
      for (const demand of demands) {
        if (holdsUnder(demand.guard, truth) !== demand.holds) return undefined;
      }
      return assignment;
    }
    const leaf = leaves[index];
    if (leaf === undefined) return undefined;
    for (const value of [true, false]) {
      const attempt = cloneAssignment(assignment);
      if (!applyRequirement(attempt, { guard: leaf, holds: value }, strings)) continue;
      truth.set(leaf, value);
      const found = search(index + 1, attempt);
      if (found !== undefined) return found;
    }
    truth.delete(leaf);
    return undefined;
  };

  const solved = search(0, emptyAssignment());
  if (solved === undefined) {
    const patterns = [...unfalsifiable].map((pattern) => `/${pattern}/`).join(", ");
    return {
      ok: false,
      // Exhaustive over the leaves, so this is a proof rather than a give-up.
      impossible: true,
      reason:
        unfalsifiable.size > 0
          ? `no single set of observations makes "${outcome.from}" produce ${outcome.id}. ` +
            `${patterns} matches every string there is, so no value can fail it`
          : `no single set of observations makes "${outcome.from}" produce ${outcome.id}. ` +
            "The edges at this node read the same observations and want them to be different " +
            "things",
    };
  }

  const observations = materialise(graph, outcome.from, solved);
  const edge = graph.edges.find((candidate) => candidate.id === outcome.edge);
  const ask = outcome.kind === "fire" ? edge?.ask : undefined;
  if (ask === undefined) return { ok: true, observations };

  // An ask reading its questions out of the step's payload needs that payload to
  // contain a question list, or the run stops on an invalid graph rather than
  // asking anything. The solver has to put one there.
  const questions =
    ask.questions.kind === "static" ? ask.questions.items : syntheticQuestions(ask.questions.path);
  if (ask.questions.kind === "output") {
    injectQuestions(observations, ask.questions.path, questions);
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    // The first option, always. A generated test needs one reproducible answer,
    // not a plausible one: which option is sensible is a judgment the plan has
    // no way to make and no business making.
    answers[question.header] = question.options[0]?.label ?? "";
  }
  return { ok: true, observations, answers };
}

/** A question list standing in for one a step would have computed at run time. */
function syntheticQuestions(path: string): AskQuestion[] {
  return [
    {
      question: `Generated stand-in for the questions at "${path}".`,
      header: "Generated",
      options: [{ label: "First" }, { label: "Second" }],
    },
  ];
}

/** Put a question list at a dot path inside the step's inline payload. */
function injectQuestions(observations: Observations, path: string, questions: AskQuestion[]): void {
  const key = payloadKey(DEFAULT_PAYLOAD_SOURCE);
  const existing = observations[key];
  const payload =
    existing !== undefined &&
    existing.ok &&
    typeof existing.value === "object" &&
    existing.value !== null &&
    !Array.isArray(existing.value)
      ? { ...(existing.value as Record<string, JsonValue>) }
      : {};
  const paths = new Map<string, JsonValue>();
  paths.set(path, questions as unknown as JsonValue);
  Object.assign(payload, buildPayload(paths));
  observations[key] = { ok: true, value: payload };
}

/**
 * The assignment as the host would answer it.
 *
 * A node contracted to produce a payload always gets one, even when no guard
 * read a field out of it. Leaving it out is an unmet contract rather than an
 * absent value, and the evaluator reports it as an error.
 */
function materialise(graph: Graph, nodeId: NodeId, assignment: Assignment): Observations {
  const observations: Observations = {};

  for (const [key, value] of assignment.flags) {
    observations[key] = { ok: true, value };
  }
  for (const [key, verdict] of assignment.verdicts) {
    observations[key] = { ok: true, value: verdict };
  }

  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const contracted = node !== undefined && (isCommandNode(node) || node.schema !== undefined);
  if (contracted) assignment.touched.add(payloadKey(DEFAULT_PAYLOAD_SOURCE));

  // A guard is not the only thing that reads a payload. Every later prompt or
  // command interpolating {{ctx.<this node>.<path>}} is an obligation on it too,
  // and a payload missing one stops the run on a template it cannot resolve
  // rather than on anything the case was testing.
  const interpolated = interpolatedPathsOf(graph, nodeId);
  if (interpolated.size > 0) {
    const key = payloadKey(DEFAULT_PAYLOAD_SOURCE);
    assignment.touched.add(key);
    const paths = assignment.payloads.get(key) ?? new Map<string, JsonValue>();
    for (const path of interpolated) {
      if (paths.has(path)) continue;
      paths.set(path, `minflow-generated-${nodeId}-${path.split(".").join("-")}`);
    }
    assignment.payloads.set(key, paths);
  }

  for (const key of assignment.touched) {
    const paths = assignment.payloads.get(key) ?? new Map<string, JsonValue>();
    const payload = buildPayload(paths);
    if (node !== undefined && isCommandNode(node) && payload.exitCode === undefined) {
      // A command node's payload is produced by the host and always has these.
      payload.exitCode = 0;
      payload.stdout = "";
      payload.stderr = "";
    }
    observations[key] = { ok: true, value: payload };
  }

  return observations;
}

/** Every dot path any template in the graph reads out of `nodeId`'s payload. */
function interpolatedPathsOf(graph: Graph, nodeId: NodeId): Set<string> {
  const paths = new Set<string>();
  const reference = /\{\{\s*ctx\.([A-Za-z0-9_.-]+?)\.([A-Za-z0-9_.-]+?)\s*\}\}/g;
  for (const node of graph.nodes) {
    const template = templateOf(node);
    if (template === undefined) continue;
    for (const match of template.matchAll(reference)) {
      if (match[1] !== nodeId) continue;
      const path = match[2];
      if (path !== undefined) paths.add(path);
    }
  }
  return paths;
}

function payloadKey(from: PayloadSource): string {
  return observationKey({ kind: "payload", from });
}

/** One object satisfying every dot path a node's guards read out of it. */
function buildPayload(paths: Map<string, JsonValue>): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const [path, value] of paths) {
    const segments = path.split(".");
    let cursor: Record<string, JsonValue> = payload;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      const existing = cursor[segment];
      if (
        existing === undefined ||
        typeof existing !== "object" ||
        existing === null ||
        Array.isArray(existing)
      ) {
        const fresh: Record<string, JsonValue> = {};
        cursor[segment] = fresh;
        cursor = fresh;
      } else {
        cursor = existing as Record<string, JsonValue>;
      }
    }
    const last = segments[segments.length - 1];
    if (last !== undefined) cursor[last] = value;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * Strings that match a pattern, or definitely do not.
 *
 * Seeded, so two generations of the same plan agree. Pattern matching is the one
 * guard kind that needs more than arithmetic to invert, and generating a string
 * from a regular expression is somebody else's solved problem.
 */
function stringGenerator(
  seed: number,
  unfalsifiable: Set<string>,
): (pattern: string, match: boolean) => string | undefined {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  return (pattern: string, match: boolean): string | undefined => {
    if (!match) {
      // Almost anything fails a pattern; check rather than assume, since a
      // pattern like /.*/ matches everything and cannot be falsified.
      for (const candidate of ["minflow-no-match", "", " "]) {
        if (!new RegExp(pattern).test(candidate)) return candidate;
      }
      // Nothing fails it. Refuse, rather than returning a string that matches
      // and letting a case be generated whose walk the run can never take. The
      // caller reports the outcome unreachable, which is the truth about the
      // graph rather than a failure to find something.
      unfalsifiable.add(pattern);
      return undefined;
    }
    const generator = new RandExp(pattern);
    // Unbounded repeats default to a hundred characters, which turns \\d+ into a
    // sixty digit number and a readable plan into an unreadable one.
    generator.max = 4;
    generator.randInt = (from: number, to: number): number =>
      from + Math.floor(next() * (to - from + 1));
    return generator.gen();
  };
}

// ---------------------------------------------------------------------------
// Walks
// ---------------------------------------------------------------------------

/** Where an outcome leaves the run, when it leaves it somewhere. */
function successorOf(outcome: Outcome): NodeId | undefined {
  if (outcome.kind === "nomatch" || outcome.kind === "exhaust") return undefined;
  if (outcome.to === undefined || isEnd(outcome.to)) return undefined;
  return outcome.to;
}

/** Outcomes leaving a node, feasible ones first, in declaration order. */
function feasibleAt(outcomes: Outcome[], node: NodeId): Outcome[] {
  return outcomes.filter((outcome) => outcome.from === node && outcome.infeasible === undefined);
}

/**
 * The outcomes to take, in order, to get from `entry` to `target.from`.
 *
 * Breadth-first, so the route is the shortest one, which keeps a case short
 * enough to read and keeps the first failure close to what caused it.
 */
function routeTo(outcomes: Outcome[], entry: NodeId, target: NodeId): Outcome[] | undefined {
  if (entry === target) return [];
  const cameFrom = new Map<NodeId, { via: Outcome; from: NodeId }>();
  const queue: NodeId[] = [entry];
  const seen = new Set<NodeId>(queue);

  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined) break;
    for (const outcome of feasibleAt(outcomes, node)) {
      const next = successorOf(outcome);
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, { via: outcome, from: node });
      if (next === target) {
        const route: Outcome[] = [];
        for (let at: NodeId | undefined = target; at !== undefined && at !== entry; ) {
          const step = cameFrom.get(at);
          if (step === undefined) break;
          route.unshift(step.via);
          at = step.from;
        }
        return route;
      }
      queue.push(next);
    }
  }
  return undefined;
}

/**
 * Generate a plan covering every outcome the graph can produce.
 *
 * One case per outcome that is not already covered on the way to another, which
 * keeps cases short and independent. A single long tour would cover the same
 * ground in fewer runs and would be a worse test: the first failure would mask
 * everything after it, and nobody could read it.
 */
export function generateSuite(graph: Graph, options: SuiteOptions = {}): TestSuite {
  const seed = options.seed ?? DEFAULT_SEED;
  const maxCases = options.maxCases ?? DEFAULT_MAX_CASES;

  const outcomes = outcomesOf(graph);
  const covered = new Set<string>();
  const uncovered: Uncovered[] = [];
  const impossible = new Set<string>();
  const cases: TestCase[] = [];

  for (const outcome of outcomes) {
    if (outcome.infeasible !== undefined) {
      uncovered.push({ outcome: outcome.id, reason: outcome.infeasible });
      impossible.add(outcome.id);
      continue;
    }
    if (covered.has(outcome.id)) continue;
    if (cases.length >= maxCases) {
      uncovered.push({
        outcome: outcome.id,
        reason: `the plan hit its ceiling of ${maxCases} cases before reaching this`,
      });
      continue;
    }

    const route = routeTo(outcomes, graph.entry, outcome.from);
    if (route === undefined) {
      uncovered.push({
        outcome: outcome.id,
        reason: `no route from "${graph.entry}" reaches "${outcome.from}"`,
      });
      continue;
    }

    const built = buildCase(graph, outcomes, [...route, outcome], seed, `case-${cases.length + 1}`);
    if (!built.ok) {
      uncovered.push({ outcome: outcome.id, reason: built.reason });
      if (built.impossible) impossible.add(outcome.id);
      continue;
    }
    for (const id of built.plan.covers) covered.add(id);
    cases.push(built.plan);
  }

  // The denominator is what a run could actually have done. An outcome proved
  // impossible is not coverage owed, so counting it would report a fraction
  // nothing could ever close.
  const feasible = outcomes.filter(
    (outcome) => outcome.infeasible === undefined && !impossible.has(outcome.id),
  );
  return {
    planVersion: 1,
    workflow: graph.name,
    graphHash: graph.hash,
    seed,
    cases,
    coverage: {
      total: feasible.length,
      covered: [...covered].length,
      uncovered,
    },
  };
}

/** A case, or the reason the run it describes could not be arranged. */
type BuiltCase = { ok: true; plan: TestCase } | { ok: false; reason: string; impossible: boolean };

/**
 * Turn a chosen sequence of outcomes into a runnable case.
 *
 * An `exhaust` outcome is the one that needs repeating: it is reached by taking
 * the same retry once past its ceiling, so the step is emitted `limit + 1` times
 * rather than once.
 */
function buildCase(
  graph: Graph,
  outcomes: Outcome[],
  chosen: Outcome[],
  seed: number,
  id: string,
): BuiltCase {
  const steps: TestStep[] = [];
  const walk: NodeId[] = [];
  const covers: string[] = [];

  for (const outcome of chosen) {
    const solved = solveOutcome(graph, outcome, seed);
    if (!solved.ok) return { ok: false, reason: solved.reason, impossible: solved.impossible };

    const repeats =
      outcome.kind === "exhaust"
        ? (graph.edges.find((edge) => edge.id === outcome.edge)?.limit ?? 0) + 1
        : 1;

    for (let attempt = 0; attempt < repeats; attempt += 1) {
      walk.push(outcome.from);
      const step: TestStep = {
        node: outcome.from,
        outcome: outcome.id,
        observations: solved.observations,
      };
      if (solved.answers !== undefined) step.answers = solved.answers;
      steps.push(step);
    }
    covers.push(outcome.id);
  }

  const last = chosen[chosen.length - 1];
  if (last === undefined) return { ok: false, reason: "no outcomes chosen", impossible: false };

  let ends: TestCase["ends"] = "error";
  if (last.kind === "exhaust" || last.kind === "nomatch") ends = "error";
  else if (last.to !== undefined && isEnd(last.to)) ends = "end";
  else if (graph.edges.find((edge) => edge.id === last.edge)?.gate !== undefined) ends = "gate";
  else {
    // The run has not finished, so carry it to a terminal by taking the first
    // feasible outcome at each node. A case that stops mid-graph would leave a
    // live run behind and tell us nothing about how it ends.
    // Outcomes taken on the way to a terminal count as covered. They really did
    // happen, and not counting them generates a fresh case per outcome that any
    // earlier case had already exercised.
    const finish = carryToTerminal(graph, outcomes, last, seed, steps, walk, covers);
    ends = finish.ends;
    if (!finish.ok) return { ok: false, reason: finish.reason, impossible: false };
  }

  return { ok: true, plan: { id, covers, steps, walk, ends } };
}

/** Take the first feasible outcome at each node until the run finishes. */
function carryToTerminal(
  graph: Graph,
  outcomes: Outcome[],
  from: Outcome,
  seed: number,
  steps: TestStep[],
  walk: NodeId[],
  covers: string[],
): { ok: true; ends: TestCase["ends"] } | { ok: false; ends: TestCase["ends"]; reason: string } {
  const seen = new Set<NodeId>();
  let node = successorOf(from);

  while (node !== undefined) {
    if (seen.has(node)) {
      // A loop with nothing pushing it out. lintGraph rejects graphs where this
      // is possible, so reaching it means the plan is walking one anyway.
      return { ok: true, ends: "error" };
    }
    seen.add(node);

    const next = feasibleAt(outcomes, node)[0];
    if (next === undefined) return { ok: false, ends: "error", reason: `nothing leaves "${node}"` };

    const solved = solveOutcome(graph, next, seed);
    if (!solved.ok) return { ok: false, ends: "error", reason: solved.reason };
    walk.push(node);
    const step: TestStep = { node, outcome: next.id, observations: solved.observations };
    if (solved.answers !== undefined) step.answers = solved.answers;
    steps.push(step);
    covers.push(next.id);

    if (graph.edges.find((edge) => edge.id === next.edge)?.gate !== undefined) {
      return { ok: true, ends: "gate" };
    }
    if (next.to !== undefined && isEnd(next.to)) return { ok: true, ends: "end" };
    node = successorOf(next);
  }
  return { ok: true, ends: "end" };
}
