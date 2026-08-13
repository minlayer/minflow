import { describe, expect, it } from "vitest";

import { END, judge, lintGraph, retry, when, workflow } from "../src/builder.js";
import { evaluate, observationsFor } from "../src/evaluate.js";
import { canonicalize, graphHash } from "../src/hash.js";
import type {
  Guard,
  IrEdge,
  IrNode,
  ObservationRequest,
  ObservationResult,
  RunState,
  Transition,
  WorkflowIr,
} from "../src/ir.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** The §1.3 example graph, rebuilt from scratch on every call. */
function exampleWorkflow() {
  const wf = workflow({ name: "research-and-ship" });

  wf.step("research", {
    skill: "research-topic",
    model: "haiku",
    output: { notes: "string", sources: "string[]" },
  });
  wf.step("plan", { skill: "write-plan" });
  wf.step("implement", { skill: "implement-plan", maxTurns: 25 });
  wf.step("review", { skill: "review-changes" });

  wf.entry("research");

  wf.edge("research", "plan", when.fileExists("notes.md"));
  wf.gate("plan", "implement", { command: "approve-plan" });
  wf.edge("implement", "review", when.exitZero("npm test"), {
    otherwise: retry(3, "tests failing"),
  });
  wf.branch("review", judge("Are there unresolved findings?"), {
    no: END,
    yes: "implement",
  });

  return wf;
}

function edgeById(ir: WorkflowIr, id: string): IrEdge {
  const edge = ir.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) {
    throw new Error(`fixture error: no edge "${id}" in [${ir.edges.map((e) => e.id).join(", ")}]`);
  }
  return edge;
}

/** Runs `act`, expecting it to throw, and returns the message. */
function messageOf(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw, but it did not");
}

function nodeById(ir: WorkflowIr, id: string): IrNode {
  const node = ir.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`fixture error: no node "${id}"`);
  }
  return node;
}

/**
 * Answers one observation the way a host would. `visit` counts how many
 * transitions have already been decided, so an oracle can change its mind, and a
 * test whose observations never change can only ever prove one transition.
 */
type Oracle = (request: ObservationRequest, visit: number) => ObservationResult;

function initialState(ir: WorkflowIr): RunState {
  return {
    runId: "run-1",
    graphHash: ir.hash,
    node: ir.entry,
    status: "running",
    attempts: {},
    steps: 0,
    outputs: {},
  };
}

/**
 * Drives a compiled graph the way a host does: ask what has to be observed,
 * answer it by hand, evaluate, repeat until the run stops.
 *
 * `budget` is a backstop, not an assertion: it keeps a graph that fails to stop
 * from hanging the suite, and reports the walk it took instead. No test here
 * asserts that a run is *still going* after N transitions, because a traversal ceiling
 * the evaluator might legitimately gain later would make such a test fail while
 * the library got better. `stepCeiling` is that run-wide ceiling, passed through
 * for the one case where an edge carries no bound of its own and the ceiling is
 * the only thing left to stop it.
 */
function drive(ir: WorkflowIr, oracle: Oracle, budget = 12, stepCeiling?: number): Transition[] {
  const taken: Transition[] = [];
  let state = initialState(ir);
  for (let visit = 0; visit < budget; visit += 1) {
    const resolved: Record<string, ObservationResult> = {};
    for (const request of observationsFor(ir, state)) {
      resolved[request.key] = oracle(request, visit);
    }
    const transition =
      stepCeiling === undefined
        ? evaluate(ir, state, resolved)
        : evaluate(ir, state, resolved, { stepCeiling });
    taken.push(transition);
    if (transition.kind === "end" || transition.kind === "error" || transition.kind === "gate") {
      return taken;
    }
    state = transition.state;
  }
  throw new Error(
    `graph did not stop within ${budget} transitions: ${taken.map((step) => step.kind).join(" -> ")}`,
  );
}

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("leaves array order alone, because array order is load-bearing in the IR", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([{ b: 1, a: 2 }, "x"])).toBe('[{"a":2,"b":1},"x"]');
  });

  it("is insensitive to property insertion order", () => {
    const first = canonicalize({ alpha: [1, { z: 1, y: 2 }], beta: null });
    const second = canonicalize({ beta: null, alpha: [1, { y: 2, z: 1 }] });
    expect(first).toBe(second);
  });

  it("serializes primitives the way JSON does", () => {
    expect(canonicalize("a")).toBe('"a"');
    expect(canonicalize(1.5)).toBe("1.5");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(null)).toBe("null");
  });

  it("drops undefined-valued keys and renders undefined array slots as null", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("refuses to canonicalize a cycle rather than overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/circular/i);
  });
});

// ---------------------------------------------------------------------------
// graphHash
// ---------------------------------------------------------------------------

