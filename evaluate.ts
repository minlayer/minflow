/**
 * The transition evaluator.
 *
 * Given a compiled graph, the run state, and the observations the host has
 * already resolved, this decides what happens next. It is a **pure function**:
 * no filesystem, no network, no model, no clock, no randomness, and no mutation
 * of the state it is handed. The same inputs produce the same `Transition`
 * forever, which is what lets an entire graph be tested with no model in the
 * loop.
 *
 * The seam that makes that possible is {@link observationsFor}: guards declare
 * what must be found out, the host goes and finds it out, and only resolved
 * JSON reaches the evaluator. No code path here can branch on how a payload was
 * delivered.
 *
 * @packageDocumentation
 */

import { canonicalize } from "./hash.js";
import type {
  End,
  Guard,
  IrEdge,
  JsonValue,
  NodeId,
  ObservationRequest,
  ObservationResult,
  Otherwise,
  PayloadSource,
  RunState,
  Transition,
  TransitionErrorCode,
  WorkflowIr,
} from "./ir.js";
import { DEFAULT_PAYLOAD_SOURCE, isEnd } from "./ir.js";

/** Run-wide ceiling applied when the caller does not name one. */
const DEFAULT_STEP_CEILING = 1000;

/** The event label carried by a transition taken through an `otherwise: goto`. */
const OTHERWISE_EVENT = "otherwise";

/**
 * An {@link ObservationRequest} before its key is computed.
 *
 * Note what is *not* here: a judge's `is`. The expected verdict is a property
 * of the edge, not of the question, so two edges out of a branch asking the
 * same question collapse to a single observation and the model is asked once.
 */
export type ObservationSpec =
  | { kind: "exitZero"; command: string }
  | { kind: "fileExists"; path: string }
  | { kind: "payload"; from: PayloadSource }
  | { kind: "judge"; question: string; verdicts?: string[]; from: PayloadSource };

/** The guard kinds that bottom out in an observation, as opposed to composing others. */
type LeafGuard = Extract<Guard, { kind: "exitZero" | "fileExists" | "field" | "judge" }>;

// ---------------------------------------------------------------------------
// Structural comparison
// ---------------------------------------------------------------------------

/**
 * Structural equality over JSON values, order-insensitive for object keys.
 *
 * The canonical form is the one `hash.ts` defines, imported rather than
 * restated. An observation key and the graph hash have to agree on what
 * canonical means, and a second copy of the rule would drift from the first
 * with nothing in the build comparing them. It also declines a circular
 * structure by name instead of overflowing the stack, which matters here
 * because the values reaching this function come from the host.
 */
function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalize(left) === canonicalize(right);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Stable, deterministic key for an observation.
 *
 * Two observations that ask the same question produce the same key regardless
 * of the property order of the objects they were built from. The key is also
 * the identity used to deduplicate requests and to look results back up, so
 * {@link observationsFor} and {@link evaluate} necessarily agree on it.
 */
export function observationKey(spec: ObservationSpec): string {
  switch (spec.kind) {
    case "exitZero":
      return `exitZero:${canonicalize({ command: spec.command })}`;
    case "fileExists":
      return `fileExists:${canonicalize({ path: spec.path })}`;
    case "payload":
      return `payload:${canonicalize({ from: spec.from })}`;
    case "judge":
      return `judge:${canonicalize(
        spec.verdicts === undefined
          ? { question: spec.question, from: spec.from }
          : { question: spec.question, verdicts: spec.verdicts, from: spec.from },
      )}`;
  }
}

/** The observation a leaf guard needs before it can be decided. */
function specForLeaf(guard: LeafGuard): ObservationSpec {
  switch (guard.kind) {
    case "exitZero":
      return { kind: "exitZero", command: guard.command };
    case "fileExists":
      return { kind: "fileExists", path: guard.path };
    case "field":
      return { kind: "payload", from: guard.from ?? DEFAULT_PAYLOAD_SOURCE };
    case "judge":
      return guard.verdicts === undefined
        ? { kind: "judge", question: guard.question, from: guard.from ?? DEFAULT_PAYLOAD_SOURCE }
        : {
            kind: "judge",
            question: guard.question,
            verdicts: guard.verdicts,
            from: guard.from ?? DEFAULT_PAYLOAD_SOURCE,
          };
  }
}

