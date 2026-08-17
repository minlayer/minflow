/**
 * The intermediate representation.
 *
 * This is a compile target, not an authoring surface. Users write a graph with
 * the builder; `compile()` produces one of these. It is deliberately plain
 * JSON-serializable data so that a second front-end can target it later without
 * going through the builder, and so a compiled graph can be diffed, hashed, and
 * linted with no model and no runtime in the loop.
 *
 * Two properties are load-bearing and constrain everything below:
 *
 * 1. **Guards are data, not closures.** A predicate has to survive a round trip
 *    through JSON, because the compiled graph ships as a file and is read back
 *    by a separate process on every transition. `when.exitZero("npm test")`
 *    therefore compiles to `{ kind: "exitZero", command: "npm test" }` and the
 *    host, not the IR, knows how to run it.
 *
 * 2. **The evaluator never learns where a value came from.** A step's payload is
 *    always JSON; the only choice is whether that JSON arrives inline or in a
 *    file. The host resolves the lane into a value before evaluation, so no code
 *    path in the evaluator can branch on delivery. Parity between the lanes is a
 *    property of the type signature rather than something tests have to defend.
 *
 * @packageDocumentation
 */

/** Any value that survives a JSON round trip. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A node name, used as the state value. */
export type NodeId = string;

/**
 * Terminal marker. A string rather than a symbol so the IR round-trips through
 * JSON; the leading underscores keep it out of the space of plausible node names.
 */
export const END = "__end__";
export type End = typeof END;