describe("graphHash", () => {
  const graph = {
    irVersion: 1 as const,
    name: "g",
    entry: "a",
    nodes: [{ id: "a", skill: "s" }],
    edges: [{ id: "a:1", from: "a", event: "pass", guard: { kind: "always" as const }, goto: END }],
  };

  it("is 16 hex characters", () => {
    expect(graphHash(graph)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across processes (golden value pinning the canonical form)", () => {
    // Computed out-of-band, with no code from src/, over the hand-sorted form:
    // node -e 'crypto.createHash("sha256").update(canonical,"utf8").digest("hex").slice(0,16)'
    // where canonical is
    // {"edges":[{"event":"pass","from":"a","goto":"__end__","guard":{"kind":"always"},
    //   "id":"a:1"}],"entry":"a","irVersion":1,"name":"g","nodes":[{"id":"a","skill":"s"}]}
    expect(graphHash(graph)).toBe("c5d4c9297ebb7212");
  });

  it("does not change when properties are supplied in a different order", () => {
    const reordered = {
      edges: [
        { goto: END, guard: { kind: "always" as const }, event: "pass", from: "a", id: "a:1" },
      ],
      nodes: [{ skill: "s", id: "a" }],
      entry: "a",
      name: "g",
      irVersion: 1 as const,
    };
    expect(graphHash(reordered)).toBe(graphHash(graph));
  });

  it("changes when any meaningful value changes", () => {
    const rerouted: IrEdge = {
      id: "a:1",
      from: "a",
      event: "pass",
      guard: { kind: "always" },
      goto: "a",
    };
    expect(graphHash({ ...graph, name: "g2" })).not.toBe(graphHash(graph));
    expect(graphHash({ ...graph, entry: "b" })).not.toBe(graphHash(graph));
    expect(graphHash({ ...graph, nodes: [{ id: "a", skill: "t" }] })).not.toBe(graphHash(graph));
    expect(graphHash({ ...graph, edges: [rerouted] })).not.toBe(graphHash(graph));
  });

  it("ignores the graph's own hash field", () => {
    expect(graphHash({ ...graph, hash: "0000000000000000" })).toBe(graphHash(graph));
    expect(graphHash({ ...graph, hash: "ffffffffffffffff" })).toBe(graphHash(graph));
  });

  it("distinguishes edge order, because first match wins at runtime", () => {
    const a: IrEdge = { id: "a:1", from: "a", event: "pass", guard: { kind: "always" }, goto: END };
    const b: IrEdge = { id: "a:2", from: "a", event: "fail", guard: { kind: "always" }, goto: "a" };
    expect(graphHash({ ...graph, edges: [a, b] })).not.toBe(graphHash({ ...graph, edges: [b, a] }));
  });
});

// ---------------------------------------------------------------------------
// The §1.3 example, end to end
// ---------------------------------------------------------------------------

describe("the §1.3 example graph", () => {
  it("compiles to the expected IR", () => {
    const ir = exampleWorkflow().compile();

    expect(ir).toEqual({
      irVersion: 1,
      name: "research-and-ship",
      entry: "research",
      nodes: [
        {
          id: "research",
          skill: "research-topic",
          model: "haiku",
          schema: {
            type: "object",
            properties: {
              notes: { type: "string" },
              sources: { type: "array", items: { type: "string" } },
            },
            required: ["notes", "sources"],
            additionalProperties: false,
          },
        },
        { id: "plan", skill: "write-plan" },
        { id: "implement", skill: "implement-plan", maxTurns: 25 },
        { id: "review", skill: "review-changes" },
      ],
      edges: [
        {
          id: "research:1",
          from: "research",
          event: "pass",
          guard: { kind: "fileExists", path: "notes.md" },
          goto: "plan",
        },
        {
          id: "plan:1",
          from: "plan",
          event: "pass",
          guard: { kind: "always" },
          goto: "implement",
          gate: "approve-plan",
        },
        {
          id: "implement:1",
          from: "implement",
          event: "pass",
          guard: { kind: "exitZero", command: "npm test" },
          goto: "review",
          otherwise: { kind: "retry", reason: "tests failing" },
          limit: 3,
        },
        {
          id: "review:1",
          from: "review",
          event: "no",
          guard: {
            kind: "judge",
            question: "Are there unresolved findings?",
            is: "no",
            verdicts: ["no", "yes"],
          },
          goto: END,
        },
        {
          id: "review:2",
          from: "review",
          event: "yes",
          guard: {
            kind: "judge",
            question: "Are there unresolved findings?",
            is: "yes",
            verdicts: ["no", "yes"],
          },
          goto: "implement",
        },
      ],
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("survives a JSON round trip unchanged, because guards are data", () => {
    const ir = exampleWorkflow().compile();
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  });

  it("compiles twice to the same thing", () => {
    const wf = exampleWorkflow();
    expect(wf.compile()).toEqual(wf.compile());
  });

  it("hands back a detached copy, so editing the IR cannot reach into the builder", () => {
    // The IR is plain data and callers treat it as theirs. If compile() handed
    // out the builder's own objects, a caller poking at the graph it was given
    // would silently rewrite the workflow behind it, and the next compile()
    // would return something the author never wrote, with a matching hash.
    const wf = exampleWorkflow();
    const first = wf.compile();
    nodeById(first, "plan").skill = "hacked";
    edgeById(first, "research:1").goto = END;
    expect(wf.compile()).toEqual(exampleWorkflow().compile());
  });
});

// ---------------------------------------------------------------------------
// Hash stability through the builder
// ---------------------------------------------------------------------------

describe("graph hash through the builder", () => {
  it("is identical for two identical builds", () => {
    expect(exampleWorkflow().compile().hash).toBe(exampleWorkflow().compile().hash);
  });

  it("does not depend on the graph's own hash field", () => {
    const ir = exampleWorkflow().compile();
    const { hash, ...rest } = ir;
    expect(hash).toBe(graphHash(rest));
  });

  it("changes after an edit to a node", () => {
    const before = exampleWorkflow().compile().hash;
    const wf = workflow({ name: "research-and-ship" });
    wf.step("research", {
      skill: "research-topic",
      model: "haiku",
      output: { notes: "string", sources: "string[]" },
    });
    wf.step("plan", { skill: "write-plan" });
    wf.step("implement", { skill: "implement-plan", maxTurns: 26 }); // 25 -> 26
    wf.step("review", { skill: "review-changes" });
    wf.entry("research");
    wf.edge("research", "plan", when.fileExists("notes.md"));
    wf.gate("plan", "implement", { command: "approve-plan" });
    wf.edge("implement", "review", when.exitZero("npm test"), {
      otherwise: retry(3, "tests failing"),
    });
    wf.branch("review", judge("Are there unresolved findings?"), { no: END, yes: "implement" });
    expect(wf.compile().hash).not.toBe(before);
  });

  it("changes after an edit to a guard", () => {
    const before = exampleWorkflow().compile().hash;
    const wf = workflow({ name: "research-and-ship" });
    wf.step("research", {
      skill: "research-topic",
      model: "haiku",
      output: { notes: "string", sources: "string[]" },
    });
    wf.step("plan", { skill: "write-plan" });
    wf.step("implement", { skill: "implement-plan", maxTurns: 25 });
    wf.step("review", { skill: "review-changes" });
    wf.entry("research");
    wf.edge("research", "plan", when.fileExists("NOTES.md")); // notes.md -> NOTES.md
    wf.gate("plan", "implement", { command: "approve-plan" });
    wf.edge("implement", "review", when.exitZero("npm test"), {
      otherwise: retry(3, "tests failing"),
    });
    wf.branch("review", judge("Are there unresolved findings?"), { no: END, yes: "implement" });
    expect(wf.compile().hash).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Edge ids
// ---------------------------------------------------------------------------

describe("edge ids", () => {
  function twoNodeGraph(withExtraNode: boolean) {
    const wf = workflow({ name: "ids" });
    wf.step("a", { skill: "s" });
    if (withExtraNode) {
      wf.step("z", { skill: "s" });
    }
    wf.step("b", { skill: "s" });
    wf.entry("a");
    if (withExtraNode) {
      wf.edge("a", "z", when.fileExists("z"));
      wf.edge("z", END);
    }
    wf.edge("a", "b", when.exitZero("t"));
    wf.edge("b", END, when.field("done").truthy());
    wf.edge("b", "a");
    return wf.compile();
  }

  it("are the edge's ordinal among edges leaving the same node", () => {
    const ir = twoNodeGraph(false);
    expect(ir.edges.map((edge) => edge.id)).toEqual(["a:1", "b:1", "b:2"]);
  });

  it("do not shift when an unrelated node and its edges are added", () => {
    const withExtra = twoNodeGraph(true);
    expect(withExtra.edges.filter((edge) => edge.from === "b").map((edge) => edge.id)).toEqual([
      "b:1",
      "b:2",
    ]);
    expect(withExtra.edges.map((edge) => edge.id)).toContain("z:1");
  });
});

// ---------------------------------------------------------------------------
// output shorthand
// ---------------------------------------------------------------------------

describe("output shorthand", () => {
  function schemaFor(output: Record<string, string>) {
    const wf = workflow({ name: "o" });
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    wf.step("a", { skill: "s", output: output as any });
    wf.entry("a");
    wf.edge("a", END);
    return nodeById(wf.compile(), "a").schema;
  }

  it("compiles scalars and array forms into JSON Schema", () => {
    expect(
      schemaFor({ notes: "string", count: "number", ok: "boolean", tags: "string[]" }),
    ).toEqual({
      type: "object",
      properties: {
        notes: { type: "string" },
        count: { type: "number" },
        ok: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["notes", "count", "ok", "tags"],
      additionalProperties: false,
    });
  });

  it("supports integer and the other array forms", () => {
    expect(schemaFor({ n: "integer", xs: "number[]", flags: "boolean[]" })).toEqual({
      type: "object",
      properties: {
        n: { type: "integer" },
        xs: { type: "array", items: { type: "number" } },
        flags: { type: "array", items: { type: "boolean" } },
      },
      required: ["n", "xs", "flags"],
      additionalProperties: false,
    });
  });

  it("rejects a type it cannot express, naming the field and the supported set", () => {
    expect(() => schemaFor({ notes: "str" })).toThrow(
      /step\("a"\) output field "notes" has unsupported type "str"/,
    );
    expect(() => schemaFor({ notes: "str" })).toThrow(/string, number, integer, boolean/);
  });

  it("refuses to guess when both schema and output are given", () => {
    const wf = workflow({ name: "o" });
    expect(() =>
      wf.step("a", { skill: "s", schema: { type: "object" }, output: { a: "string" } }),
    ).toThrow(/sets both "schema" and "output"/);
  });

  it("carries the skill name onto the node, which is what the emitter preloads", () => {
    const wf = workflow({ name: "o" });
    wf.step("a", { skill: "review-changes" });
    wf.entry("a");
    wf.edge("a", END);
    expect(nodeById(wf.compile(), "a").skill).toBe("review-changes");
  });

  it("carries every declared option onto the node, and nothing it was not given", () => {
    // An exact match, not a subset: a field the builder forgets to copy is a
    // field the emitter never renders, and the step then runs without the model,
    // the tool allowlist or the turn ceiling its author asked for.
    const wf = workflow({ name: "o" });
    wf.step("a", {
      skill: "review-changes",
      prompt: "Review {{research.notes}}",
      params: { depth: 2 },
      model: "opus",
      maxTurns: 7,
      tools: ["Read", "Bash"],
      phase: "build",
      schema: { type: "object" },
    });
    wf.entry("a");
    wf.edge("a", END);
    expect(nodeById(wf.compile(), "a")).toEqual({
      id: "a",
      skill: "review-changes",
      prompt: "Review {{research.notes}}",
      params: { depth: 2 },
      model: "opus",
      maxTurns: 7,
      tools: ["Read", "Bash"],
      phase: "build",
      schema: { type: "object" },
    });
  });

  it("leaves out every option that was not declared", () => {
    const wf = workflow({ name: "o" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    expect(nodeById(wf.compile(), "a")).toEqual({ id: "a", skill: "s" });
  });

  it("passes an explicit schema through untouched", () => {
    const wf = workflow({ name: "o" });
    wf.step("a", { skill: "s", schema: { type: "object", properties: { x: { type: "null" } } } });
    wf.entry("a");
    wf.edge("a", END);
    expect(nodeById(wf.compile(), "a").schema).toEqual({
      type: "object",
      properties: { x: { type: "null" } },
    });
  });
});

// ---------------------------------------------------------------------------
// when.*: guards are data
// ---------------------------------------------------------------------------

describe("when.*", () => {
  it("returns plain data, never a closure", () => {
    const guards: Guard[] = [
      when.always(),
      when.fileExists("a.md"),
      when.exitZero("npm test"),
      when.field("a.b").truthy(),
      when.field("a.b").equals(3),
      when.field("a.b").notEquals("x"),
      when.field("a.b").matches("^ok$"),
      when.field("a.b").gt(1),
      when.field("a.b").lt(1),
      when.all(when.always(), when.fileExists("a.md")),
      when.any(when.always()),
      when.not(when.always()),
      judge("Done?").is("yes"),
    ];
    for (const guard of guards) {
      expect(typeof guard).toBe("object");
      // A round trip that loses nothing is what proves there is no closure
      // anywhere in the tree; the kind check stops an empty object passing.
      expect(guard.kind).toMatch(/^[a-zA-Z]+$/);
      expect(JSON.parse(JSON.stringify(guard))).toEqual(guard);
    }
  });

  it("builds the field comparisons the IR names", () => {
    expect(when.field("findings.count").gt(0)).toEqual({
      kind: "field",
      path: "findings.count",
      op: "gt",
      value: 0,
    });
    expect(when.field("status").equals("ok")).toEqual({
      kind: "field",
      path: "status",
      op: "equals",
      value: "ok",
    });
    expect(when.field("blocked").truthy()).toEqual({
      kind: "field",
      path: "blocked",
      op: "truthy",
    });
  });

  it("takes a RegExp but stores its source, since the IR ships as JSON", () => {
    expect(when.field("summary").matches(/^ship/)).toEqual({
      kind: "field",
      path: "summary",
      op: "matches",
      value: "^ship",
    });
  });

  it("refuses a RegExp with flags rather than silently dropping them", () => {
    expect(() => when.field("summary").matches(/^ship/i)).toThrow(/flags do not survive the IR/);
  });

  it("composes without flattening", () => {
    expect(when.not(when.all(when.always(), when.any()))).toEqual({
      kind: "not",
      guard: { kind: "all", guards: [{ kind: "always" }, { kind: "any", guards: [] }] },
    });
  });

  it("catches a field builder that was never compared", () => {
    expect(() => when.all(when.field("x") as unknown as Guard)).toThrow(
      /when\.all\(\).+not a guard/s,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-edge payload lane (SPEC 6.3)
// ---------------------------------------------------------------------------

describe("per-edge payload lane", () => {
  function laneGraph(guard: Guard) {
    const wf = workflow({ name: "lane" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b", guard, { from: { lane: "file", path: "out/a.json" } });
    wf.edge("b", END);
    return edgeById(wf.compile(), "a:1").guard;
  }

  it("defaults into every nested guard that reads a payload", () => {
    expect(
      laneGraph(
        when.all(
          when.field("findings.count").gt(0),
          when.not(when.field("blocked").truthy()),
          when.any(
            when.exitZero("npm test"),
            when.fileExists("notes.md"),
            when.field("retries").lt(3),
          ),
        ),
      ),
    ).toEqual({
      kind: "all",
      guards: [
        {
          kind: "field",
          path: "findings.count",
          op: "gt",
          value: 0,
          from: { lane: "file", path: "out/a.json" },
        },
        {
          kind: "not",
          guard: {
            kind: "field",
            path: "blocked",
            op: "truthy",
            from: { lane: "file", path: "out/a.json" },
          },
        },
        {
          // The two guards that read no payload are left alone; the one that does
          // is reached, which is what proves the walk descends into `any` rather
          // than stopping at it.
          kind: "any",
          guards: [
            { kind: "exitZero", command: "npm test" },
            { kind: "fileExists", path: "notes.md" },
            {
              kind: "field",
              path: "retries",
              op: "lt",
              value: 3,
              from: { lane: "file", path: "out/a.json" },
            },
          ],
        },
      ],
    });
  });

  it("never overrides a lane the guard set for itself", () => {
    expect(laneGraph(when.field("x", { from: { lane: "inline" } }).truthy())).toEqual({
      kind: "field",
      path: "x",
      op: "truthy",
      from: { lane: "inline" },
    });
  });

  it("never overrides a lane a judge guard set for itself either", () => {
    // Same rule, the other payload-reading kind. The edge below names the file
    // lane and the guard names inline; the guard wins, because a lane the author
    // wrote by hand is a decision, not a default waiting to be filled in.
    expect(laneGraph(judge("Done?", { from: { lane: "inline" } }).is("yes"))).toEqual({
      kind: "judge",
      question: "Done?",
      is: "yes",
      from: { lane: "inline" },
    });
  });

  it("leaves the lane off entirely when the edge does not name one", () => {
    const wf = workflow({ name: "lane" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END, when.field("x").truthy());
    expect(edgeById(wf.compile(), "a:1").guard).toEqual({
      kind: "field",
      path: "x",
      op: "truthy",
    });
  });

  it("reaches judge guards on a branch", () => {
    const wf = workflow({ name: "lane" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.branch("a", judge("Done?", { from: { lane: "file", path: "out/a.json" } }), { yes: END });
    expect(edgeById(wf.compile(), "a:1").guard).toEqual({
      kind: "judge",
      question: "Done?",
      is: "yes",
      verdicts: ["yes"],
      from: { lane: "file", path: "out/a.json" },
    });
  });
});

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

describe("branch", () => {
  it("emits one edge per route, sharing a question and a closed verdict set", () => {
    const wf = workflow({ name: "b" });
    wf.step("review", { skill: "s" });
    wf.step("fix", { skill: "s" });
    wf.step("escalate", { skill: "s" });
    wf.entry("review");
    wf.branch("review", judge("What now?"), { clean: END, minor: "fix", major: "escalate" });
    wf.edge("fix", END);
    wf.edge("escalate", END);
    const ir = wf.compile();
    const fromReview = ir.edges.filter((edge) => edge.from === "review");

    expect(fromReview.map((edge) => edge.event)).toEqual(["clean", "minor", "major"]);
    expect(fromReview.map((edge) => edge.goto)).toEqual([END, "fix", "escalate"]);
    for (const edge of fromReview) {
      expect(edge.guard).toMatchObject({
        kind: "judge",
        question: "What now?",
        verdicts: ["clean", "minor", "major"],
      });
    }
  });

  it("rejects a route to an unknown node, naming it", () => {
    const wf = workflow({ name: "b" });
    wf.step("review", { skill: "s" });
    expect(() => wf.branch("review", judge("q"), { yes: "implment" })).toThrow(
      /route "yes" points at unknown node "implment"/,
    );
  });

  it("rejects a branch with no routes", () => {
    const wf = workflow({ name: "b" });
    wf.step("review", { skill: "s" });
    expect(() => wf.branch("review", judge("q"), {})).toThrow(/at least one route/);
  });

  it("rejects a second argument that is not judge()", () => {
    const wf = workflow({ name: "b" });
    wf.step("review", { skill: "s" });
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
      wf.branch("review", when.always() as any, { yes: END }),
    ).toThrow(/needs a judge\("\.\.\."\) spec/);
  });
});

// ---------------------------------------------------------------------------
// judge as a composable guard
// ---------------------------------------------------------------------------

describe("judge().is(verdict)", () => {
  function guardOf(guard: Guard): Guard {
    const wf = workflow({ name: "j" });
    wf.step("review", { skill: "s" });
    wf.entry("review");
    wf.edge("review", END, guard);
    return edgeById(wf.compile(), "review:1").guard;
  }

  it("composes under when.all next to a mechanical guard", () => {
    expect(
      guardOf(when.all(when.exitZero("npm test"), judge("Is the diff small?").is("yes"))),
    ).toEqual({
      kind: "all",
      guards: [
        { kind: "exitZero", command: "npm test" },
        { kind: "judge", question: "Is the diff small?", is: "yes" },
      ],
    });
  });

  it("composes under when.not", () => {
    expect(guardOf(when.not(judge("Anything blocking?").is("yes")))).toEqual({
      kind: "not",
      guard: { kind: "judge", question: "Anything blocking?", is: "yes" },
    });
  });

  it("is plain data, like every other guard", () => {
    const guard = judge("Done?").is("yes");
    expect(JSON.parse(JSON.stringify(guard))).toEqual(guard);
  });

  it("declares no closed verdict set, since there are no routes to close it from", () => {
    // branch() closes the set from its route keys; a lone comparison has none,
    // so the guard holds on its verdict and fails on anything else.
    expect(judge("Done?").is("yes")).toEqual({ kind: "judge", question: "Done?", is: "yes" });

    const wf = workflow({ name: "j" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.branch("a", judge("Done?"), { yes: END, no: END });
    expect(edgeById(wf.compile(), "a:1").guard).toEqual({
      kind: "judge",
      question: "Done?",
      is: "yes",
      verdicts: ["yes", "no"],
    });
  });

  it("takes the edge's payload lane like any other guard", () => {
    const wf = workflow({ name: "j" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END, when.not(judge("Done?").is("yes")), {
      from: { lane: "file", path: "out/a.json" },
    });
    expect(edgeById(wf.compile(), "a:1").guard).toEqual({
      kind: "not",
      guard: {
        kind: "judge",
        question: "Done?",
        is: "yes",
        from: { lane: "file", path: "out/a.json" },
      },
    });
  });

  it("keeps a lane judge() named for itself", () => {
    expect(judge("Done?", { from: { lane: "inline" } }).is("yes")).toEqual({
      kind: "judge",
      question: "Done?",
      is: "yes",
      from: { lane: "inline" },
    });
  });
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

describe("gate", () => {
  it("parks on the way into a real node, naming the resume command", () => {
    const wf = workflow({ name: "g" });
    wf.step("plan", { skill: "s" });
    wf.step("implement", { skill: "s" });
    wf.entry("plan");
    wf.gate("plan", "implement", { command: "approve-plan" });
    wf.edge("implement", END);
    const edge = edgeById(wf.compile(), "plan:1");
    expect(edge).toMatchObject({ goto: "implement", gate: "approve-plan", event: "pass" });
    expect(edge.guard).toEqual({ kind: "always" });
  });

  it("takes a terminal step before the gate, which is what the END rejection asks for", () => {
    // The workaround the error message names: park into a real node, and let
    // that node run to END. A parked run then has a node to resume into.
    const wf = workflow({ name: "g" });
    wf.step("plan", { skill: "s" });
    wf.step("ship", { skill: "s" });
    wf.entry("plan");
    wf.gate("plan", "ship", { command: "approve-plan" });
    wf.edge("ship", END);
    const ir = wf.compile();
    expect(edgeById(ir, "plan:1").gate).toBe("approve-plan");
    expect(edgeById(ir, "ship:1").goto).toBe(END);
  });
});

// ---------------------------------------------------------------------------
// otherwise / retry
// ---------------------------------------------------------------------------

describe("otherwise", () => {
  function graphWith(opts: Parameters<ReturnType<typeof workflow>["edge"]>[3]) {
    const wf = workflow({ name: "o" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b", when.exitZero("npm test"), opts);
    wf.edge("b", END);
    return edgeById(wf.compile(), "a:1");
  }

  it("splits retry(n, reason) into otherwise plus the edge limit", () => {
    const edge = graphWith({ otherwise: retry(3, "tests failing") });
    expect(edge.otherwise).toEqual({ kind: "retry", reason: "tests failing" });
    expect(edge.limit).toBe(3);
  });

  it("accepts a bare node id as a divert", () => {
    expect(graphWith({ otherwise: "b" }).otherwise).toEqual({ kind: "goto", node: "b" });
  });

  it("accepts END as a divert", () => {
    expect(graphWith({ otherwise: END }).otherwise).toEqual({ kind: "goto", node: END });
  });

  it("accepts the raw IR goto form", () => {
    expect(graphWith({ otherwise: { kind: "goto", node: "b" } }).otherwise).toEqual({
      kind: "goto",
      node: "b",
    });
  });

  it("accepts the raw IR retry form, which needs its ceiling supplied separately", () => {
    const edge = graphWith({ otherwise: { kind: "retry", reason: "tests failing" }, limit: 3 });
    expect(edge.otherwise).toEqual({ kind: "retry", reason: "tests failing" });
    expect(edge.limit).toBe(3);
    // Same edge as retry(3, "tests failing") produces. The sugar exists so the
    // ceiling cannot be left off by accident.
    expect(edge).toEqual(graphWith({ otherwise: retry(3, "tests failing") }));
  });

  it("rejects a divert to an unknown node", () => {
    expect(() => graphWith({ otherwise: "nope" })).toThrow(/unknown node "nope"/);
  });

  it("rejects a limit set twice", () => {
    expect(() => graphWith({ otherwise: retry(3, "x"), limit: 5 })).toThrow(/sets a limit twice/);
  });

  it("rejects a retry count that is not a positive whole number", () => {
    expect(() => retry(0, "x")).toThrow(/positive whole number/);
    expect(() => retry(1.5, "x")).toThrow(/positive whole number/);
  });

  it("defaults the event to pass and the guard to always", () => {
    const wf = workflow({ name: "o" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    const edge = edgeById(wf.compile(), "a:1");
    expect(edge.event).toBe("pass");
    expect(edge.guard).toEqual({ kind: "always" });
  });

  it("carries a custom event through", () => {
    expect(graphWith({ event: "green" }).event).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// Errors at the offending line: every throw path in the builder
// ---------------------------------------------------------------------------

/**
 * One row per `throw` in src/builder.ts. Each asserts the *message*, because a
 * message is the whole product here: the builder exists so a mistake is named
 * at the line that made it, and "it threw" is satisfied by throwing the wrong
 * thing. Adding a throw to the builder means adding a row.
 */
interface ThrowCase {
  /** What the row is about, used as the test name. */
  name: string;
  /** The offending call. */
  act: () => unknown;
  /** Every fragment the message has to carry. */
  expected: RegExp[];
}

/** Two declared steps, so a row can get straight to the mistake it is about. */
function twoSteps(name: string) {
  const wf = workflow({ name });
  wf.step("a", { skill: "s" });
  wf.step("b", { skill: "s" });
  return wf;
}

const throwCases: ThrowCase[] = [
  {
    name: "workflow() with no name",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => workflow({} as any),
    expected: [/workflow\(\) needs a \{ name \}/],
  },
  {
    name: "workflow() with an empty name",
    act: () => workflow({ name: "" }),
    expected: [/workflow\(\{ name \}\) needs a non-empty name/],
  },
  {
    name: "step() with an empty id",
    act: () => workflow({ name: "v" }).step("", { skill: "s" }),
    expected: [/step\(id, \.\.\.\) needs a non-empty id/],
  },
  {
    name: "step() using the reserved END id",
    act: () => workflow({ name: "v" }).step(END, { skill: "s" }),
    expected: [/step\("__end__"\) uses a reserved id/, /END marks a terminal transition/],
  },
  {
    name: "step() with a duplicate id",
    act: () => twoSteps("v").step("a", { skill: "t" }),
    expected: [/duplicate step id "a"/, /Already declared: a, b/],
  },
  {
    name: "step() with no skill",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => workflow({ name: "v" }).step("a", {} as any),
    expected: [/step\("a"\) needs a \{ skill \}/],
  },
  {
    name: "step() with an empty skill, which would preload nothing",
    act: () => workflow({ name: "v" }).step("a", { skill: "" }),
    expected: [/step\("a"\) needs a non-empty skill/, /review-changes/],
  },
  {
    name: "step() with both schema and output",
    act: () =>
      workflow({ name: "v" }).step("a", {
        skill: "s",
        schema: { type: "object" },
        output: { x: "string" },
      }),
    expected: [/sets both "schema" and "output"/],
  },
  {
    name: "step() with an output type the shorthand cannot express",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => workflow({ name: "v" }).step("a", { skill: "s", output: { notes: "str" } as any }),
    expected: [
      /step\("a"\) output field "notes" has unsupported type "str"/,
      /string, number, integer, boolean/,
    ],
  },
  {
    name: "entry() naming an unknown node",
    act: () => twoSteps("v").entry("aa"),
    expected: [/entry\("aa"\) names an unknown node/, /Known nodes: a, b/],
  },
  {
    name: "edge() from an unknown node",
    act: () => twoSteps("v").edge("aa", "b"),
    expected: [/edge\("aa", "b"\) references unknown node "aa"/, /Known nodes: a, b/],
  },
  {
    name: "edge() before any step is declared, where there is no node list to offer",
    act: () => workflow({ name: "v" }).edge("a", END),
    expected: [
      /edge\("a", "__end__"\) references unknown node "a"/,
      /Known nodes: \(none declared yet\)/,
    ],
  },
  {
    name: "edge() to an unknown node, pointing at END",
    act: () => twoSteps("v").edge("a", "bb"),
    expected: [
      /edge\("a", "bb"\) references unknown node "bb"/,
      /declared before they are referenced; use END for a terminal transition/,
    ],
  },
  {
    name: "edge() with a guard that is not a guard",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => twoSteps("v").edge("a", END, { kind: "sometimes" } as any),
    expected: [/edge\("a", "__end__"\).+not a guard/s, /kind "sometimes"/],
  },
  {
    name: "edge() with a when.field() that was never compared",
    act: () => twoSteps("v").edge("a", END, when.field("x") as unknown as Guard),
    expected: [/not a guard/, /never compared/, /\.truthy\(\)/],
  },
  {
    name: "edge() with a judge() that never named a verdict",
    act: () => twoSteps("v").edge("a", END, judge("Done?") as unknown as Guard),
    expected: [/not a guard/, /never named a verdict/, /\.is\("yes"\)/],
  },
  {
    name: "edge() diverting to an unknown node by bare id",
    act: () => twoSteps("v").edge("a", "b", when.exitZero("t"), { otherwise: "nope" }),
    expected: [/edge\("a", "b"\) references unknown node "nope"/],
  },
  {
    name: "edge() diverting to an unknown node by raw goto",
    act: () =>
      twoSteps("v").edge("a", "b", when.exitZero("t"), {
        otherwise: { kind: "goto", node: "nope" },
      }),
    expected: [/edge\("a", "b"\) references unknown node "nope"/],
  },
  {
    name: "edge() setting a limit twice",
    act: () =>
      twoSteps("v").edge("a", "b", when.exitZero("t"), { otherwise: retry(3, "x"), limit: 5 }),
    expected: [/sets a limit twice/, /retry\(3, \.\.\.\) already/],
  },
  {
    name: "edge() with a limit and no retry for it to bound",
    act: () => twoSteps("v").edge("a", "b", when.exitZero("t"), { limit: 3 }),
    expected: [
      /edge\("a", "b"\) sets limit 3 with no "otherwise: retry"/,
      /bounds nothing at all/,
      /otherwise: retry\(3, "why"\)/,
    ],
  },
  {
    name: "edge() with a retry behind a guard that always holds",
    act: () => twoSteps("v").edge("a", "b", when.always(), { otherwise: retry(3, "x") }),
    expected: [
      /pairs an "otherwise: retry" with a guard that always holds/,
      /can never fire and its limit bounds nothing/,
    ],
  },
  {
    name: "gate() from an unknown node",
    act: () => twoSteps("v").gate("aa", "b", { command: "approve" }),
    expected: [/gate\("aa", "b"\) references unknown node "aa"/],
  },
  {
    name: "gate() to an unknown node",
    act: () => twoSteps("v").gate("a", "bb", { command: "approve" }),
    expected: [/gate\("a", "bb"\) references unknown node "bb"/],
  },
  {
    name: "gate() into END, which has no state to park in",
    act: () => twoSteps("v").gate("a", END, { command: "approve" }),
    expected: [
      /gate\("a", "__end__"\) gates the transition into END/,
      /stores only the node it will resume into/,
      /could never be resumed/,
      /Add a terminal step and gate the transition into that instead/,
    ],
  },
  {
    name: "gate() with no command",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => twoSteps("v").gate("a", "b", {} as any),
    expected: [/gate\("a", "b"\) needs a \{ command \}/, /approve-plan/],
  },
  {
    name: "gate() with an empty command",
    act: () => twoSteps("v").gate("a", "b", { command: "" }),
    expected: [/gate\("a", "b"\) \{ command \} needs a non-empty command/],
  },
  {
    name: "branch() from an unknown node",
    act: () => twoSteps("v").branch("aa", judge("q"), { yes: END }),
    expected: [/branch\("aa", \.\.\.\) references unknown node "aa"/],
  },
  {
    name: "branch() given something that is not a judge spec",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => twoSteps("v").branch("a", when.always() as any, { yes: END }),
    expected: [/branch\("a", \.\.\.\) needs a judge\("\.\.\."\) spec/],
  },
  {
    name: "branch() with no routes",
    act: () => twoSteps("v").branch("a", judge("q"), {}),
    expected: [/branch\("a", \.\.\.\) needs at least one route/],
  },
  {
    name: "branch() with an empty verdict label",
    act: () => twoSteps("v").branch("a", judge("q"), { "": END }),
    expected: [/branch\("a", \.\.\.\) has a route with an empty verdict label/],
  },
  {
    name: "branch() routing to an unknown node",
    act: () => twoSteps("v").branch("a", judge("q"), { yes: "bb" }),
    expected: [/route "yes" points at unknown node "bb"/, /use END for a terminal transition/],
  },
  {
    name: "when.fileExists() with an empty path",
    act: () => when.fileExists(""),
    expected: [/when\.fileExists\("\.\.\."\) needs a non-empty path/],
  },
  {
    name: "when.exitZero() with an empty command",
    act: () => when.exitZero(""),
    expected: [/when\.exitZero\("\.\.\."\) needs a non-empty command/],
  },
  {
    name: "when.field() with an empty path",
    act: () => when.field(""),
    expected: [/when\.field\("\.\.\."\) needs a non-empty path/],
  },
  {
    name: "when.field().matches() with regex flags",
    act: () => when.field("summary").matches(/^ship/i),
    expected: [/flags do not survive the IR/, /Pass a pattern with no flags/],
  },
  {
    name: "when.all() given a non-guard",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => when.all(when.always(), "nope" as any),
    expected: [/when\.all\(\) argument 2 .+not a guard/s, /got nope/],
  },
  {
    name: "when.any() given a non-guard",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => when.any({ kind: "maybe" } as any),
    expected: [/when\.any\(\) argument 1 .+not a guard/s],
  },
  {
    name: "when.not() given a non-guard",
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime check on bad input
    act: () => when.not({} as any),
    expected: [/when\.not\(\) argument 1 .+not a guard/s, /an object with no guard kind/],
  },
  {
    name: "judge() with an empty question",
    act: () => judge(""),
    expected: [/judge\("\.\.\."\) needs a non-empty question/],
  },
  {
    name: "judge().is() with an empty verdict",
    act: () => judge("Done?").is(""),
    expected: [/judge\("Done\?"\)\.is\("\.\.\."\) needs a non-empty verdict/],
  },
  {
    name: "retry() with a non-positive count",
    act: () => retry(0, "x"),
    expected: [/retry\(0, \.\.\.\) needs a positive whole number of attempts/],
  },
  {
    name: "retry() with a fractional count",
    act: () => retry(1.5, "x"),
    expected: [/retry\(1\.5, \.\.\.\) needs a positive whole number of attempts/],
  },
  {
    name: "retry() with an empty reason",
    act: () => retry(2, ""),
    expected: [/retry\(n, "\.\.\."\) needs a non-empty reason/],
  },
  {
    name: "compile() with no entry",
    act: () => twoSteps("no-entry").compile(),
    expected: [/workflow "no-entry" has no entry/, /Call \.entry\(id\) before \.compile\(\)/],
  },
  {
    name: "compile() with unreachable nodes",
    act: () => {
      const wf = workflow({ name: "unreachable" });
      wf.step("a", { skill: "s" });
      wf.step("orphan", { skill: "s" });
      wf.step("lonely", { skill: "s" });
      wf.entry("a");
      wf.edge("a", END);
      wf.edge("orphan", END);
      wf.edge("lonely", END);
      return wf.compile();
    },
    expected: [/unreachable nodes: orphan, lonely/, /reachable from entry "a"/],
  },
  {
    name: "compile() with a dead end",
    act: () => {
      const wf = twoSteps("deadend");
      wf.entry("a");
      wf.edge("a", "b");
      return wf.compile();
    },
    expected: [/dead-end nodes with no outgoing edge: b/, /route it to END/],
  },
  {
    name: "compile() with an unguarded cycle",
    act: () => {
      const wf = twoSteps("spin");
      wf.entry("a");
      wf.edge("a", "b");
      wf.edge("b", "a");
      return wf.compile();
    },
    expected: [/unguarded cycle: a -> b -> a/, /cannot terminate/],
  },
];

describe("every throw path, by message", () => {
  for (const { name, act, expected } of throwCases) {
    it(`rejects ${name}`, () => {
      const message = messageOf(act);
      expect(message).toMatch(/^minflow: /);
      for (const fragment of expected) {
        expect(message).toMatch(fragment);
      }
    });
  }

  it("enumerates every rejection path, not merely every throw statement", () => {
    // 47 rows over 24 `throw` statements: requireText() and assertGuard() are
    // each reached from many call sites with a different message, and the
    // unknown-node message itself has two renderings depending on whether any
    // step has been declared yet. This length is a drift guard. Deleting a row
    // has to be a deliberate edit.
    expect(throwCases).toHaveLength(47);
  });
});

// ---------------------------------------------------------------------------
// Whole-graph checks at compile()
// ---------------------------------------------------------------------------

describe("compile() lint checks", () => {
  it("refuses to compile without an entry", () => {
    const wf = workflow({ name: "no-entry" });
    wf.step("a", { skill: "s" });
    wf.edge("a", END);
    expect(() => wf.compile()).toThrow(/workflow "no-entry" has no entry/);
    expect(() => wf.compile()).toThrow(/\.entry\(id\)/);
  });

  it("reports every unreachable node by name", () => {
    const wf = workflow({ name: "unreachable" });
    wf.step("a", { skill: "s" });
    wf.step("orphan", { skill: "s" });
    wf.step("lonely", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    wf.edge("orphan", END);
    wf.edge("lonely", END);
    expect(() => wf.compile()).toThrow(/unreachable nodes: orphan, lonely/);
    expect(() => wf.compile()).toThrow(/reachable from entry "a"/);
  });

  it("counts an otherwise divert as reaching a node", () => {
    const wf = workflow({ name: "divert" });
    wf.step("a", { skill: "s" });
    wf.step("rescue", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END, when.exitZero("npm test"), { otherwise: "rescue" });
    wf.edge("rescue", END);
    const ir = wf.compile();
    expect(edgeById(ir, "a:1").otherwise).toEqual({ kind: "goto", node: "rescue" });
    expect(ir.nodes.map((node) => node.id)).toEqual(["a", "rescue"]);
  });

  it("reports a dead end with no outgoing edge", () => {
    const wf = workflow({ name: "deadend" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    expect(() => wf.compile()).toThrow(/dead-end nodes with no outgoing edge: b/);
  });

  it("does not also call an unreachable node a dead end, which would bury the useful line", () => {
    // "island" is both: nothing reaches it, and it leads nowhere. Only the first
    // is worth saying, because the dead end is a consequence of the node being stranded,
    // and reporting it too pushes the actionable line down the list.
    const wf = workflow({ name: "island" });
    wf.step("a", { skill: "s" });
    wf.step("island", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    const message = messageOf(() => wf.compile());
    expect(message).toMatch(/unreachable nodes: island/);
    expect(message).not.toMatch(/dead-end/);
  });

  it("accepts a node whose only edge goes to END", () => {
    const wf = workflow({ name: "ok" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    expect(wf.compile().edges).toHaveLength(1);
  });

  it("reports several problems in one throw", () => {
    const wf = workflow({ name: "messy" });
    wf.step("a", { skill: "s" });
    wf.step("orphan", { skill: "s" });
    wf.step("stuck", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "stuck");
    wf.edge("orphan", END);
    const message = messageOf(() => wf.compile());
    expect(message).toMatch(/does not compile/);
    expect(message).toMatch(/unreachable nodes: orphan/);
    expect(message).toMatch(/dead-end nodes with no outgoing edge: stuck/);
  });
});

// ---------------------------------------------------------------------------
// Unguarded cycles
// ---------------------------------------------------------------------------

describe("unguarded cycle detection", () => {
  it("allows a guarded retry loop", () => {
    const wf = workflow({ name: "retry-loop" });
    wf.step("implement", { skill: "s" });
    wf.step("review", { skill: "s" });
    wf.entry("implement");
    wf.edge("implement", "review"); // always, but the way back is judged
    wf.branch("review", judge("Any unresolved findings?"), { no: END, yes: "implement" });
    const ir = wf.compile();
    expect(edgeById(ir, "review:2").guard).toMatchObject({ kind: "judge", is: "yes" });
    expect(edgeById(ir, "review:2").goto).toBe("implement");
  });

  it("allows a cycle whose back edge carries a mechanical guard", () => {
    const wf = workflow({ name: "mechanical-loop" });
    wf.step("implement", { skill: "s" });
    wf.step("review", { skill: "s" });
    wf.entry("implement");
    wf.edge("implement", "review");
    wf.edge("review", "implement", when.field("findings.count").gt(0));
    wf.edge("review", END);
    const ir = wf.compile();
    expect(edgeById(ir, "review:1").guard).toEqual({
      kind: "field",
      path: "findings.count",
      op: "gt",
      value: 0,
    });
    expect(edgeById(ir, "review:2").goto).toBe(END);
  });

  it("refuses a cycle where every edge is unconditional, naming the nodes", () => {
    const wf = workflow({ name: "spin" });
    wf.step("implement", { skill: "s" });
    wf.step("review", { skill: "s" });
    wf.entry("implement");
    wf.edge("implement", "review");
    wf.edge("review", "implement");
    expect(() => wf.compile()).toThrow(/unguarded cycle: implement -> review -> implement/);
    expect(() => wf.compile()).toThrow(/cannot terminate/);
  });

  it("names the cycle itself, not the path that led into it", () => {
    // The walk enters the cycle at "b" with "a" already on the stack. The report
    // has to start where the loop closes, or every cycle gets a prefix of nodes
    // that are not part of it and the author goes looking in the wrong place.
    const wf = workflow({ name: "tail-cycle" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.step("c", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    wf.edge("b", "c");
    wf.edge("c", "b");
    const message = messageOf(() => wf.compile());
    expect(message).toMatch(/unguarded cycle: b -> c -> b/);
    expect(message).not.toMatch(/a -> b -> c -> b/);
  });

  it("reports one cycle once, however many identical edges close it", () => {
    const wf = workflow({ name: "twice" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    wf.edge("b", "a");
    wf.edge("b", "a");
    const message = messageOf(() => wf.compile());
    expect(message).toMatch(/unguarded cycle: a -> b -> a/);
    expect(message.match(/unguarded cycle:/g)).toHaveLength(1);
  });

  it("refuses an unconditional self-loop", () => {
    const wf = workflow({ name: "self" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "a");
    expect(() => wf.compile()).toThrow(/unguarded cycle: a -> a/);
  });

  it("treats a vacuously true all() as unconditional", () => {
    const wf = workflow({ name: "vacuous" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b", when.all());
    wf.edge("b", "a", when.any(when.always(), when.fileExists("x")));
    expect(() => wf.compile()).toThrow(/unguarded cycle: a -> b -> a/);
  });

  it("treats a vacuously false any() as conditional, so a cycle through it is legal", () => {
    // The IR pins an empty disjunction as vacuously false, the mirror of the
    // vacuously true empty conjunction above. An edge carrying one can therefore
    // fail, the loop can leave, and this graph is legal. Reading it as
    // unconditional instead would reject a graph the IR allows. The failure
    // would be a legal workflow that no longer compiles, which is why the arm is
    // pinned here and not left to agree with the evaluator by coincidence.
    const wf = workflow({ name: "empty-any" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    wf.edge("b", "a", when.any());
    wf.edge("b", END);
    const ir = wf.compile();
    expect(edgeById(ir, "b:1").guard).toEqual({ kind: "any", guards: [] });
    expect(edgeById(ir, "b:1").goto).toBe("a");
  });

  it("ignores an unguarded cycle that entry cannot reach (it is reported as unreachable)", () => {
    const wf = workflow({ name: "island" });
    wf.step("a", { skill: "s" });
    wf.step("x", { skill: "s" });
    wf.step("y", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END);
    wf.edge("x", "y");
    wf.edge("y", "x");
    const message = messageOf(() => wf.compile());
    expect(message).toMatch(/unreachable nodes: x, y/);
    expect(message).not.toMatch(/unguarded cycle/);
  });

  it("refuses a bare limit on an unconditional back edge, which bounded nothing", () => {
    // This used to compile, and the test that certified it asserted only that
    // compile() did not throw. The evaluator reads `limit` on the retry path
    // alone, so the loop below spun forever with a ceiling written on it.
    const wf = workflow({ name: "bounded" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    const message = messageOf(() => wf.edge("b", "a", when.always(), { limit: 3 }));
    expect(message).toMatch(/edge\("b", "a"\) sets limit 3 with no "otherwise: retry"/);
    expect(message).toMatch(/bounds nothing at all/);
  });

  it("refuses a retry behind a guard that always holds, since it can never fire", () => {
    const wf = workflow({ name: "inert-retry" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    expect(() => wf.edge("b", "a", when.always(), { otherwise: retry(3, "again") })).toThrow(
      /pairs an "otherwise: retry" with a guard that always holds/,
    );
  });

  it("accepts a retry behind a vacuously false any(), which is a guard that only fails", () => {
    // The same empty-`any` arm, at the other place the builder consults it. An
    // empty disjunction never holds, so the retry it guards can always fire and
    // the rejection above must not reach this edge.
    const wf = workflow({ name: "any-retry" });
    wf.step("a", { skill: "s" });
    wf.entry("a");
    wf.edge("a", END, when.any(), { otherwise: retry(2, "nothing held") });
    const edge = edgeById(wf.compile(), "a:1");
    expect(edge.guard).toEqual({ kind: "any", guards: [] });
    expect(edge.otherwise).toEqual({ kind: "retry", reason: "nothing held" });
    expect(edge.limit).toBe(2);
  });

  it("catches the retry-with-limit cycle on an IR the builder never saw", () => {
    // The builder refuses to author this shape (the two tests above), so the only
    // way it reaches an emitter is from a front-end that does not go through the
    // builder, which is exactly what lintGraph() is exported for.
    //
    // It is worth being precise about why this cycle is unbounded, because it
    // looks bounded: `limit` is consulted only when a guard FAILS and `otherwise`
    // is a retry. An `always` guard never fails, so the retry never fires, the
    // limit is never read, and the run advances around the loop forever with a
    // ceiling written on it that nothing enforces.
    const nodes: IrNode[] = [
      { id: "a", skill: "s" },
      { id: "b", skill: "s" },
    ];
    const edges: IrEdge[] = [
      { id: "a:1", from: "a", event: "pass", guard: { kind: "always" }, goto: "b" },
      {
        id: "b:1",
        from: "b",
        event: "pass",
        guard: { kind: "always" },
        goto: "a",
        otherwise: { kind: "retry", reason: "again" },
        limit: 3,
      },
    ];

    expect(lintGraph({ entry: "a", nodes, edges })).toEqual([
      expect.stringMatching(/unguarded cycle: a -> b -> a/),
    ]);
  });

  it("passes a sound graph through the lint with nothing to say", () => {
    const nodes: IrNode[] = [{ id: "a", skill: "s" }];
    const edges: IrEdge[] = [
      { id: "a:1", from: "a", event: "pass", guard: { kind: "always" }, goto: END },
    ];
    expect(lintGraph({ entry: "a", nodes, edges })).toEqual([]);
  });

  it("lets a gate break the loop, since it cannot fire without a human", () => {
    const wf = workflow({ name: "gated" });
    wf.step("plan", { skill: "s" });
    wf.step("implement", { skill: "s" });
    wf.entry("plan");
    wf.gate("plan", "implement", { command: "approve-plan" });
    wf.edge("implement", "plan");
    const ir = wf.compile();
    expect(edgeById(ir, "plan:1").gate).toBe("approve-plan");
    expect(edgeById(ir, "implement:1").goto).toBe("plan");
  });
});

// ---------------------------------------------------------------------------
// What a limit actually bounds
// ---------------------------------------------------------------------------

/**
 * The only tests here that reach into the evaluator, for one specific reason:
 * the defect they cover was the builder and the evaluator disagreeing about
 * what `limit` means. The lint counted any limit as a loop ceiling; the
 * evaluator consults `edge.limit` only when a guard fails and the edge's
 * `otherwise` is a retry. A test that stopped at "compile() did not throw"
 * therefore certified graphs that provably never terminate, so these drive the
 * compiled graph and require it to stop.
 */
describe("limit, at runtime", () => {
  /** One node, one guarded exit, retrying while the guard fails. */
  function retryLoop(bound: boolean): WorkflowIr {
    const wf = workflow({ name: bound ? "bounded-retry" : "raw-retry" });
    wf.step("implement", { skill: "s" });
    wf.entry("implement");
    wf.edge("implement", END, when.exitZero("npm test"), {
      otherwise: bound ? retry(2, "tests failing") : { kind: "retry", reason: "tests failing" },
    });
    return wf.compile();
  }

  it("stops a retry loop at the limit, with the edge and the count named", () => {
    const taken = drive(retryLoop(true), () => ({ ok: true, value: false }));
    expect(taken.map((step) => step.kind)).toEqual(["retry", "retry", "error"]);
    expect(taken[0]).toMatchObject({ kind: "retry", node: "implement", attempt: 1 });
    expect(taken[1]).toMatchObject({ kind: "retry", node: "implement", attempt: 2 });
    expect(taken[2]).toMatchObject({ kind: "error", code: "retry-limit-exceeded" });
    expect(taken[2]).toMatchObject({ message: expect.stringContaining("past its limit of 2") });
  });

  it("lets the same loop end normally once the guard holds", () => {
    const taken = drive(retryLoop(true), (_request, visit) => ({ ok: true, value: visit >= 1 }));
    expect(taken.map((step) => step.kind)).toEqual(["retry", "end"]);
  });

  it("terminates a judged cycle when the verdict changes", () => {
    const wf = workflow({ name: "judged-loop" });
    wf.step("implement", { skill: "s" });
    wf.step("review", { skill: "s" });
    wf.entry("implement");
    wf.edge("implement", "review");
    wf.branch("review", judge("Any unresolved findings?"), { yes: "implement", no: END });
    const taken = drive(wf.compile(), (_request, visit) => ({
      ok: true,
      value: visit < 2 ? "yes" : "no",
    }));
    expect(taken.map((step) => step.kind)).toEqual(["advance", "advance", "advance", "end"]);
    expect(taken[1]).toMatchObject({ kind: "advance", to: "implement", event: "yes" });
  });

  it("refuses the inert-limit cycle, because nothing on that path ever reads the limit", () => {
    // Hand-built, because the builder now refuses to author this shape, which is
    // the fix. Before it did, and `isUnbounded()` read the limit as a ceiling.
    const nodes: IrNode[] = [
      { id: "a", skill: "s" },
      { id: "b", skill: "s" },
    ];
    const edges: IrEdge[] = [
      { id: "a:1", from: "a", event: "pass", guard: { kind: "always" }, goto: "b" },
      { id: "b:1", from: "b", event: "pass", guard: { kind: "always" }, goto: "a", limit: 3 },
    ];

    // What matters is that the graph is refused, and that the limit written on it
    // buys it nothing: the lint has to report the cycle exactly as if the limit
    // were not there.
    expect(lintGraph({ entry: "a", nodes, edges })).toEqual([
      expect.stringMatching(/unguarded cycle: a -> b -> a/),
    ]);

    // And why the limit buys nothing, asserted rather than assumed: `edge.limit`
    // is consulted on one path only, when a guard fails and the edge retries. An
    // `always` guard cannot fail, so the transition out of "b" advances and counts
    // no attempt against the ceiling written on it. There is nothing to exceed.
    const draft = { irVersion: 1 as const, name: "inert-limit", entry: "a", nodes, edges };
    const ir: WorkflowIr = { ...draft, hash: graphHash(draft) };
    const transition = evaluate(ir, { ...initialState(ir), node: "b" }, {});
    expect(transition).toMatchObject({ kind: "advance", to: "a", via: "b:1" });
    expect(transition.state.attempts).toEqual({});
  });

  it("gives a raw retry no ceiling of its own, so only the run-wide one stops it", () => {
    // This is why retry(n, reason) exists. The raw IR form is accepted, but it
    // carries no bound, and the assertion below is that the *run-wide* step
    // ceiling is what ends the run, not the edge, which contributes nothing.
    // Contrast the first test in this block, where retry(2, ...) stops the same
    // loop on the edge's own terms with "retry-limit-exceeded".
    const ir = retryLoop(false);
    expect(edgeById(ir, "implement:1").otherwise).toEqual({
      kind: "retry",
      reason: "tests failing",
    });
    expect(edgeById(ir, "implement:1").limit).toBeUndefined();

    const taken = drive(ir, () => ({ ok: true, value: false }), 12, 3);
    expect(taken.map((step) => step.kind)).toEqual(["retry", "retry", "retry", "error"]);
    expect(taken[3]).toMatchObject({ kind: "error", code: "step-ceiling-exceeded" });
    expect(taken[3]).toMatchObject({ message: expect.stringContaining("ceiling of 3") });
  });
});

// ---------------------------------------------------------------------------
// print()
// ---------------------------------------------------------------------------

describe("print()", () => {
  it("renders nodes, edge ids, events, guards and gates", () => {
    const text = exampleWorkflow().print();
    expect(text).toContain('workflow "research-and-ship"');
    expect(text).toContain("entry: research");
    expect(text).toContain("research  [research-topic]");
    expect(text).toContain("research:1");
    expect(text).toContain('fileExists("notes.md")');
    expect(text).toContain("[gate: approve-plan]");
    expect(text).toContain('exitZero("npm test")');
    expect(text).toContain('retry("tests failing"');
    expect(text).toContain('else retry("tests failing", limit 3)');
    expect(text).toContain("--yes-->");
    expect(text).toContain(END);
    // Every node in this graph has an edge, so the empty-node line must be
    // absent. Printed unconditionally it would read as a broken graph.
    expect(text).not.toContain("(no outgoing edges)");
  });

  it("renders every node attribute it knows about", () => {
    const wf = workflow({ name: "p" });
    wf.step("a", {
      skill: "s",
      model: "opus",
      maxTurns: 7,
      phase: "build",
      tools: ["Read", "Bash"],
      output: { notes: "string" },
    });
    wf.entry("a");
    wf.edge("a", END);
    expect(wf.print()).toContain(
      "a  [s]  model=opus maxTurns=7 phase=build tools=Read|Bash schema",
    );
  });

  it("renders both otherwise forms, and the retry ceiling only when there is one", () => {
    const wf = workflow({ name: "p" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b", when.exitZero("t"), { otherwise: END });
    wf.edge("b", END, when.exitZero("t"), { otherwise: retry(2, "again") });
    wf.edge("b", END, when.exitZero("u"), { otherwise: { kind: "retry", reason: "unbounded" } });
    const text = wf.print();
    expect(text).toContain(`else goto ${END}`);
    expect(text).toContain('else retry("again", limit 2)');
    expect(text).toContain('else retry("unbounded")');
  });

  it("works on a graph that would not compile, so it can be used to debug one", () => {
    const wf = workflow({ name: "broken" });
    wf.step("a", { skill: "s" });
    expect(() => wf.compile()).toThrow();
    expect(wf.print()).toContain("entry: (unset)");
    expect(wf.print()).toContain("(no outgoing edges)");
  });
});

/**
 * One row per guard form the renderer can be handed. `print()` is the debugging
 * surface for a graph that does not compile, so a guard it renders as nothing,
 * or as the wrong comparison, is a wrong answer to the only question the user
 * is asking. Adding a guard kind, a field op or a lane means adding a row.
 */
const guardRenderings: [Guard, string][] = [
  [when.always(), "always"],
  [when.fileExists("notes.md"), 'fileExists("notes.md")'],
  [when.exitZero("npm test"), 'exitZero("npm test")'],
  [when.field("x").truthy(), "field(x) is truthy"],
  [when.field("x").equals("ok"), 'field(x) == "ok"'],
  [when.field("x").notEquals(null), "field(x) != null"],
  [when.field("x").matches(/^ship/), 'field(x) matches "^ship"'],
  [when.field("x").gt(1), "field(x) > 1"],
  [when.field("x").lt(1), "field(x) < 1"],
  [when.field("x", { from: { lane: "inline" } }).truthy(), "field(x) is truthy from inline"],
  [
    when.field("x", { from: { lane: "file", path: "out/a.json" } }).truthy(),
    "field(x) is truthy from file(out/a.json)",
  ],
  [judge("Done?").is("yes"), 'judge("Done?") is "yes"'],
  [when.not(when.always()), "not(always)"],
  [when.all(when.always(), when.fileExists("a.md")), 'all(always, fileExists("a.md"))'],
  [when.any(), "any()"],
  [when.any(when.always(), when.exitZero("t")), 'any(always, exitZero("t"))'],
];

describe("print() renders every guard form", () => {
  for (const [guard, rendered] of guardRenderings) {
    it(`renders ${rendered}`, () => {
      const wf = workflow({ name: "p" });
      wf.step("a", { skill: "s" });
      wf.entry("a");
      wf.edge("a", END, guard);
      expect(wf.print()).toContain(`  a:1  --pass-->  ${END}  if ${rendered}`);
    });
  }

  it("covers every guard kind the IR declares", () => {
    const kinds = new Set(guardRenderings.map(([guard]) => guard.kind));
    expect([...kinds].sort()).toEqual([
      "all",
      "always",
      "any",
      "exitZero",
      "field",
      "fileExists",
      "judge",
      "not",
    ]);
  });
});
