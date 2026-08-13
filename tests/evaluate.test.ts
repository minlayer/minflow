import { describe, expect, it } from "vitest";

import { evaluate, observationKey, observationsFor } from "../src/evaluate.js";
import type {
  FieldOp,
  Guard,
  IrEdge,
  JsonValue,
  ObservationResult,
  RunState,
  WorkflowIr,
} from "../src/ir.js";
import { DEFAULT_PAYLOAD_SOURCE, END } from "../src/ir.js";

// ---------------------------------------------------------------------------
// Fixtures: plain object literals, deliberately built without the builder so
// the evaluator is provably independent of it.
// ---------------------------------------------------------------------------

const HASH = "graph-hash-1";

function makeIr(edges: IrEdge[], nodeIds: string[] = ["a", "b", "c"]): WorkflowIr {
  return {
    irVersion: 1,
    name: "wf",
    entry: nodeIds[0] ?? "a",
    nodes: nodeIds.map((id) => ({ id, skill: `skill-${id}` })),
    edges,
    hash: HASH,
  };
}

/** Give one node an output contract, leaving the rest of the fixture alone. */
function withNodeSchema(ir: WorkflowIr, id: string, schema: JsonValue): WorkflowIr {
  return {
    ...ir,
    nodes: ir.nodes.map((node) => (node.id === id ? { ...node, schema } : node)),
  };
}

interface StateOverrides {
  node?: string;
  steps?: number;
  status?: "running" | "awaiting";
  gate?: string;
  attempts?: Record<string, number>;
  outputs?: Record<string, JsonValue>;
  graphHash?: string;
}

function makeState(over: StateOverrides = {}): RunState {
  const state: RunState = {
    runId: "run-1",
    graphHash: over.graphHash ?? HASH,
    node: over.node ?? "a",
    status: over.status ?? "running",
    attempts: over.attempts ?? {},
    steps: over.steps ?? 0,
    outputs: over.outputs ?? {},
  };
  // Written only when asked for: a state carrying `gate: undefined` is not
  // `toEqual` a state with no `gate` key at all, so every existing fixture
  // comparison would change meaning if this were assigned unconditionally.
  if (over.gate !== undefined) state.gate = over.gate;
  return state;
}

/** Deep copy, for snapshotting inputs before a call. Every fixture is JSON. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function field(path: string, op: FieldOp, value?: JsonValue): Guard {
  return value === undefined ? { kind: "field", path, op } : { kind: "field", path, op, value };
}

const PAYLOAD_KEY = observationKey({ kind: "payload", from: DEFAULT_PAYLOAD_SOURCE });

function withPayload(value: JsonValue): Record<string, ObservationResult> {
  return { [PAYLOAD_KEY]: { ok: true, value } };
}

/** One edge, advancing to `b` when the guard holds and to `c` when it does not. */
function guardGraph(guard: Guard): WorkflowIr {
  return makeIr([
    {
      id: "e1",
      from: "a",
      event: "pass",
      guard,
      goto: "b",
      otherwise: { kind: "goto", node: "c" },
    },
  ]);
}

/**
 * Run a single guard through the real evaluator and report only whether it
 * held. The edge always advances: to `b` when the guard holds, to `c` through
 * its `otherwise`, so the three outcomes stay distinguishable.
 */
function decide(
  guard: Guard,
  resolved: Record<string, ObservationResult> = {},
): "hold" | "fail" | "error" {
  const transition = evaluate(guardGraph(guard), makeState(), resolved);
  if (transition.kind === "error") return "error";
  if (transition.kind === "advance") return transition.to === "b" ? "hold" : "fail";
  throw new Error(`unexpected transition kind: ${transition.kind}`);
}

/**
 * The message behind a {@link decide} of `"error"`. A composite has to surface
 * the failure of the sub-guard that could not be decided, rather than a generic
 * one of its own, or the host is told a transition failed without being told
 * which observation to go and fix.
 */
function errorMessage(guard: Guard, resolved: Record<string, ObservationResult> = {}): string {
  const transition = evaluate(guardGraph(guard), makeState(), resolved);
  if (transition.kind !== "error") throw new Error(`expected error, got ${transition.kind}`);
  return transition.message;
}

const ALWAYS: Guard = { kind: "always" };
const NEVER: Guard = { kind: "not", guard: { kind: "always" } };

// A judge and a mechanical sibling, shared by the nested-composite tests. The
// builder compiles `when.all(when.exitZero(...), judge(...).is(...))` to exactly
// this shape; these fixtures are what drives that shape through the evaluator.
type JudgeGuard = Extract<Guard, { kind: "judge" }>;

const REVIEW_QUESTION = "Is the review clean?";
const REVIEW_VERDICTS = ["clean", "dirty"];
const JUDGE_CLEAN: JudgeGuard = {
  kind: "judge",
  question: REVIEW_QUESTION,
  is: "clean",
  verdicts: REVIEW_VERDICTS,
};
const JUDGE_KEY = observationKey({
  kind: "judge",
  question: REVIEW_QUESTION,
  verdicts: REVIEW_VERDICTS,
  from: DEFAULT_PAYLOAD_SOURCE,
});
const TESTS_PASS: Guard = { kind: "exitZero", command: "npm test" };
const TESTS_PASS_KEY = observationKey({ kind: "exitZero", command: "npm test" });

// ---------------------------------------------------------------------------
// observationKey
// ---------------------------------------------------------------------------

describe("observationKey", () => {
  it("is stable under source property order", () => {
    const a = observationKey({
      kind: "judge",
      question: "Are there unresolved findings?",
      verdicts: ["yes", "no"],
      from: { lane: "file", path: "out/review.json" },
    });
    const b = observationKey({
      from: { path: "out/review.json", lane: "file" },
      verdicts: ["yes", "no"],
      question: "Are there unresolved findings?",
      kind: "judge",
    });
    expect(a).toBe(b);
  });

  it("separates different questions, commands, paths and lanes", () => {
    const inline = observationKey({ kind: "payload", from: { lane: "inline" } });
    const file = observationKey({ kind: "payload", from: { lane: "file", path: "p.json" } });
    const other = observationKey({ kind: "payload", from: { lane: "file", path: "q.json" } });
    expect(new Set([inline, file, other]).size).toBe(3);

    expect(observationKey({ kind: "exitZero", command: "npm test" })).not.toBe(
      observationKey({ kind: "exitZero", command: "npm run lint" }),
    );
    expect(observationKey({ kind: "fileExists", path: "notes.md" })).not.toBe(
      observationKey({ kind: "fileExists", path: "plan.md" }),
    );
  });

  it("does not collide across kinds that share an operand", () => {
    expect(observationKey({ kind: "exitZero", command: "notes.md" })).not.toBe(
      observationKey({ kind: "fileExists", path: "notes.md" }),
    );
  });

  // Pinned literals, not a self-comparison. The key is a wire format: the host
  // caches observations under it and hands the results back in a map the
  // evaluator looks up by the same key, so a silent change to the format
  // silently breaks every cache and every host that records one. Asserting
  // `f(x) === f(x)` would hold for any deterministic implementation, including
  // one that returned a constant, so it protects nothing.
  it("has a pinned, stable format for every kind", () => {
    expect(observationKey({ kind: "exitZero", command: "npm test" })).toBe(
      'exitZero:{"command":"npm test"}',
    );
    expect(observationKey({ kind: "fileExists", path: "notes.md" })).toBe(
      'fileExists:{"path":"notes.md"}',
    );
    expect(observationKey({ kind: "payload", from: DEFAULT_PAYLOAD_SOURCE })).toBe(
      'payload:{"from":{"lane":"inline"}}',
    );
    expect(observationKey({ kind: "payload", from: { lane: "file", path: "out.json" } })).toBe(
      'payload:{"from":{"lane":"file","path":"out.json"}}',
    );
    expect(observationKey({ kind: "judge", question: "ok?", from: DEFAULT_PAYLOAD_SOURCE })).toBe(
      'judge:{"from":{"lane":"inline"},"question":"ok?"}',
    );
    expect(
      observationKey({
        kind: "judge",
        question: "ok?",
        verdicts: ["yes", "no"],
        from: { lane: "file", path: "r.json" },
      }),
    ).toBe(
      'judge:{"from":{"lane":"file","path":"r.json"},"question":"ok?","verdicts":["yes","no"]}',
    );
  });
});