/** Attach the key, keeping absent optional properties absent. */
function requestFor(spec: ObservationSpec): ObservationRequest {
  const key = observationKey(spec);
  switch (spec.kind) {
    case "exitZero":
      return { key, kind: "exitZero", command: spec.command };
    case "fileExists":
      return { key, kind: "fileExists", path: spec.path };
    case "payload":
      return { key, kind: "payload", from: spec.from };
    case "judge":
      return spec.verdicts === undefined
        ? { key, kind: "judge", question: spec.question, from: spec.from }
        : {
            key,
            kind: "judge",
            question: spec.question,
            verdicts: spec.verdicts,
            from: spec.from,
          };
  }
}

function collectGuard(guard: Guard, into: ObservationRequest[], seen: Set<string>): void {
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

/**
 * Everything the host must find out to decide the transitions out of
 * `state.node`, deduplicated by key and in first-encountered order.
 *
 * Every edge whose `from` is the current node contributes, including edges
 * whose guard will never be reached because an earlier edge holds: the host
 * resolves observations before the evaluator knows which edge wins, so the set
 * is the union rather than the minimum.
 *
 * A node that declares a `schema` contributes one more, on the default lane,
 * even when no guard reads a payload. The step's output is recorded from a
 * resolved payload observation (rule 7a), so without this a node would produce
 * an output only by the accident of some outgoing guard happening to read a
 * payload lane. A node whose edges are all `always`, `exitZero` or
 * `fileExists` would declare an output contract and populate nothing for later
 * steps to interpolate. The request is deduplicated against any payload
 * observation the guards already asked for on that lane, and is appended after
 * them, so a lane a guard names explicitly stays earlier in enumeration order
 * and therefore still wins rule 7a.
 */
export function observationsFor(ir: WorkflowIr, state: RunState): ObservationRequest[] {
  const requests: ObservationRequest[] = [];
  const seen = new Set<string>();
  for (const edge of ir.edges) {
    if (edge.from !== state.node) continue;
    collectGuard(edge.guard, requests, seen);
  }
  const node = ir.nodes.find((candidate) => candidate.id === state.node);
  if (node?.schema !== undefined) {
    const request = requestFor({ kind: "payload", from: DEFAULT_PAYLOAD_SOURCE });
    if (!seen.has(request.key)) {
      seen.add(request.key);
      requests.push(request);
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Guard resolution
// ---------------------------------------------------------------------------

/**
 * Three-valued, because a broken contract is not a false guard.
 *
 * `{ ok: false }` means an observation the guard depends on was never resolved
 * or came back failed. That has to surface as an error rather than route down
 * an `otherwise` branch wearing the clothes of a test that legitimately failed.
 */
type GuardOutcome = { ok: true; holds: boolean } | { ok: false; error: string };

const HOLDS: GuardOutcome = { ok: true, holds: true };
const FAILS: GuardOutcome = { ok: true, holds: false };

type Lookup = { ok: true; value: JsonValue } | { ok: false; error: string };

function lookup(key: string, resolved: Record<string, ObservationResult>): Lookup {
  const result = resolved[key];
  if (result === undefined) {
    return { ok: false, error: `no observation was resolved for ${key}` };
  }
  if (!result.ok) {
    return { ok: false, error: `observation ${key} failed: ${result.error}` };
  }
  return { ok: true, value: result.value };
}

/**
 * Read a dot path out of a payload.
 *
 * Numeric segments index arrays. Only own properties count, so `constructor`
 * and `__proto__` read as absent rather than leaking the prototype chain into a
 * comparison. Absent is `undefined`, which is outside `JsonValue`, so a field
 * that is present and `null` stays distinguishable from one that is missing.
 */
function readPath(payload: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = payload;
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

function matchesPattern(target: JsonValue, source: JsonValue | undefined): boolean {
  if (typeof target !== "string" || typeof source !== "string") return false;
  try {
    return new RegExp(source).test(target);
  } catch {
    // A malformed pattern is a graph-authoring bug for the linter to catch, not
    // a broken host contract; it must not crash a run.
    return false;
  }
}

function evaluateField(guard: Extract<Guard, { kind: "field" }>, payload: JsonValue): boolean {
  const target = readPath(payload, guard.path);
  if (target === undefined) {
    // An absent path is false for every op except `notEquals`, which is true:
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
  }
}

/**
 * Combine sub-outcomes under Kleene three-valued logic.
 *
 * A conjunction with a definitely-false member is false whatever the unresolved
 * members would have said, and a disjunction with a definitely-true member is
 * true. Only when an unresolved member could still change the answer does the
 * failure surface as an error. That keeps the combination order-independent, so
 * `all([false, broken])` and `all([broken, false])` agree, while never letting
 * a broken contract decide the route.
 */
function combine(outcomes: GuardOutcome[], mode: "all" | "any"): GuardOutcome {
  // The sub-outcome that settles the combination on its own.
  const decisive = mode === "any";
  let failure: string | undefined;
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

function resolveGuard(guard: Guard, resolved: Record<string, ObservationResult>): GuardOutcome {
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
      // judge contract rather than a verdict that happens not to match. The
      // check has to come first and has to be on the value itself: comparing
      // `String(value)` against the declared set would let `1` pass a set
      // containing `"1"` and then fail the `===` against `is`, routing a broken
      // contract quietly down `otherwise`, which is the one thing rule 5 forbids.
      if (typeof found.value !== "string") {
        return {
          ok: false,
          error:
            `observation ${key} returned ${canonicalize(found.value)}, ` +
            "which is not a string; a judge must return a verdict",
        };
      }
      if (guard.verdicts !== undefined && !guard.verdicts.includes(found.value)) {
        return {
          ok: false,
          error:
            `observation ${key} returned ${canonicalize(found.value)}, ` +
            `which is not one of the declared verdicts ${canonicalize(guard.verdicts)}`,
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
        guard.guards.map((inner) => resolveGuard(inner, resolved)),
        "all",
      );
    case "any":
      return combine(
        guard.guards.map((inner) => resolveGuard(inner, resolved)),
        "any",
      );
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Copy the state verbatim, including a parked gate. Payload values already in
 * `outputs` are shared by reference with the state we were handed; they are
 * treated as immutable JSON and are never written through. A value newly
 * recorded from the resolved map is cloned instead; see {@link departingState}.
 */
function cloneState(state: RunState): RunState {
  const next: RunState = {
    runId: state.runId,
    graphHash: state.graphHash,
    node: state.node,
    status: state.status,
    attempts: { ...state.attempts },
    steps: state.steps,
    outputs: { ...state.outputs },
  };
  if (state.gate !== undefined) next.gate = state.gate;
  // Carried through opaquely. The host owns this; we neither read it nor drop
  // it, and dropping it would strand whatever multi-pass work it is tracking.
  if (state.host !== undefined) next.host = { ...state.host };
  return next;
}

/**
 * Copy the state as a live run: no gate, status `running`.
 *
 * `host` comes along, on this path as much as on {@link cloneState}'s. The
 * scratch is the host's, and only the host knows when the work it records there
 * is finished, so an evaluator that cleared it on advance, retry, gate or end
 * would silently discard multi-pass work, including work that is tracking the
 * very node a retry is about to re-run. A host that wants it gone clears it on
 * its own side, where the decision is informed.
 *
 * The copy is shallow, like `outputs`: the nested values belong to the host and
 * are carried by reference, never read and never written through.
 */
function runningClone(state: RunState): RunState {
  const next: RunState = {
    runId: state.runId,
    graphHash: state.graphHash,
    node: state.node,
    status: "running",
    attempts: { ...state.attempts },
    steps: state.steps,
    outputs: { ...state.outputs },
  };
  if (state.host !== undefined) next.host = { ...state.host };
  return next;
}

/**
 * Drop the retry budget of every edge out of `node`.
 *
 * The budget counts *consecutive* failures at a node, and departing the node
 * settles all of them, not only the edge that happened to fire. Clearing just
 * the firing edge would leak a count across visits whenever a node is left
 * through a sibling edge, so the next visit would start part-way through a
 * budget it had already earned back.
 */
function withoutAttemptsFrom(
  attempts: Record<string, number>,
  ir: WorkflowIr,
  node: NodeId,
): Record<string, number> {
  const departed = new Set(ir.edges.filter((edge) => edge.from === node).map((edge) => edge.id));
  const next: Record<string, number> = {};
  for (const [key, count] of Object.entries(attempts)) {
    if (!departed.has(key)) next[key] = count;
  }
  return next;
}

/** Detach a value from the caller's resolved map. Everything here is JSON by contract. */
function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorTransition(state: RunState, code: TransitionErrorCode, message: string): Transition {
  return { kind: "error", code, message, state: cloneState(state) };
}

/**
 * The payload this node produced: the first payload observation that resolved
 * ok, in the enumeration order of {@link observationsFor}. A node is asked
 * about more than one lane only when its guards name lanes explicitly, and a
 * named lane precedes the one implied by the node's `schema`.
 *
 * **A node that declares a `schema` must produce a payload on some lane.** The
 * schema is the step's output contract, so delivering nothing readable is a
 * violated contract, and this module's rule for a violated contract is the same
 * everywhere: it is an error, never a quiet nothing. Letting it through would put
 * an empty `outputs` entry in front of every later step that interpolates this
 * one, and surface the real failure somewhere far away from its cause.
 *
 * Any lane satisfies it. A step whose edges read a file lane legitimately leaves
 * the inline lane empty, so the requirement is one-of, not all-of.
 */
function payloadOutput(
  ir: WorkflowIr,
  state: RunState,
  resolved: Record<string, ObservationResult>,
): { ok: true; value?: JsonValue } | { ok: false; error: string } {
  let found: JsonValue | undefined;
  const failures: string[] = [];

  for (const request of observationsFor(ir, state)) {
    if (request.kind !== "payload") continue;
    const result = resolved[request.key];
    if (result === undefined) {
      failures.push(`${request.key} (not resolved)`);
    } else if (result.ok) {
      if (found === undefined) found = result.value;
    } else {
      failures.push(`${request.key} (${result.error})`);
    }
  }

  const node = ir.nodes.find((candidate) => candidate.id === state.node);
  if (found === undefined && node?.schema !== undefined) {
    // `failures` cannot be empty here: a node declaring a schema always gets a
    // payload request from observationsFor, and every request that did not land
    // in `found` landed in `failures`. An unreachable fallback string would be a
    // branch no test could ever defend.
    const detail = failures.join(", ");
    return {
      ok: false,
      error:
        `node "${state.node}" declares a schema but produced no readable payload: ${detail}. ` +
        "A declared output contract that is not met is an error, not an empty output.",
    };
  }

  return found === undefined ? { ok: true } : { ok: true, value: found };
}

/**
 * The state a departing transition leaves behind: the node's payload recorded
 * as its output, and the retry budget of every edge out of the node cleared,
 * because the budget counts consecutive failures and this visit ended in none.
 *
 * The payload is cloned on the way in. The value arrives inside the caller's
 * `resolved` map, which the caller still owns and may reuse or mutate after we
 * return; storing the reference would let that mutation reach back into a state
 * the host has already been told to persist.
 */
function departingState(
  ir: WorkflowIr,
  state: RunState,
  resolved: Record<string, ObservationResult>,
): RunState | { error: string } {
  const payload = payloadOutput(ir, state, resolved);
  if (!payload.ok) return { error: payload.error };

  const next = runningClone(state);
  if (payload.value !== undefined) next.outputs[state.node] = cloneJson(payload.value);
  next.attempts = withoutAttemptsFrom(next.attempts, ir, state.node);
  return next;
}

/** Narrows {@link departingState}'s result. */
function isDepartureError(value: RunState | { error: string }): value is { error: string } {
  return "error" in value;
}

/** End at `END`, otherwise advance. Shared by a fired edge and an `otherwise: goto`. */
function moveTo(next: RunState, target: NodeId | End, via: string, event: string): Transition {
  next.steps += 1;
  if (isEnd(target)) {
    return { kind: "end", via, state: next };
  }
  next.node = target;
  return { kind: "advance", to: target, via, event, state: next };
}

function fireEdge(
  ir: WorkflowIr,
  state: RunState,
  resolved: Record<string, ObservationResult>,
  edge: IrEdge,
): Transition {
  if (edge.gate !== undefined) {
    if (isEnd(edge.goto)) {
      // A park writes the destination into `state.node`, and `END` is not a
      // node: the parked run would point at a marker no lookup can resolve, so
      // the resume would come back `unknown-node` and the run would be stranded
      // for good. Parking at the node just completed is not a fix either: nothing
      // here reads `state.status`, so the resumed run would re-walk the
      // same edge and park again, forever. The graph is the thing that is
      // wrong. The builder refuses to author one; this catches an IR that did
      // not come from the builder.
      return errorTransition(
        state,
        "invalid-graph",
        `edge ${edge.id} out of "${state.node}" is gated and goes to END, ` +
          "which cannot be executed: a run parked at a gate resumes into its destination, " +
          "and END is not a node to resume into, so the parked run could never be resumed. " +
          "Route the gate at a real node and end the run from there.",
      );
    }
    // A parked run points at the node it will resume into, so resuming is just
    // flipping status back to `running`. No step is counted for the park.
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

function applyOtherwise(
  ir: WorkflowIr,
  state: RunState,
  resolved: Record<string, ObservationResult>,
  edge: IrEdge,
  otherwise: Otherwise,
): Transition {
  if (otherwise.kind === "goto") {
    // A divert is not the edge's declared event, so it is not labelled with it.
    const next = departingState(ir, state, resolved);
    if (isDepartureError(next)) return errorTransition(state, "observation-failed", next.error);
    return moveTo(next, otherwise.node, edge.id, OTHERWISE_EVENT);
  }

  const attempt = (state.attempts[edge.id] ?? 0) + 1;
  const next = runningClone(state);
  next.attempts[edge.id] = attempt;
  if (edge.limit !== undefined && attempt > edge.limit) {
    return {
      kind: "error",
      code: "retry-limit-exceeded",
      message:
        `edge ${edge.id} would retry node "${state.node}" a ${ordinal(attempt)} time, ` +
        `past its limit of ${edge.limit}`,
      state: next,
    };
  }
  next.steps += 1;
  return {
    kind: "retry",
    node: state.node,
    via: edge.id,
    reason: otherwise.reason,
    attempt,
    state: next,
  };
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Decide the transition out of `state.node`.
 *
 * Pure. `state` is never mutated; the returned `Transition` always carries a
 * fresh state object for the host to persist.
 *
 * @param ir - The compiled graph.
 * @param state - Where the run is now.
 * @param resolved - Observation results, keyed as {@link observationsFor} keyed
 *   its requests. Anything a guard needs and does not find here is a failure,
 *   not a false guard.
 * @param opts - `stepCeiling` defaults to 1000.
 */
export function evaluate(
  ir: WorkflowIr,
  state: RunState,
  resolved: Record<string, ObservationResult>,
  opts?: { stepCeiling?: number },
): Transition {
  // Ordered deliberately: a graph edited mid-run must not be resumed against
  // nodes that may no longer mean the same thing, so nothing else is trusted
  // until the hash matches.
  if (state.graphHash !== ir.hash) {
    return errorTransition(
      state,
      "graph-hash-mismatch",
      `run ${state.runId} started against graph ${state.graphHash}, but this graph hashes to ${ir.hash}`,
    );
  }

  if (!ir.nodes.some((node) => node.id === state.node)) {
    return errorTransition(
      state,
      "unknown-node",
      `node "${state.node}" is not part of workflow "${ir.name}"`,
    );
  }

  const ceiling = opts?.stepCeiling ?? DEFAULT_STEP_CEILING;
  if (state.steps >= ceiling) {
    return errorTransition(
      state,
      "step-ceiling-exceeded",
      `run ${state.runId} has taken ${state.steps} steps, at or past its ceiling of ${ceiling}`,
    );
  }

  const edges = ir.edges.filter((edge) => edge.from === state.node);

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
    `no edge out of "${state.node}" held, and none of them declares an otherwise`,
  );
}