/** Narrowing helper, so callers do not compare against the literal by hand. */
export function isEnd(target: NodeId | End): target is End {
  return target === END;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** What every node carries, whatever kind it is. */
interface NodeBase {
  /** Node name, used as the state value. */
  id: NodeId;
  /** Display grouping. */
  phase?: string;
}

/**
 * One step of the graph. `skill` names a skill the user already wrote; nothing
 * here is injected into their file, and the compiler only ever reads it.
 *
 * The discriminant is optional on this variant and required on
 * {@link CommandNode}, which still narrows a union correctly and means a graph
 * written before command nodes existed is unchanged rather than needing a field
 * that says "the usual kind".
 */
export interface StepNode extends NodeBase {
  /** Discriminant. Absent means a step, which is what most nodes are. */
  kind?: "step";
  /** The user's skill this node invokes. */
  skill: string;
  /**
   * The step's task, as a template over the run context.
   *
   * Two placeholder forms, and the difference is when each is resolved:
   *
   * - `{{params.key}}` names one of this node's own {@link Node.params}. It is
   *   fixed when the graph compiles, so a backend substitutes it at emit time.
   * - `{{ctx.node.dot.path}}` reads a path out of an earlier step's payload,
   *   which only exists once that step has run, so a host substitutes it from
   *   `RunState.outputs` at spawn time.
   *
   * A `ctx` reference is legal only when the node it names **dominates** this
   * one, meaning every path from the entry node reaches this node through it.
   * Anything weaker permits a graph whose branches decide whether the value
   * exists, and a template that resolves on one route and not another is a
   * failure the author cannot see when writing it. Dominance is decidable from
   * the graph alone, so it is a compile error rather than a runtime one.
   */
  prompt?: string;
  /** Scalars this node's own prompt may interpolate as `{{params.key}}`. */
  params?: Record<string, JsonValue>;
  /** Structured-output contract for the step, as JSON Schema. */
  schema?: JsonValue;
  /**
   * Per-node model override. Defaults to inheriting the session's.
   *
   * **A known defect, deliberately unpaid: this holds a provider's own model
   * name.** `"haiku"` in an IR whose whole claim is to outlive any one platform
   * is a Claude Code dependency written into the layer that exists not to have
   * one, and nothing validates it, so a misspelling compiles clean and names a
   * model the platform does not have. It should be an agnostic tier, `small`,
   * `medium` or `large`, translated by each backend, with exact pinning moved to
   * the emit call where every other platform-specific fact already lives.
   * Changing it is breaking, so it waits. See D28 and L23.
   */
  model?: string;
  /** Per-step turn ceiling. Provider-agnostic: a turn is a turn. */
  maxTurns?: number;
  /** Tool allowlist for the step. Carries the same leak as {@link model}. */
  tools?: string[];
}

/**
 * A node that runs a shell command instead of a model.
 *
 * Mechanical work in a workflow was previously expressible only as a guard, so
 * anything that had to *happen* rather than be *decided* had to masquerade as a
 * predicate and do its work as a side effect. That reads as a lie in the graph
 * and hides real steps from the diagram and the trace.
 *
 * The host runs it, records `{ exitCode, stdout, stderr }` as the node's output,
 * and evaluates the outgoing edges against that. Guards read it like any other
 * payload, so `when.field("exitCode").equals(0)` is the ordinary spelling.
 *
 * **It costs no model call and no runner round trip**, which is the point: on
 * Claude Code the host runs it inside the dispatcher, between two hook fires.
 * That is also its limit, since a hook has a timeout and a command node that
 * outlives it strands the run. Long work belongs in a step that shells out.
 */
export interface CommandNode extends NodeBase {
  /** Discriminant. Required, so the union narrows on it. */
  kind: "command";
  /**
   * The command, as a template over the run context.
   *
   * Takes the same two placeholder forms as {@link StepNode.prompt}, resolved
   * the same way and subject to the same dominance rule.
   */
  command: string;
  /** Scalars this node's own command may interpolate as `{{params.key}}`. */
  params?: Record<string, JsonValue>;
  /**
   * Ceiling in milliseconds. The host kills the command past it and treats the
   * node as having failed its contract, which is an error rather than a
   * non-zero exit: a command that never finished did not report anything.
   */
  timeoutMs?: number;
}

/** One node of the graph. */
export type Node = StepNode | CommandNode;

/** Narrowing helper, so callers do not compare against the discriminant by hand. */
export function isCommandNode(node: Node): node is CommandNode {
  return node.kind === "command";
}

/**
 * Exactly what a command node's payload holds.
 *
 * Fixed by the runtime rather than declared by the author, which is what lets a
 * `{{ctx.check.exitCode}}` reference be checked precisely at compile time while
 * the same reference into a step can only be checked against a declared schema.
 */
export const COMMAND_OUTPUT_KEYS: readonly string[] = ["exitCode", "stdout", "stderr"];

/**
 * The template a node interpolates: a step's prompt, a command node's command.
 *
 * One accessor so that every check over interpolation, the placeholder grammar,
 * unknown params, and dominance, applies to both kinds without being written
 * twice and drifting.
 */
export function templateOf(node: Node): string | undefined {
  return isCommandNode(node) ? node.command : node.prompt;
}

// ---------------------------------------------------------------------------
// Payload delivery
// ---------------------------------------------------------------------------

/**
 * Where a step's JSON payload is delivered.
 *
 * `inline` means it rides along with the step's result; `file` means the step
 * wrote it to a path the host assigned. A file is no less a contract than an
 * inline block. The difference is delivery, not structure.
 *
 * The lanes are semantically identical by construction, but not equally robust:
 * the inline lane inherits the host's output size cap and any mangling the host
 * applies to a final message. Prefer `file` for anything large or fragile.
 */
export type PayloadSource = { lane: "inline" } | { lane: "file"; path: string };

/** The default lane when an edge does not name one. */
export const DEFAULT_PAYLOAD_SOURCE: PayloadSource = { lane: "inline" };

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Comparison applied to a field read out of a step's payload. */
export type FieldOp = "truthy" | "equals" | "notEquals" | "matches" | "gt" | "lt";

/**
 * A predicate over a step's result, expressed as data.
 *
 * Mechanical kinds (`exitZero`, `fileExists`, `field`) cost no tokens. `judge`
 * is the single conspicuous escape hatch into model judgment, quarantined so
 * that routing still switches on a typed verdict rather than on prose.
 */
export type Guard =
  /** Unconditional. */
  | { kind: "always" }
  /** Shell command exits 0. */
  | { kind: "exitZero"; command: string }
  /** Path exists on disk. */
  | { kind: "fileExists"; path: string }
  /** A field of the step's JSON payload compares as specified. */
  | {
      kind: "field";
      /** Dot path into the payload, e.g. `findings.count`. */
      path: string;
      op: FieldOp;
      /** Operand. Omitted for `truthy`. */
      value?: JsonValue;
      /** Which lane the payload arrives on. Defaults to inline. */
      from?: PayloadSource;
    }
  /** Model judgment, reduced to one expected verdict. */
  | {
      kind: "judge";
      question: string;
      /** The verdict this edge fires on. */
      is: string;
      /** The closed set of verdicts the judge may return. */
      verdicts?: string[];
      /** Payload lane the judge reads, if it reads one. */
      from?: PayloadSource;
    }
  /** Negation. */
  | { kind: "not"; guard: Guard }
  /** Conjunction. Empty is vacuously true. */
  | { kind: "all"; guards: Guard[] }
  /** Disjunction. Empty is vacuously false. */
  | { kind: "any"; guards: Guard[] };

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** What happens when an edge's guard does not hold. */
export type Otherwise =
  /** Re-run the current node, up to the edge's `limit`. */
  | { kind: "retry"; reason: string }
  /** Divert to another node. */
  | { kind: "goto"; node: NodeId | End };

/**
 * One question put to the user as a run passes through an ask.
 *
 * Shaped after the host's own question tool rather than after something neutral,
 * because every field here has to survive to a real dialog and inventing a
 * middle format would only mean translating twice.
 */
export interface AskQuestion {
  /** The question itself, as the user reads it. */
  question: string;
  /** Short label for the question, for a host that groups or tags them. */
  header: string;
  /** The choices offered. A host may also accept free text. */
  options: { label: string; description?: string }[];
  /** Whether more than one option may be chosen. */
  multiSelect?: boolean;
}

/**
 * Where an ask's questions come from.
 *
 * `static` fixes them at compile time. `output` reads them out of the payload of
 * the step the ask leaves, which is what lets a step compute its own questions:
 * propose the next number it found on disk, offer the branches it discovered,
 * ask only about what it could not resolve.
 */
export type AskQuestions =
  | { kind: "static"; items: AskQuestion[] }
  | { kind: "output"; path: string };

/**
 * A transition that stops to ask the user something and then carries on by
 * itself.
 *
 * Distinct from {@link Edge.gate}, and the difference is the whole point. A
 * gate ends the run segment and waits for a human to type a resume command. An
 * ask hands the questions back to whatever *can* reach the user, takes the
 * answers, and resumes with nobody typing anything.
 *
 * On Claude Code that difference is forced by the platform: a subagent has no
 * `AskUserQuestion` tool and no channel to the terminal, measured on 2.1.232,
 * so the questions have to travel out to the main session and the answers back.
 */
export interface AskSpec {
  /** The questions, fixed or computed. */
  questions: AskQuestions;
  /**
   * The id the answers are recorded under in {@link RunState.outputs}, so a
   * later node reads them as `{{ctx.<as>.<key>}}` like any other output.
   *
   * Its own id rather than the asking node's: a step's payload and the answers
   * to questions it raised are two different things, and overwriting one with
   * the other would lose whichever the next node did not want.
   */
  as: NodeId;
}

/**
 * One row of the Mealy transition table. The key is (`from`, `event`); the
 * output is the destination plus whatever the host is told to do about it.
 */
export interface Edge {
  /**
   * Stable identity, assigned at compile time. Retry counters are keyed by it,
   * so it has to survive recompilation of an unchanged graph.
   */
  id: string;
  from: NodeId;
  /**
   * The discretized input. `"pass"` for a plain edge; for a branch, the verdict
   * label. Carried into the trace so a run reads as a sequence of named events.
   */
  event: string;
  guard: Guard;
  /** Destination when the guard holds. */
  goto: NodeId | End;
  /** What to do when it does not. Absent means fall through to the next edge. */
  otherwise?: Otherwise;
  /** Ceiling on `otherwise: retry` for this edge. */
  limit?: number;
  /**
   * Names the resume command for a human sign-off. A gated edge ends a run
   * segment rather than continuing into `goto`.
   */
  gate?: string;
  /**
   * Questions to put to the user before continuing into `goto`.
   *
   * Unlike `gate`, the run resumes on its own once they are answered. Mutually
   * exclusive with `gate`: one edge cannot both wait for a typed command and
   * carry on by itself.
   */
  ask?: AskSpec;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * A compiled workflow.
 *
 * Nodes and edges are arrays rather than records because declaration order is
 * semantically load-bearing: when several edges out of a node could fire, the
 * first one wins, and that has to be stable across a JSON round trip.
 */
export interface Graph {
  /** Bumped only on a breaking change to these types. */
  irVersion: 1;
  name: string;
  entry: NodeId;
  nodes: Node[];
  edges: Edge[];
  /**
   * Hash over the canonical form of everything above. Stamped into run state so
   * a graph edited mid-run is detected rather than silently resumed against
   * nodes that no longer exist.
   */
  hash: string;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/**
 * State carried between steps.
 *
 * Keyed by `runId`, deliberately not by a session identifier: a run parked at an
 * approval gate has to be resumable from a session that did not start it, and a
 * session-keyed record cannot be found again once that session is gone. The
 * session id, where a host has one, belongs in the trace as a hint, never as
 * the key.
 */
export interface RunState {
  runId: string;
  /** The graph this run started against. Compared on every resume. */
  graphHash: string;
  /** Where the run is now. */
  node: NodeId;
  /**
   * `running` advances normally. `awaiting` is parked at a gate and must survive
   * garbage collection until it is resumed or explicitly expired. `asking` is
   * mid-ask: the questions are out with whatever can reach the user, and the run
   * resumes by itself when the answers come back, with nothing typed.
   */
  status: "running" | "awaiting" | "asking";
  /** The gate being awaited, when status is `awaiting`. */
  gate?: string;
  /** The ask in flight, when status is `asking`. */
  ask?: PendingAsk;
  /**
   * Whether this run answers its own questions instead of putting them to a user.
   *
   * Set once at the start and carried for the life of the run, so a run cannot
   * become unattended halfway through, and so every later decision can see that
   * the answers behind it were invented.
   */
  auto?: boolean;
  /** Retry counts, keyed by edge id. */
  attempts: Record<string, number>;
  /** Total steps taken, against the run-wide ceiling. */
  steps: number;
  /** Each node's resolved payload, forming the context later steps interpolate. */
  outputs: Record<NodeId, JsonValue>;
  /**
   * Scratch space owned entirely by the host. The evaluator never reads it,
   * never writes it, and carries it through untouched.
   *
   * It exists because some observations cannot be resolved in one pass. On Claude
   * Code a natural-language verdict is the clear case: a command hook cannot ask
   * the model anything, and hooks matching the same event run in parallel rather
   * than in sequence, so a prompt hook cannot feed a command hook. The only way
   * to get a verdict is to ask for it and be called again, which means the host
   * needs somewhere durable to record what it has already asked and what came
   * back. Keeping that here, opaque, is what stops it leaking into the evaluator
   * and making the transition function depend on how a value was obtained.
   */
  host?: Record<string, JsonValue>;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Something the host must find out before a transition can be decided.
 *
 * This is the seam that keeps the evaluator pure. Guards describe what they need
 * observed; the host runs the shell command, reads the file, or asks the model;
 * the evaluator sees only resolved values. Requests are deduplicated by `key`,
 * so two edges asking the same judge question cost one model call, not two.
 */
export type ObservationRequest =
  | { key: string; kind: "exitZero"; command: string }
  | { key: string; kind: "fileExists"; path: string }
  | { key: string; kind: "payload"; from: PayloadSource }
  | { key: string; kind: "judge"; question: string; verdicts?: string[]; from: PayloadSource };

/**
 * What the host found.
 *
 * A failed observation is not a false guard. An unreadable file or unparseable
 * payload means the contract was violated, which is a different event from a
 * test that legitimately failed, and it must not be allowed to route quietly
 * down an `otherwise` branch wearing the same clothes.
 */
export type ObservationResult = { ok: true; value: JsonValue } | { ok: false; error: string };

/**
 * An ask that has been raised and not yet answered.
 *
 * `relayed` is the beat counter, and it exists because getting questions from a
 * subagent to the user takes two stops rather than one: the host first has to
 * make the runner say a thing, and only then may it let the runner stop so that
 * thing reaches whatever can ask. Without it the second stop looks exactly like
 * the first and the ask is raised forever.
 */
export interface PendingAsk {
  /** The edge that raised it, so a resume knows where it was going. */
  edge: string;
  /** Where the run continues once the answers are in. */
  to: NodeId | End;
  /** The id the answers are recorded under. */
  as: NodeId;
  /** The questions, already resolved to values. */
  questions: AskQuestion[];
  /** Whether the questions have been handed off to whatever can ask them. */
  relayed: boolean;
  /**
   * Whether the answers come from the runner rather than from a user.
   *
   * Recorded on the ask rather than read from the run, because it decides where
   * the *answers* are looked for, and looking in the wrong place is the one way
   * this can hang.
   */
  auto?: boolean;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Why a run stopped short.
 *
 * `invalid-graph` covers a graph that is structurally impossible to execute even
 * though every individual field typechecks. The builder rejects these at the
 * authoring line, so a compiled graph should never produce one; it exists because
 * the IR is plain data and a second front-end could hand us something the builder
 * would have refused.
 */
export type TransitionErrorCode =
  | "unknown-node"
  | "no-matching-edge"
  | "retry-limit-exceeded"
  | "observation-failed"
  | "graph-hash-mismatch"
  | "step-ceiling-exceeded"
  | "invalid-graph";

/**
 * The evaluator's verdict: what the host should do next, and the state to
 * persist. `state` is always a fresh object; the input state is never mutated.
 */
export type Transition =
  /** Move to `to`. */
  | { kind: "advance"; to: NodeId; via: string; event: string; state: RunState }
  /** Re-run the current node with a reason to hand it. */
  | { kind: "retry"; node: NodeId; via: string; reason: string; attempt: number; state: RunState }
  /** Park for human sign-off. The run segment ends here. */
  | { kind: "gate"; gate: string; to: NodeId | End; via: string; state: RunState }
  /**
   * Put questions to the user and resume automatically once they are answered.
   * The host is responsible for the delivery; the run is not over.
   */
  | {
      kind: "ask";
      questions: AskQuestion[];
      as: NodeId;
      to: NodeId | End;
      via: string;
      state: RunState;
    }
  /** Terminal. */
  | { kind: "end"; via: string; state: RunState }
  /** Stop and report. */
  | { kind: "error"; code: TransitionErrorCode; message: string; state: RunState };