// ---------------------------------------------------------------------------
// observationsFor
// ---------------------------------------------------------------------------

describe("observationsFor", () => {
  it("enumerates one request per leaf guard, across every edge out of the node", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "b",
      },
      {
        id: "e2",
        from: "a",
        event: "alt",
        guard: { kind: "fileExists", path: "notes.md" },
        goto: "c",
      },
      {
        id: "e3",
        from: "b",
        event: "pass",
        guard: { kind: "exitZero", command: "never-seen" },
        goto: "c",
      },
    ]);
    const requests = observationsFor(graph, makeState());
    expect(requests.map((r) => r.kind)).toEqual(["exitZero", "fileExists"]);
    expect(requests.some((r) => r.kind === "exitZero" && r.command === "never-seen")).toBe(false);
  });

  it("returns nothing for a node with no outgoing edges", () => {
    const graph = makeIr([{ id: "e1", from: "b", event: "pass", guard: ALWAYS, goto: "c" }]);
    expect(observationsFor(graph, makeState())).toEqual([]);
  });

  it("emits nothing for always / not / all / any beyond their leaves", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" },
      {
        id: "e2",
        from: "a",
        event: "alt",
        guard: {
          kind: "not",
          guard: {
            kind: "all",
            guards: [
              { kind: "any", guards: [{ kind: "fileExists", path: "deep.md" }] },
              { kind: "exitZero", command: "deep test" },
            ],
          },
        },
        goto: "c",
      },
    ]);
    const requests = observationsFor(graph, makeState());
    expect(requests.map((r) => r.kind)).toEqual(["fileExists", "exitZero"]);
  });

  it("maps a field guard to a payload request on its lane, defaulting to inline", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: field("count", "gt", 0), goto: "b" },
      {
        id: "e2",
        from: "a",
        event: "alt",
        guard: { kind: "field", path: "x", op: "truthy", from: { lane: "file", path: "out.json" } },
        goto: "c",
      },
    ]);
    const requests = observationsFor(graph, makeState());
    expect(requests).toEqual([
      { key: PAYLOAD_KEY, kind: "payload", from: DEFAULT_PAYLOAD_SOURCE },
      {
        key: observationKey({ kind: "payload", from: { lane: "file", path: "out.json" } }),
        kind: "payload",
        from: { lane: "file", path: "out.json" },
      },
    ]);
  });

  it("deduplicates by key, keeping first-encountered order", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: field("a", "truthy"), goto: "b" },
      {
        id: "e2",
        from: "a",
        event: "alt",
        guard: {
          kind: "all",
          guards: [field("b", "truthy"), { kind: "exitZero", command: "npm test" }],
        },
        goto: "c",
      },
      {
        id: "e3",
        from: "a",
        event: "third",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "c",
      },
    ]);
    const requests = observationsFor(graph, makeState());
    expect(requests.map((r) => r.kind)).toEqual(["payload", "exitZero"]);
    expect(new Set(requests.map((r) => r.key)).size).toBe(2);
  });

  it("collapses a branch's two judge edges into ONE observation (the key omits `is`)", () => {
    const question = "Are there unresolved findings?";
    const graph = makeIr(
      [
        {
          id: "e1",
          from: "a",
          event: "yes",
          guard: { kind: "judge", question, is: "yes", verdicts: ["yes", "no"] },
          goto: "b",
        },
        {
          id: "e2",
          from: "a",
          event: "no",
          guard: { kind: "judge", question, is: "no", verdicts: ["yes", "no"] },
          goto: "c",
        },
      ],
      ["a", "b", "c"],
    );
    const requests = observationsFor(graph, makeState());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      key: observationKey({
        kind: "judge",
        question,
        verdicts: ["yes", "no"],
        from: DEFAULT_PAYLOAD_SOURCE,
      }),
      kind: "judge",
      question,
      verdicts: ["yes", "no"],
      from: DEFAULT_PAYLOAD_SOURCE,
    });
    expect(JSON.stringify(requests[0])).not.toContain('"is"');
  });

  it("reaches a judge nested under all / any / not, and dedups it against its siblings", () => {
    // A composite is the only place collection and evaluation could disagree
    // about a judge's key, and disagreeing is expensive in both directions: the
    // host either pays for a model call nobody looks up, or looks up a verdict
    // nobody asked the model for and reports the transition as broken.
    // The judge is reached first through `not`, so the expected order below
    // holds only if collection descends into all three composites: `not`
    // contributes the judge, `all` the command, `any` the path, and the two
    // later judges collapse onto the first.
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "dirty",
        // Same question, other expected verdict. `is` belongs to the edge and
        // not to the question, so e2's and e3's judges collapse onto this one.
        guard: { kind: "not", guard: { ...JUDGE_CLEAN, is: "dirty" } },
        goto: "c",
      },
      {
        id: "e2",
        from: "a",
        event: "clean",
        guard: { kind: "all", guards: [TESTS_PASS, JUDGE_CLEAN] },
        goto: "b",
      },
      {
        id: "e3",
        from: "a",
        event: "alt",
        guard: {
          kind: "any",
          guards: [{ kind: "fileExists", path: "notes.md" }, JUDGE_CLEAN],
        },
        goto: "c",
      },
    ]);
    expect(observationsFor(graph, makeState())).toEqual([
      {
        key: JUDGE_KEY,
        kind: "judge",
        question: REVIEW_QUESTION,
        verdicts: REVIEW_VERDICTS,
        from: DEFAULT_PAYLOAD_SOURCE,
      },
      { key: TESTS_PASS_KEY, kind: "exitZero", command: "npm test" },
      {
        key: observationKey({ kind: "fileExists", path: "notes.md" }),
        kind: "fileExists",
        path: "notes.md",
      },
    ]);
  });

  it("omits verdicts from the request when the guard omits them", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "yes",
        guard: { kind: "judge", question: "q?", is: "yes" },
        goto: "b",
      },
    ]);
    const requests = observationsFor(graph, makeState());
    expect(requests[0]).toEqual({
      key: observationKey({ kind: "judge", question: "q?", from: DEFAULT_PAYLOAD_SOURCE }),
      kind: "judge",
      question: "q?",
      from: DEFAULT_PAYLOAD_SOURCE,
    });
    expect(Object.hasOwn(requests[0] ?? {}, "verdicts")).toBe(false);
  });

  it("is pure: repeated calls are identical and the state is untouched", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "b",
      },
    ]);
    const state = makeState({ attempts: { e1: 2 }, outputs: { a: { n: 1 } } });
    const snapshot = clone(state);
    // Against a literal, not against a second call: comparing the function to
    // itself would pass for an implementation that always returned `[]`.
    const expected = [
      {
        key: observationKey({ kind: "exitZero", command: "npm test" }),
        kind: "exitZero",
        command: "npm test",
      },
    ];
    expect(observationsFor(graph, state)).toEqual(expected);
    expect(observationsFor(graph, state)).toEqual(expected);
    expect(state).toEqual(snapshot);
  });

  // A step's payload reaches `outputs` only through a resolved payload
  // observation, so a node that declares a schema has to be asked for one even
  // when nothing about its outgoing guards needs a payload. Otherwise the
  // output contract is declared and never collected.
  describe("a node declaring a schema", () => {
    it("gets a payload observation even when every guard is payload-free", () => {
      const graph = withNodeSchema(
        makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]),
        "a",
        { type: "object", properties: { notes: { type: "string" } } },
      );
      expect(observationsFor(graph, makeState())).toEqual([
        { key: PAYLOAD_KEY, kind: "payload", from: DEFAULT_PAYLOAD_SOURCE },
      ]);
    });

    it("is deduplicated against a guard already reading the same lane", () => {
      const graph = withNodeSchema(
        makeIr([{ id: "e1", from: "a", event: "pass", guard: field("n", "gt", 0), goto: "b" }]),
        "a",
        { type: "object" },
      );
      expect(observationsFor(graph, makeState())).toEqual([
        { key: PAYLOAD_KEY, kind: "payload", from: DEFAULT_PAYLOAD_SOURCE },
      ]);
    });

    it("adds the default lane after a guard's explicitly named one", () => {
      const from = { lane: "file", path: "out.json" } as const;
      const graph = withNodeSchema(
        makeIr([
          {
            id: "e1",
            from: "a",
            event: "pass",
            guard: { kind: "field", path: "n", op: "truthy", from },
            goto: "b",
          },
        ]),
        "a",
        { type: "object" },
      );
      expect(observationsFor(graph, makeState())).toEqual([
        { key: observationKey({ kind: "payload", from }), kind: "payload", from },
        { key: PAYLOAD_KEY, kind: "payload", from: DEFAULT_PAYLOAD_SOURCE },
      ]);
    });

    it("only applies to the node the run is at", () => {
      const graph = withNodeSchema(
        makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]),
        "b",
        { type: "object" },
      );
      expect(observationsFor(graph, makeState())).toEqual([]);
    });
  });

  it("requests no payload for a node with neither a schema nor a payload-reading guard", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "b",
      },
      {
        id: "e2",
        from: "a",
        event: "alt",
        guard: { kind: "fileExists", path: "notes.md" },
        goto: "c",
      },
    ]);
    expect(observationsFor(graph, makeState()).map((r) => r.kind)).toEqual([
      "exitZero",
      "fileExists",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule 1-3: preconditions, in order
// ---------------------------------------------------------------------------

describe("evaluate preconditions", () => {
  it("rule 1: reports graph-hash-mismatch when the run started against another graph", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    const transition = evaluate(graph, makeState({ graphHash: "stale" }), {});
    expect(transition.kind).toBe("error");
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("graph-hash-mismatch");
  });

  it("rule 1: the hash check runs FIRST, before the node and ceiling checks", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    const transition = evaluate(
      graph,
      makeState({ graphHash: "stale", node: "ghost", steps: 99_999 }),
      {},
    );
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("graph-hash-mismatch");
  });

  it("rule 2: reports unknown-node, and does so before the ceiling check", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    const transition = evaluate(graph, makeState({ node: "ghost", steps: 99_999 }), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("unknown-node");
    expect(transition.message).toContain("ghost");
  });

  it("rule 3: the default step ceiling is 1000, inclusive", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    expect(evaluate(graph, makeState({ steps: 999 }), {}).kind).toBe("advance");

    const at = evaluate(graph, makeState({ steps: 1000 }), {});
    if (at.kind !== "error") throw new Error("expected error");
    expect(at.code).toBe("step-ceiling-exceeded");
    // The ceiling the run was actually held to, named in the message. Reporting
    // the wrong number sends whoever raises it to the wrong knob.
    expect(at.message).toContain("ceiling of 1000");
  });

  it("rule 3: opts.stepCeiling overrides the default", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    expect(evaluate(graph, makeState({ steps: 1 }), {}, { stepCeiling: 3 }).kind).toBe("advance");
    const at = evaluate(graph, makeState({ steps: 3 }), {}, { stepCeiling: 3 });
    if (at.kind !== "error") throw new Error("expected error");
    expect(at.code).toBe("step-ceiling-exceeded");
    // Was `toContain("3")`, which the step count alone satisfied and which the
    // default ceiling of 1000 would not have contradicted.
    expect(at.message).toContain("ceiling of 3");
  });
});

// ---------------------------------------------------------------------------
// Rule 4: declaration order
// ---------------------------------------------------------------------------

describe("edge selection", () => {
  it("rule 4: the first edge whose guard holds wins", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "first", guard: ALWAYS, goto: "b" },
      { id: "e2", from: "a", event: "second", guard: ALWAYS, goto: "c" },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.via).toBe("e1");
    expect(transition.to).toBe("b");
    expect(transition.event).toBe("first");
  });

  it("rule 4: reversing declaration order reverses the winner", () => {
    const graph = makeIr([
      { id: "e2", from: "a", event: "second", guard: ALWAYS, goto: "c" },
      { id: "e1", from: "a", event: "first", guard: ALWAYS, goto: "b" },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.via).toBe("e2");
  });

  it("rule 4: edges from other nodes are never considered", () => {
    const graph = makeIr([
      { id: "e1", from: "b", event: "pass", guard: ALWAYS, goto: "c" },
      { id: "e2", from: "a", event: "pass", guard: ALWAYS, goto: "c" },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.via).toBe("e2");
  });

  it("rule 9: no edge holds and none declares an otherwise", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: NEVER, goto: "b" },
      { id: "e2", from: "a", event: "alt", guard: NEVER, goto: "c" },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("no-matching-edge");
  });

  it("rule 9: a node with no outgoing edges at all is a no-matching-edge", () => {
    const graph = makeIr([{ id: "e1", from: "b", event: "pass", guard: ALWAYS, goto: "c" }]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("no-matching-edge");
  });
});

// ---------------------------------------------------------------------------
// Rule 5: a broken contract is not a false guard
// ---------------------------------------------------------------------------

describe("observation failures", () => {
  const graph = makeIr([
    {
      id: "e1",
      from: "a",
      event: "pass",
      guard: { kind: "exitZero", command: "npm test" },
      goto: "b",
      otherwise: { kind: "retry", reason: "tests failing" },
      limit: 3,
    },
  ]);
  const key = observationKey({ kind: "exitZero", command: "npm test" });

  it("rule 5: a key missing from `resolved` is an error naming the key", () => {
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("observation-failed");
    expect(transition.message).toContain(key);
  });

  it("rule 5: an { ok: false } result carries the host's error through", () => {
    const transition = evaluate(graph, makeState(), {
      [key]: { ok: false, error: "spawning the shell failed: ENOENT" },
    });
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("observation-failed");
    expect(transition.message).toContain(key);
    expect(transition.message).toContain("ENOENT");
  });

  it("rule 5: a failed observation never routes down `otherwise`", () => {
    const failed = evaluate(graph, makeState(), { [key]: { ok: false, error: "boom" } });
    expect(failed.kind).toBe("error");
    expect(failed.state.attempts).toEqual({});

    const honest = evaluate(graph, makeState(), { [key]: { ok: true, value: false } });
    expect(honest.kind).toBe("retry");
  });

  it("rule 5: a failed observation on an early edge is not shadowed by a later one", () => {
    const both = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "b",
      },
      { id: "e2", from: "a", event: "alt", guard: ALWAYS, goto: "c" },
    ]);
    const transition = evaluate(both, makeState(), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("observation-failed");
  });
});

// ---------------------------------------------------------------------------
// Rule 6: guard semantics
// ---------------------------------------------------------------------------

describe("guard semantics", () => {
  it("always holds", () => {
    expect(decide(ALWAYS)).toBe("hold");
  });

  it("exitZero holds only on boolean true", () => {
    const key = observationKey({ kind: "exitZero", command: "npm test" });
    const guard: Guard = { kind: "exitZero", command: "npm test" };
    expect(decide(guard, { [key]: { ok: true, value: true } })).toBe("hold");
    expect(decide(guard, { [key]: { ok: true, value: false } })).toBe("fail");
    expect(decide(guard, { [key]: { ok: true, value: 0 } })).toBe("fail");
    expect(decide(guard, {})).toBe("error");
  });

  it("fileExists holds only on boolean true", () => {
    const key = observationKey({ kind: "fileExists", path: "notes.md" });
    const guard: Guard = { kind: "fileExists", path: "notes.md" };
    expect(decide(guard, { [key]: { ok: true, value: true } })).toBe("hold");
    expect(decide(guard, { [key]: { ok: true, value: false } })).toBe("fail");
    expect(decide(guard, {})).toBe("error");
  });

  describe("judge", () => {
    const question = "Are there unresolved findings?";
    const key = observationKey({
      kind: "judge",
      question,
      verdicts: ["yes", "no"],
      from: DEFAULT_PAYLOAD_SOURCE,
    });
    const guard: Guard = { kind: "judge", question, is: "yes", verdicts: ["yes", "no"] };

    it("holds when the verdict equals `is`", () => {
      expect(decide(guard, { [key]: { ok: true, value: "yes" } })).toBe("hold");
    });

    it("fails when the verdict is another declared verdict", () => {
      expect(decide(guard, { [key]: { ok: true, value: "no" } })).toBe("fail");
    });

    it("errors when the verdict is outside the declared set", () => {
      expect(decide(guard, { [key]: { ok: true, value: "maybe" } })).toBe("error");
    });

    // A verdict is a string. A non-string is a broken judge contract, and the
    // membership test must be on the value rather than on `String(value)`:
    // `1` and `true` stringify into a declared set of `["1"]` or `["true"]`,
    // pass the membership check, then fail the `===` against `is` and route
    // quietly down `otherwise`, a violated contract wearing the clothes of a
    // verdict that legitimately did not match.
    const nonStrings: Array<[string, JsonValue]> = [
      ["a boolean", true],
      ["a number", 1],
      ["null", null],
      ["an object", { verdict: "yes" }],
      ["an array", ["yes"]],
    ];

    for (const [name, value] of nonStrings) {
      it(`observation-fails on ${name} rather than routing`, () => {
        expect(decide(guard, { [key]: { ok: true, value } })).toBe("error");
      });
    }

    it("observation-fails on a non-string whose String() form IS a declared verdict", () => {
      const stringy: Guard = { kind: "judge", question, is: "1", verdicts: ["1", "0"] };
      const stringyKey = observationKey({
        kind: "judge",
        question,
        verdicts: ["1", "0"],
        from: DEFAULT_PAYLOAD_SOURCE,
      });
      expect(decide(stringy, { [stringyKey]: { ok: true, value: 1 } })).toBe("error");
      expect(decide(stringy, { [stringyKey]: { ok: true, value: 0 } })).toBe("error");
    });

    it("observation-fails on a non-string even with no declared verdict set", () => {
      const open: Guard = { kind: "judge", question, is: "yes" };
      const openKey = observationKey({ kind: "judge", question, from: DEFAULT_PAYLOAD_SOURCE });
      expect(decide(open, { [openKey]: { ok: true, value: true } })).toBe("error");
    });

    it("names the offending value in the error", () => {
      const graph = makeIr([
        {
          id: "e1",
          from: "a",
          event: "yes",
          guard,
          goto: "b",
          otherwise: { kind: "goto", node: "c" },
        },
      ]);
      const transition = evaluate(graph, makeState(), { [key]: { ok: true, value: 1 } });
      if (transition.kind !== "error") throw new Error("expected error");
      expect(transition.code).toBe("observation-failed");
      // "returned 1" rather than "1": the bare digit would be satisfied by any
      // message that merely happened to contain one, including one that dropped
      // the offending value entirely and left the reader nothing to debug.
      expect(transition.message).toContain("returned 1");
      expect(transition.message).toContain("string");
    });

    it("compares by equality when no verdict set is declared", () => {
      const open: Guard = { kind: "judge", question, is: "yes" };
      const openKey = observationKey({ kind: "judge", question, from: DEFAULT_PAYLOAD_SOURCE });
      expect(decide(open, { [openKey]: { ok: true, value: "yes" } })).toBe("hold");
      expect(decide(open, { [openKey]: { ok: true, value: "anything" } })).toBe("fail");
    });

    it("errors when the observation is missing", () => {
      expect(decide(guard, {})).toBe("error");
    });
  });

  describe("field", () => {
    const payload: JsonValue = {
      flag: true,
      zero: 0,
      empty: "",
      n: 5,
      s: "hello world",
      nul: null,
      nested: { deep: { v: "x" } },
      arr: [{ name: "first" }, { name: "second" }],
    };
    const resolved = withPayload(payload);

    const cases: Array<[string, Guard, "hold" | "fail"]> = [
      ["truthy on true", field("flag", "truthy"), "hold"],
      ["truthy on 0", field("zero", "truthy"), "fail"],
      ["truthy on empty string", field("empty", "truthy"), "fail"],
      ["truthy on null", field("nul", "truthy"), "fail"],
      ["equals number", field("n", "equals", 5), "hold"],
      ["equals wrong number", field("n", "equals", 6), "fail"],
      ["equals null", field("nul", "equals", null), "hold"],
      ["equals structurally", field("nested", "equals", { deep: { v: "x" } }), "hold"],
      ["notEquals", field("n", "notEquals", 6), "hold"],
      ["notEquals on match", field("n", "notEquals", 5), "fail"],
      // `value` is optional on the IR's field guard, so `equals` with no
      // operand compares a present field against `undefined`, which is outside
      // JsonValue and therefore equals nothing, not even a field that is
      // present and null. Comparing the two canonically instead would collapse
      // `undefined` and `null` onto the same string and make this hold, so a
      // guard authored without an operand would silently match every null.
      ["equals with no operand, on a null field", field("nul", "equals"), "fail"],
      ["equals with no operand, on a present field", field("flag", "equals"), "fail"],
      ["notEquals with no operand, on a null field", field("nul", "notEquals"), "hold"],
      ["matches", field("s", "matches", "^hello"), "hold"],
      ["matches, no match", field("s", "matches", "^world"), "fail"],
      ["matches on a non-string", field("n", "matches", "5"), "fail"],
      // A malformed pattern is an authoring bug for the linter, not a broken
      // host contract. `new RegExp("[")` throws, so without the try/catch that
      // implements the rule this case escapes as an exception rather than
      // returning a verdict, and the run dies.
      ["matches on a malformed pattern", field("s", "matches", "["), "fail"],
      ["matches on a malformed pattern, unterminated group", field("s", "matches", "(a"), "fail"],
      ["matches on a non-string pattern", field("s", "matches", 5), "fail"],
      ["gt", field("n", "gt", 3), "hold"],
      ["gt on equal", field("n", "gt", 5), "fail"],
      ["gt on a non-number", field("s", "gt", 3), "fail"],
      ["lt", field("n", "lt", 9), "hold"],
      ["lt on equal", field("n", "lt", 5), "fail"],
      ["dot path", field("nested.deep.v", "equals", "x"), "hold"],
      ["array index", field("arr.1.name", "equals", "second"), "hold"],
    ];

    for (const [name, guard, expected] of cases) {
      it(name, () => {
        expect(decide(guard, resolved)).toBe(expected);
      });
    }

    const absent: Array<[FieldOp, "hold" | "fail"]> = [
      ["truthy", "fail"],
      ["equals", "fail"],
      ["notEquals", "hold"],
      ["matches", "fail"],
      ["gt", "fail"],
      ["lt", "fail"],
    ];

    for (const [op, expected] of absent) {
      it(`an absent path yields ${expected === "hold"} for ${op}`, () => {
        expect(decide(field("missing.deeply", op, "anything"), resolved)).toBe(expected);
      });
    }

    it("notEquals on an absent path is deliberately true", () => {
      expect(decide(field("nope", "notEquals", "x"), resolved)).toBe("hold");
      expect(decide(field("arr.9.name", "notEquals", "x"), resolved)).toBe("hold");
    });

    it("treats inherited object properties as absent", () => {
      expect(decide(field("constructor", "truthy"), resolved)).toBe("fail");
      expect(decide(field("nested.toString", "truthy"), resolved)).toBe("fail");
    });

    it("errors when the payload observation is missing or failed", () => {
      expect(decide(field("n", "equals", 5), {})).toBe("error");
      expect(
        decide(field("n", "equals", 5), { [PAYLOAD_KEY]: { ok: false, error: "bad json" } }),
      ).toBe("error");
    });

    it("reads the lane the guard names", () => {
      const fileKey = observationKey({ kind: "payload", from: { lane: "file", path: "out.json" } });
      const guard: Guard = {
        kind: "field",
        path: "n",
        op: "equals",
        value: 5,
        from: { lane: "file", path: "out.json" },
      };
      expect(decide(guard, { [fileKey]: { ok: true, value: payload } })).toBe("hold");
      expect(decide(guard, resolved)).toBe("error");
    });
  });

  describe("not / all / any", () => {
    it("not inverts", () => {
      expect(decide({ kind: "not", guard: ALWAYS })).toBe("fail");
      expect(decide({ kind: "not", guard: NEVER })).toBe("hold");
    });

    it("all([]) is true and any([]) is false", () => {
      expect(decide({ kind: "all", guards: [] })).toBe("hold");
      expect(decide({ kind: "any", guards: [] })).toBe("fail");
    });

    it("all requires every guard; any requires one", () => {
      expect(decide({ kind: "all", guards: [ALWAYS, ALWAYS] })).toBe("hold");
      expect(decide({ kind: "all", guards: [ALWAYS, NEVER] })).toBe("fail");
      expect(decide({ kind: "any", guards: [NEVER, ALWAYS] })).toBe("hold");
      expect(decide({ kind: "any", guards: [NEVER, NEVER] })).toBe("fail");
    });

    it("evaluates a deeply nested tree", () => {
      const payloadResolved = withPayload({ findings: { count: 2 }, verdict: "dirty" });
      const testsKey = observationKey({ kind: "exitZero", command: "npm test" });
      const resolved: Record<string, ObservationResult> = {
        ...payloadResolved,
        [testsKey]: { ok: true, value: false },
      };

      // not( all( any( count > 5, verdict == "dirty" ), not( tests pass ) ) )
      const tree: Guard = {
        kind: "not",
        guard: {
          kind: "all",
          guards: [
            {
              kind: "any",
              guards: [field("findings.count", "gt", 5), field("verdict", "equals", "dirty")],
            },
            { kind: "not", guard: { kind: "exitZero", command: "npm test" } },
          ],
        },
      };
      // any -> true, not(exitZero=false) -> true, all -> true, not -> false
      expect(decide(tree, resolved)).toBe("fail");

      const passing: Record<string, ObservationResult> = {
        ...payloadResolved,
        [testsKey]: { ok: true, value: true },
      };
      // not(exitZero=true) -> false, all -> false, not -> true
      expect(decide(tree, passing)).toBe("hold");
    });

    it("propagates a failed observation through not", () => {
      expect(decide({ kind: "not", guard: { kind: "fileExists", path: "x" } })).toBe("error");
    });

    it("errors when an unresolved branch could change the answer", () => {
      const missing: Guard = { kind: "fileExists", path: "x" };
      expect(decide({ kind: "all", guards: [ALWAYS, missing] })).toBe("error");
      expect(decide({ kind: "any", guards: [NEVER, missing] })).toBe("error");
    });

    it("suppresses a failed observation only when it cannot change the answer", () => {
      const missing: Guard = { kind: "fileExists", path: "x" };
      expect(decide({ kind: "all", guards: [NEVER, missing] })).toBe("fail");
      expect(decide({ kind: "all", guards: [missing, NEVER] })).toBe("fail");
      expect(decide({ kind: "any", guards: [ALWAYS, missing] })).toBe("hold");
      expect(decide({ kind: "any", guards: [missing, ALWAYS] })).toBe("hold");
    });

    // A judge under a composite is the shape the builder compiles for
    // `when.all(when.exitZero(...), judge(...).is(...))` and `when.not(judge())`.
    // The builder tests pin that compiled shape; these drive it, so the verdict
    // is the thing routing rather than a fixture that could not be wrong.
    describe("with a judge nested inside", () => {
      function withVerdict(verdict: JsonValue): Record<string, ObservationResult> {
        return { [JUDGE_KEY]: { ok: true, value: verdict } };
      }
      function withTests(passed: boolean): Record<string, ObservationResult> {
        return { [TESTS_PASS_KEY]: { ok: true, value: passed } };
      }

      const ALL: Guard = { kind: "all", guards: [TESTS_PASS, JUDGE_CLEAN] };
      const ANY: Guard = { kind: "any", guards: [TESTS_PASS, JUDGE_CLEAN] };
      const NOT: Guard = { kind: "not", guard: JUDGE_CLEAN };
      // The same two composites with the arms swapped. Kleene combination is
      // specified to be order-independent, so every answer below has to survive
      // the judge being written first as well as second.
      const ALL_FLIPPED: Guard = { kind: "all", guards: [JUDGE_CLEAN, TESTS_PASS] };
      const ANY_FLIPPED: Guard = { kind: "any", guards: [JUDGE_CLEAN, TESTS_PASS] };

      // (guard, did the shell command pass, what the model answered, route)
      const routed: Array<[string, Guard, boolean, string, "hold" | "fail"]> = [
        ["all: both arms hold", ALL, true, "clean", "hold"],
        // The mechanical arm holds, so the verdict alone moves the answer.
        ["all: the judge is the deciding arm", ALL, true, "dirty", "fail"],
        ["all: the mechanical arm decides", ALL, false, "clean", "fail"],
        // The mechanical arm fails, so again the verdict alone moves it.
        ["any: the judge is the deciding arm", ANY, false, "clean", "hold"],
        ["any: neither arm holds", ANY, false, "dirty", "fail"],
        ["any: the mechanical arm decides", ANY, true, "dirty", "hold"],
        ["not: a matching verdict inverts to false", NOT, true, "clean", "fail"],
        ["not: a non-matching verdict inverts to true", NOT, true, "dirty", "hold"],
        ["all, judge first: the judge decides", ALL_FLIPPED, true, "dirty", "fail"],
        ["any, judge first: the judge decides", ANY_FLIPPED, false, "clean", "hold"],
      ];

      for (const [name, guard, passed, verdict, expected] of routed) {
        it(name, () => {
          expect(decide(guard, { ...withTests(passed), ...withVerdict(verdict) })).toBe(expected);
        });
      }

      // The three-valued boundary, with the judge as the unresolved member: the
      // model was never asked, or its answer never came back. That must error
      // only where the missing verdict could still move the answer, and must
      // not depend on which arm the author wrote first.
      const boundary: Array<[string, Guard, boolean, "hold" | "fail" | "error"]> = [
        ["all: a failing sibling settles it", ALL, false, "fail"],
        ["all: a passing sibling leaves it decisive", ALL, true, "error"],
        ["any: a passing sibling settles it", ANY, true, "hold"],
        ["any: a failing sibling leaves it decisive", ANY, false, "error"],
        ["all, judge first: a failing sibling settles it", ALL_FLIPPED, false, "fail"],
        ["all, judge first: a passing sibling leaves it decisive", ALL_FLIPPED, true, "error"],
        ["any, judge first: a passing sibling settles it", ANY_FLIPPED, true, "hold"],
        ["any, judge first: a failing sibling leaves it decisive", ANY_FLIPPED, false, "error"],
        // Nothing else is in the composite, so a missing verdict is always
        // decisive under `not`.
        ["not: an unresolved judge is always decisive", NOT, true, "error"],
      ];

      for (const [name, guard, passed, expected] of boundary) {
        it(`unresolved judge: ${name}`, () => {
          expect(decide(guard, withTests(passed))).toBe(expected);
        });
      }

      it("surfaces the unresolved judge's own observation key in the error", () => {
        const message = errorMessage(ALL, withTests(true));
        expect(message).toContain(JUDGE_KEY);
        expect(message).toContain("no observation was resolved");
      });

      it("treats a verdict outside the declared set as broken inside a composite too", () => {
        expect(decide(ALL, { ...withTests(true), ...withVerdict("maybe") })).toBe("error");
        expect(decide(NOT, withVerdict("maybe"))).toBe("error");
        expect(errorMessage(NOT, withVerdict("maybe"))).toContain("declared verdicts");
      });

      it("treats a non-string verdict as broken inside a composite too", () => {
        expect(decide(ALL, { ...withTests(true), ...withVerdict(true) })).toBe("error");
        expect(decide(NOT, withVerdict(1))).toBe("error");
        expect(errorMessage(NOT, withVerdict(1))).toContain("not a string");
      });

      // The same Kleene rule, deliberately: a member that cannot change the
      // answer cannot decide the route, so it cannot force an error either.
      // Erroring here instead would make `any([passing tests, broken judge])`
      // depend on which arm was written first, which is the order-dependence
      // the three-valued rule exists to remove.
      it("suppresses even a broken verdict once the composite is already settled", () => {
        expect(decide(ANY, { ...withTests(true), ...withVerdict("maybe") })).toBe("hold");
        expect(decide(ALL, { ...withTests(false), ...withVerdict("maybe") })).toBe("fail");
        expect(decide(ANY_FLIPPED, { ...withTests(true), ...withVerdict("maybe") })).toBe("hold");
        expect(decide(ALL_FLIPPED, { ...withTests(false), ...withVerdict("maybe") })).toBe("fail");
      });

      it("agrees with observationsFor on the nested judge's key, end to end", () => {
        // Assembled the way a host assembles it: every key comes from
        // observationsFor, none from this test. A nested judge whose key
        // differed between collection and lookup shows up here as an
        // observation-failed error instead of a route.
        const graph = makeIr([
          {
            id: "e1",
            from: "a",
            event: "clean",
            guard: ALL,
            goto: "b",
            otherwise: { kind: "goto", node: "c" },
          },
        ]);
        const requests = observationsFor(graph, makeState());
        expect(requests.map((request) => request.kind)).toEqual(["exitZero", "judge"]);

        function answer(verdict: string): Record<string, ObservationResult> {
          const resolved: Record<string, ObservationResult> = {};
          for (const request of requests) {
            resolved[request.key] = {
              ok: true,
              value: request.kind === "judge" ? verdict : true,
            };
          }
          return resolved;
        }

        const clean = evaluate(graph, makeState(), answer("clean"));
        if (clean.kind !== "advance") throw new Error(`expected advance, got ${clean.kind}`);
        expect(clean.to).toBe("b");
        expect(clean.event).toBe("clean");

        const dirty = evaluate(graph, makeState(), answer("dirty"));
        if (dirty.kind !== "advance") throw new Error(`expected advance, got ${dirty.kind}`);
        expect(dirty.to).toBe("c");
        expect(dirty.event).toBe("otherwise");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 7: what happens when an edge fires
// ---------------------------------------------------------------------------

describe("firing an edge", () => {
  it("rule 7e: advances, moving the node and incrementing steps", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    const transition = evaluate(graph, makeState({ steps: 4 }), {});
    expect(transition).toEqual({
      kind: "advance",
      to: "b",
      via: "e1",
      event: "pass",
      state: { ...makeState({ steps: 5 }), node: "b" },
    });
  });

  it("rule 7d: an edge to END ends the run, incrementing steps", () => {
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: END }]);
    const transition = evaluate(graph, makeState({ steps: 4 }), {});
    if (transition.kind !== "end") throw new Error("expected end");
    expect(transition.via).toBe("e1");
    expect(transition.state.steps).toBe(5);
    // Only a gate is specified to move the node, so a terminal run stops
    // pointing at the node it ended on rather than at the END marker.
    expect(transition.state.node).toBe("a");
  });

  it("rule 7c: a gated edge parks, having already moved to the destination", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b", gate: "approve-plan" },
    ]);
    const transition = evaluate(graph, makeState({ steps: 4 }), {});
    if (transition.kind !== "gate") throw new Error("expected gate");
    expect(transition.gate).toBe("approve-plan");
    expect(transition.to).toBe("b");
    expect(transition.via).toBe("e1");
    expect(transition.state.status).toBe("awaiting");
    expect(transition.state.gate).toBe("approve-plan");
    expect(transition.state.node).toBe("b");
    expect(transition.state.steps).toBe(4);
  });

  it("rule 7c: resuming a parked run is flipping status back to running", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b", gate: "approve-plan" },
      { id: "e2", from: "b", event: "pass", guard: ALWAYS, goto: "c" },
    ]);
    const parked = evaluate(graph, makeState(), {});
    const resumed: RunState = { ...parked.state, status: "running" };
    const next = evaluate(graph, resumed, {});
    if (next.kind !== "advance") throw new Error("expected advance");
    expect(next.to).toBe("c");
    expect(next.state.status).toBe("running");
    expect(next.state.gate).toBeUndefined();
  });

  it("rule 7c: a gate into END is an invalid graph, not a park", () => {
    // Parking writes the destination into `state.node`, and END is not a node,
    // so the parked run would resume as `unknown-node` and be stranded. The
    // builder refuses to author this; the evaluator refuses to execute one that
    // reached it any other way.
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: END, gate: "approve-plan" },
    ]);
    const transition = evaluate(graph, makeState({ steps: 4 }), {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("invalid-graph");
    expect(transition.message).toContain("e1");
    expect(transition.message).toContain("END");
    // The run is left exactly where it was: no step counted, no node moved, no
    // status flipped, so nothing has to be undone to fix the graph and re-run.
    expect(transition.state.node).toBe("a");
    expect(transition.state.status).toBe("running");
    expect(transition.state.gate).toBeUndefined();
    expect(transition.state.steps).toBe(4);
  });

  it("rule 7c: the same gate to a REAL node still parks and still resumes", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b", gate: "approve-plan" },
      { id: "e2", from: "b", event: "pass", guard: ALWAYS, goto: END },
    ]);
    const parked = evaluate(graph, makeState({ steps: 4 }), {});
    if (parked.kind !== "gate") throw new Error("expected gate");
    expect(parked.state.status).toBe("awaiting");
    expect(parked.state.node).toBe("b");
    expect(parked.state.steps).toBe(4);

    const resumed = evaluate(graph, { ...parked.state, status: "running" }, {});
    expect(resumed.kind).toBe("end");
    expect(resumed.state.steps).toBe(5);
  });

  it("rule 7a: records the node's resolved payload as its output", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: field("status", "equals", "ok"), goto: "b" },
    ]);
    const payload = { status: "ok", findings: [1, 2] };
    const transition = evaluate(graph, makeState({ outputs: { z: 1 } }), withPayload(payload));
    expect(transition.state.outputs).toEqual({ z: 1, a: payload });
  });

  it("rule 7a: records the payload of a node that declares a schema but reads none", () => {
    // SPEC §1.3's own example: `research` declares an output contract and its
    // edge to `plan` is `when.fileExists("notes.md")`, which reads no payload.
    // If the output were collected only as a side effect of a guard reading a
    // payload lane, `ctx.research` would never exist for later steps.
    const graph = withNodeSchema(
      makeIr(
        [
          {
            id: "e1",
            from: "research",
            event: "pass",
            guard: { kind: "fileExists", path: "notes.md" },
            goto: "plan",
          },
        ],
        ["research", "plan"],
      ),
      "research",
      { type: "object", properties: { notes: { type: "string" } } },
    );
    const notes = { notes: "what I found", sources: ["a", "b"] };
    const transition = evaluate(graph, makeState({ node: "research" }), {
      [observationKey({ kind: "fileExists", path: "notes.md" })]: { ok: true, value: true },
      ...withPayload(notes),
    });
    expect(transition.kind).toBe("advance");
    expect(transition.state.outputs).toEqual({ research: notes });
  });

  it("rule 7a: records the payload of a schema node whose only edge is `always`", () => {
    const graph = withNodeSchema(
      makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]),
      "a",
      { type: "object" },
    );
    const transition = evaluate(graph, makeState(), withPayload({ n: 1 }));
    expect(transition.state.outputs).toEqual({ a: { n: 1 } });
  });

  it("rule 7a: records nothing when the node asks for no payload at all", () => {
    // Renamed from "when no payload observation resolved ok", which this fixture
    // never exercised: the node declares no schema and its guard reads no lane,
    // so nothing is requested and the not-ok branch is never reached. The three
    // tests below cover what the old title claimed.
    const graph = makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]);
    const transition = evaluate(graph, makeState(), {});
    expect(transition.state.outputs).toEqual({});
  });

  it("rule 7a: a schema node whose payload failed to parse is an error, not an empty output", () => {
    // The asymmetry this closes: rule 5 insists a failed observation is an error
    // rather than a false guard, but a schema-implied payload used to be dropped
    // on the floor, so a step that violated its own output contract departed
    // silently and the damage surfaced in whichever later step interpolated it.
    const graph = withNodeSchema(
      makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]),
      "a",
      { type: "object" },
    );
    const transition = evaluate(graph, makeState(), {
      [observationKey({ kind: "payload", from: { lane: "inline" } })]: {
        ok: false,
        error: "unparseable json",
      },
    });
    expect(transition.kind).toBe("error");
    if (transition.kind !== "error") throw new Error("expected an error transition");
    expect(transition.code).toBe("observation-failed");
    expect(transition.message).toMatch(/declares a schema but produced no readable payload/);
    expect(transition.message).toMatch(/unparseable json/);
  });

  it("rule 7a: a schema node whose payload was never resolved is the same error", () => {
    const graph = withNodeSchema(
      makeIr([{ id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" }]),
      "a",
      { type: "object" },
    );
    const transition = evaluate(graph, makeState(), {});
    expect(transition.kind).toBe("error");
    if (transition.kind !== "error") throw new Error("expected an error transition");
    expect(transition.code).toBe("observation-failed");
    expect(transition.message).toMatch(/not resolved/);
  });

  it("rule 7a: any one lane satisfies the schema's contract, not every lane", () => {
    // A step whose edges read a file lane legitimately leaves the inline lane
    // empty. The requirement is one-of, so this must advance rather than error,
    // and the guard's named lane is what lands in outputs.
    const file = { lane: "file", path: "out.json" } as const;
    const graph = withNodeSchema(
      makeIr([
        {
          id: "e1",
          from: "a",
          event: "pass",
          guard: { kind: "field", path: "ok", op: "truthy", from: file },
          goto: "b",
        },
      ]),
      "a",
      { type: "object" },
    );
    const transition = evaluate(graph, makeState(), {
      [observationKey({ kind: "payload", from: file })]: {
        ok: true,
        value: { ok: true, via: "file" },
      },
      [observationKey({ kind: "payload", from: { lane: "inline" } })]: {
        ok: false,
        error: "no inline block",
      },
    });
    expect(transition.kind).toBe("advance");
    expect(transition.state.outputs).toEqual({ a: { ok: true, via: "file" } });
  });

  it("rule 7a: when both lanes resolve, the guard's named lane wins over the schema's", () => {
    // The tie-break, pinned on its own. Both lanes are ok here, so nothing but
    // the enumeration order decides which lands in outputs, and the doc comment
    // says a lane a guard named explicitly precedes the one the schema implies.
    const file = { lane: "file", path: "out.json" } as const;
    const graph = withNodeSchema(
      makeIr([
        {
          id: "e1",
          from: "a",
          event: "pass",
          guard: { kind: "field", path: "ok", op: "truthy", from: file },
          goto: "b",
        },
      ]),
      "a",
      { type: "object" },
    );
    const transition = evaluate(graph, makeState(), {
      [observationKey({ kind: "payload", from: file })]: {
        ok: true,
        value: { ok: true, via: "file" },
      },
      [observationKey({ kind: "payload", from: { lane: "inline" } })]: {
        ok: true,
        value: { ok: true, via: "inline" },
      },
    });
    expect(transition.state.outputs).toEqual({ a: { ok: true, via: "file" } });
  });

  it("rule 7a: clones the payload, so the caller cannot mutate a persisted state", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: field("status", "equals", "ok"), goto: "b" },
    ]);
    const payload: Record<string, JsonValue> = { status: "ok", findings: [1, 2] };
    const transition = evaluate(graph, makeState(), withPayload(payload));

    payload.status = "tampered";
    (payload.findings as JsonValue[]).push(3);
    payload.extra = "added after the call";

    expect(transition.state.outputs).toEqual({ a: { status: "ok", findings: [1, 2] } });
    expect(transition.state.outputs.a).not.toBe(payload);
  });

  it("rule 7b: departing clears the retry budget of EVERY edge out of the node", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "pass", guard: ALWAYS, goto: "b" },
      { id: "e2", from: "a", event: "alt", guard: ALWAYS, goto: "c" },
      { id: "e3", from: "b", event: "pass", guard: ALWAYS, goto: "c" },
    ]);
    const transition = evaluate(graph, makeState({ attempts: { e1: 2, e2: 1, e3: 4 } }), {});
    // e3 leaves another node, so its budget is not this visit's to settle.
    expect(transition.state.attempts).toEqual({ e3: 4 });
  });

  it("rule 7b: a budget does not leak across visits when the node is left another way", () => {
    // The budget counts *consecutive* failures at a node. Retry on e1 twice,
    // then leave through e2: clearing only the firing edge would leave e1 at 2,
    // so the next visit would start two-thirds spent through a limit of 3.
    const testsKey = observationKey({ kind: "exitZero", command: "npm test" });
    const escapeKey = observationKey({ kind: "fileExists", path: "escape.md" });
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: { kind: "exitZero", command: "npm test" },
        goto: "b",
        otherwise: { kind: "retry", reason: "tests failing" },
        limit: 3,
      },
      {
        id: "e2",
        from: "a",
        event: "escape",
        guard: { kind: "fileExists", path: "escape.md" },
        goto: "c",
      },
      { id: "e3", from: "c", event: "pass", guard: ALWAYS, goto: "a" },
    ]);

    const stuck: Record<string, ObservationResult> = {
      [testsKey]: { ok: true, value: false },
      [escapeKey]: { ok: true, value: false },
    };
    let state = makeState({ attempts: { e3: 7 } });
    for (let i = 0; i < 2; i += 1) {
      const transition = evaluate(graph, state, stuck);
      if (transition.kind !== "retry") throw new Error(`expected retry, got ${transition.kind}`);
      state = transition.state;
    }
    expect(state.attempts).toEqual({ e3: 7, e1: 2 });

    const escaped = evaluate(graph, state, {
      [testsKey]: { ok: true, value: false },
      [escapeKey]: { ok: true, value: true },
    });
    if (escaped.kind !== "advance") throw new Error(`expected advance, got ${escaped.kind}`);
    expect(escaped.via).toBe("e2");
    expect(escaped.state.attempts).toEqual({ e3: 7 });

    // Back at `a` on the next visit, the budget is whole again.
    const revisited = evaluate(graph, { ...escaped.state, node: "a" }, stuck);
    if (revisited.kind !== "retry") throw new Error("expected retry");
    expect(revisited.attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 8: otherwise
// ---------------------------------------------------------------------------

describe("otherwise", () => {
  const testsKey = observationKey({ kind: "exitZero", command: "npm test" });
  const failing: Record<string, ObservationResult> = { [testsKey]: { ok: true, value: false } };

  function retryGraph(limit?: number): WorkflowIr {
    const edge: IrEdge = {
      id: "e1",
      from: "a",
      event: "pass",
      guard: { kind: "exitZero", command: "npm test" },
      goto: "b",
      otherwise: { kind: "retry", reason: "tests failing" },
      ...(limit === undefined ? {} : { limit }),
    };
    return makeIr([edge]);
  }

  it("rule 8: retry increments the counter, stays on the node, and counts a step", () => {
    const transition = evaluate(retryGraph(3), makeState(), failing);
    expect(transition).toEqual({
      kind: "retry",
      node: "a",
      via: "e1",
      reason: "tests failing",
      attempt: 1,
      state: makeState({ steps: 1, attempts: { e1: 1 } }),
    });
  });

  it("rule 8: limit 3 permits 3 retries and fails on the 4th", () => {
    const graph = retryGraph(3);
    let state = makeState();
    const attempts: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      const transition = evaluate(graph, state, failing);
      if (transition.kind !== "retry") throw new Error(`expected retry, got ${transition.kind}`);
      attempts.push(transition.attempt);
      expect(transition.state.steps).toBe(i + 1);
      state = transition.state;
    }
    expect(attempts).toEqual([1, 2, 3]);

    const exhausted = evaluate(graph, state, failing);
    if (exhausted.kind !== "error") throw new Error("expected error");
    expect(exhausted.code).toBe("retry-limit-exceeded");
    expect(exhausted.message).toContain("e1");
    expect(exhausted.state.steps).toBe(3);
  });

  // The exhaustion message is the only place the ordinal is ever seen, and
  // nothing pinned it: a constant "th" suffix, or a dropped 11-13 special case,
  // still errors with the right code and still names the edge, so the run would
  // report "a 21th time" and every test would stay green.
  const ordinals: Array<[number, string]> = [
    [0, "1st"],
    [1, "2nd"],
    [2, "3rd"],
    [3, "4th"],
    [10, "11th"],
    [11, "12th"],
    [12, "13th"],
    [20, "21st"],
    [21, "22nd"],
    [100, "101st"],
    [111, "112th"],
  ];

  for (const [limit, expected] of ordinals) {
    it(`rule 8: exhausting a limit of ${limit} reports the ${expected} attempt`, () => {
      const state = makeState({ attempts: { e1: limit } });
      const transition = evaluate(retryGraph(limit), state, failing);
      if (transition.kind !== "error") throw new Error("expected error");
      expect(transition.code).toBe("retry-limit-exceeded");
      expect(transition.message).toContain(`a ${expected} time`);
      expect(transition.message).toContain(`limit of ${limit}`);
    });
  }

  it("rule 8: an absent limit never exhausts", () => {
    const graph = retryGraph();
    let state = makeState();
    for (let i = 0; i < 25; i += 1) {
      const transition = evaluate(graph, state, failing);
      if (transition.kind !== "retry") throw new Error(`expected retry, got ${transition.kind}`);
      expect(transition.attempt).toBe(i + 1);
      state = transition.state;
    }
  });

  it("rule 8: a passing guard resets the counter, so the budget is for consecutive failures", () => {
    const graph = retryGraph(3);
    const failedTwice = makeState({ attempts: { e1: 2 } });
    const passed = evaluate(graph, failedTwice, { [testsKey]: { ok: true, value: true } });
    expect(passed.kind).toBe("advance");
    expect(passed.state.attempts).toEqual({});

    // Loop back around to the same node and fail again: the budget starts over.
    const looped: RunState = { ...passed.state, node: "a" };
    const again = evaluate(graph, looped, failing);
    if (again.kind !== "retry") throw new Error("expected retry");
    expect(again.attempt).toBe(1);
  });

  it("rule 8: goto diverts to another node", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: NEVER,
        goto: "b",
        otherwise: { kind: "goto", node: "c" },
      },
    ]);
    const transition = evaluate(graph, makeState({ steps: 2 }), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.to).toBe("c");
    expect(transition.via).toBe("e1");
    expect(transition.event).toBe("otherwise");
    expect(transition.state.node).toBe("c");
    expect(transition.state.steps).toBe(3);
  });

  it("rule 8: goto END ends the run", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: NEVER,
        goto: "b",
        otherwise: { kind: "goto", node: END },
      },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "end") throw new Error("expected end");
    expect(transition.via).toBe("e1");
    expect(transition.state.steps).toBe(1);
  });

  it("rule 8: a diverting edge still records the node's payload", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "pass",
        guard: field("status", "equals", "ok"),
        goto: "b",
        otherwise: { kind: "goto", node: "c" },
      },
    ]);
    const transition = evaluate(graph, makeState(), withPayload({ status: "broken" }));
    expect(transition.state.outputs).toEqual({ a: { status: "broken" } });
  });

  it("rule 8: the FIRST edge declaring an otherwise wins, in declaration order", () => {
    const graph = makeIr([
      { id: "e1", from: "a", event: "one", guard: NEVER, goto: "b" },
      {
        id: "e2",
        from: "a",
        event: "two",
        guard: NEVER,
        goto: "b",
        otherwise: { kind: "goto", node: "c" },
      },
      {
        id: "e3",
        from: "a",
        event: "three",
        guard: NEVER,
        goto: "b",
        otherwise: { kind: "retry", reason: "never reached" },
      },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.via).toBe("e2");
    expect(transition.to).toBe("c");
  });

  it("rule 8: an otherwise on a losing edge is ignored when another edge holds", () => {
    const graph = makeIr([
      {
        id: "e1",
        from: "a",
        event: "one",
        guard: NEVER,
        goto: "b",
        otherwise: { kind: "retry", reason: "would retry" },
      },
      { id: "e2", from: "a", event: "two", guard: ALWAYS, goto: "c" },
    ]);
    const transition = evaluate(graph, makeState(), {});
    if (transition.kind !== "advance") throw new Error("expected advance");
    expect(transition.via).toBe("e2");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  const graph = makeIr([
    {
      id: "e1",
      from: "a",
      event: "pass",
      guard: field("status", "equals", "ok"),
      goto: "b",
      otherwise: { kind: "retry", reason: "not ok" },
      limit: 3,
    },
  ]);

  it("never mutates the state it is given", () => {
    const state = makeState({ steps: 7, attempts: { e1: 1, e2: 5 }, outputs: { z: { k: 1 } } });
    const snapshot = clone(state);

    evaluate(graph, state, withPayload({ status: "ok" }));
    evaluate(graph, state, withPayload({ status: "no" }));
    evaluate(graph, state, {});
    evaluate(graph, makeState({ node: "ghost" }), {});

    expect(state).toEqual(snapshot);
  });

  it("returns a fresh state object every time", () => {
    const state = makeState({ attempts: { e2: 5 } });
    const transition = evaluate(graph, state, withPayload({ status: "ok" }));
    expect(transition.state).not.toBe(state);
    expect(transition.state.attempts).not.toBe(state.attempts);
    expect(transition.state.outputs).not.toBe(state.outputs);
  });

  it("returns a fresh state object on the error paths too", () => {
    const state = makeState({ status: "awaiting" });
    const transition = evaluate(graph, state, {});
    expect(transition.kind).toBe("error");
    expect(transition.state).not.toBe(state);
    expect(transition.state).toEqual(state);
  });

  it("carries a parked run's gate through an error transition", () => {
    // An error copies the state verbatim, gate included. No fixture ever set a
    // gate before reaching an error path, so dropping the gate here changed
    // nothing that any test could see, and it would strand a parked run: the
    // host persists this state, and a run that has forgotten which gate it
    // waits on cannot be resumed by the command meant to resume it.
    const parked = makeState({ status: "awaiting", gate: "approve-plan", graphHash: "stale" });
    const transition = evaluate(graph, parked, {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("graph-hash-mismatch");
    expect(transition.state.gate).toBe("approve-plan");
    expect(transition.state).toEqual(parked);
    expect(transition.state).not.toBe(parked);
  });

  it("carries a parked run's gate through a no-matching-edge error too", () => {
    // The same copy, reached through a different error: nothing about carrying
    // the gate is specific to the hash check running first.
    const stuck = makeIr([{ id: "e9", from: "b", event: "pass", guard: ALWAYS, goto: "c" }]);
    const parked = makeState({ status: "awaiting", gate: "approve-plan" });
    const transition = evaluate(stuck, parked, {});
    if (transition.kind !== "error") throw new Error("expected error");
    expect(transition.code).toBe("no-matching-edge");
    expect(transition.state.gate).toBe("approve-plan");
  });

  it("gives identical results for identical inputs, repeatedly", () => {
    const state = makeState({ steps: 2, attempts: { e1: 1 } });
    const resolved = withPayload({ status: "ok", n: 1 });
    const first = evaluate(graph, state, resolved);
    const second = evaluate(graph, state, resolved);
    const third = evaluate(graph, clone(state), clone(resolved));
    // Pinned, so that "stable" cannot be satisfied by a stably wrong answer.
    expect(first).toEqual({
      kind: "advance",
      to: "b",
      via: "e1",
      event: "pass",
      state: {
        ...makeState({ steps: 3 }),
        node: "b",
        outputs: { a: { status: "ok", n: 1 } },
      },
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("is insensitive to property order in the resolved map's values", () => {
    const ordered = withPayload({ a: 1, b: { c: 2, d: 3 } });
    const shuffled = withPayload({ b: { d: 3, c: 2 }, a: 1 });
    const guard = field("b", "equals", { c: 2, d: 3 });
    expect(decide(guard, ordered)).toBe("hold");
    expect(decide(guard, shuffled)).toBe("hold");
  });
});
