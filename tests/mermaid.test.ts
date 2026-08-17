import { describe, expect, it } from "vitest";

import { END, judge, retry, when, workflow } from "../src/builder.js";
import type { Edge, Graph, Guard, Node } from "../src/ir.js";
import type { MermaidOptions } from "../src/mermaid.js";
import { toMermaid } from "../src/mermaid.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// Everything except the §1.3 golden is a hand-built IR, so the renderer is
// provably reading the IR rather than anything the builder happens to refuse to
// author. The builder is used for the golden precisely because the golden's job
// is to show what the documented example actually renders as.
// ---------------------------------------------------------------------------

function graph(over: { entry?: string; nodes?: Node[]; edges?: Edge[] }): Graph {
  const nodes = over.nodes ?? [
    { id: "a", skill: "skill-a" },
    { id: "b", skill: "skill-b" },
  ];
  return {
    irVersion: 1,
    name: "wf",
    entry: over.entry ?? nodes[0]?.id ?? "a",
    nodes,
    edges: over.edges ?? [],
    hash: "graph-hash-1",
  };
}

/** One edge per guard, all leaving the same node, so one render shows them all. */
function guardLabels(guards: Guard[], options?: MermaidOptions): string[] {
  const edges: Edge[] = guards.map((guard, index) => ({
    id: `a:${index + 1}`,
    from: "a",
    event: `e${index + 1}`,
    guard,
    goto: "b",
  }));
  const rendered = toMermaid(graph({ edges }), options);
  return rendered
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => line.replace(/^\s*\w+ [-.>]+\|"/, "").replace(/"\| \w+$/, ""));
}

/** The example in SPEC §1.3, verbatim. */
function specExample(): Graph {
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

  return wf.compile();
}

// ---------------------------------------------------------------------------
// The golden
// ---------------------------------------------------------------------------

describe("toMermaid", () => {
  it("renders the SPEC 1.3 example", () => {
    expect(toMermaid(specExample())).toMatchInlineSnapshot(`
      "flowchart TD
        __start__(("start"))
        research["research (research-topic)"]
        plan["plan (write-plan)"]
        implement["implement (implement-plan)"]
        review["review (review-changes)"]
        __end__(["END"])

        __start__ --> research
        research -->|"notes.md exists"| plan
        plan -.->|"awaits human: approve-plan"| implement
        implement -->|"npm test exits 0"| review
        implement -->|"retry (max 3): tests failing"| implement
        review -->|"judge: no"| __end__
        review -->|"judge: yes"| implement
      "
    `);
  });

  it("renders the same string every time", () => {
    // Colliding ids and a lazily declared END, so the identifier allocator is
    // carrying state by the time the graph is done. Held in the function, it
    // starts empty on every call; held in the module, the second call would
    // number every identifier differently.
    const ir = graph({
      nodes: [
        { id: "a b", skill: "one" },
        { id: "a-b", skill: "two" },
      ],
      entry: "a b",
      edges: [
        { id: "e1", from: "a b", event: "pass", guard: { kind: "always" }, goto: "a-b" },
        { id: "e2", from: "a-b", event: "pass", guard: { kind: "always" }, goto: END },
      ],
    });

    const first = toMermaid(ir);
    expect(toMermaid(ir)).toBe(first);
    // A second IR that is equal without being the same object, since a graph is
    // rendered from a fresh parse as often as from the object that built it.
    expect(toMermaid(JSON.parse(JSON.stringify(ir)) as Graph)).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

describe("toMermaid identifiers", () => {
  it("folds Mermaid syntax out of a node id and keeps the id on the label", () => {
    const noisy = 'plan "v2" | draft #1 & <b>';
    const rendered = toMermaid(
      graph({
        nodes: [
          { id: noisy, skill: "write-plan" },
          { id: "end", skill: "finish" },
        ],
        entry: noisy,
        edges: [{ id: "e1", from: noisy, event: "pass", guard: { kind: "always" }, goto: "end" }],
      }),
    );

    // Named entities throughout. A numeric one would be eaten by Mermaid's own
    // "#nnn;" substitution and reach the reader as "&|" rather than "|".
    expect(rendered).toContain(
      'plan__v2____draft__1____b_["plan &quot;v2&quot; &verbar; draft &num;1 &amp; &lt;b&gt; ' +
        '(write-plan)"]',
    );
    expect(rendered).not.toMatch(/&#\d+;/);
    // "end" closes a subgraph, so a node named it has to be renamed even though
    // nothing about the id needs folding.
    expect(rendered).toContain('n_end["end (finish)"]');
    expect(rendered).toContain("plan__v2____draft__1____b_ --> n_end");
    expect(rendered).not.toContain('"v2"');
  });

  it("keeps two ids that fold together apart", () => {
    const rendered = toMermaid(
      graph({
        nodes: [
          { id: "a b", skill: "one" },
          { id: "a-b", skill: "two" },
        ],
        entry: "a b",
        edges: [{ id: "e1", from: "a b", event: "pass", guard: { kind: "always" }, goto: "a-b" }],
      }),
    );

    expect(rendered).toContain('a_b["a b (one)"]');
    expect(rendered).toContain('a_b_2["a-b (two)"]');
    expect(rendered).toContain("a_b --> a_b_2");
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe("toMermaid edges", () => {
  it("marks the entry and gives END a terminal shape", () => {
    const rendered = toMermaid(
      graph({
        entry: "b",
        edges: [{ id: "e1", from: "b", event: "pass", guard: { kind: "always" }, goto: END }],
      }),
    );

    expect(rendered).toContain('__start__(("start"))');
    expect(rendered).toContain("__start__ --> b");
    expect(rendered).toContain('__end__(["END"])');
  });

  it("names the command that releases a gate", () => {
    const rendered = toMermaid(
      graph({
        edges: [
          {
            id: "e1",
            from: "a",
            event: "pass",
            guard: { kind: "always" },
            goto: "b",
            gate: "approve-plan",
          },
        ],
      }),
    );

    expect(rendered).toContain('a -.->|"awaits human: approve-plan"| b');
  });

  it("draws a retry as a self loop carrying its ceiling", () => {
    const rendered = toMermaid(
      graph({
        edges: [
          {
            id: "e1",
            from: "a",
            event: "pass",
            guard: { kind: "exitZero", command: "npm test" },
            goto: "b",
            otherwise: { kind: "retry", reason: "tests failing" },
            limit: 3,
          },
        ],
      }),
    );

    expect(rendered).toContain('a -->|"npm test exits 0"| b');
    expect(rendered).toContain('a -->|"retry (max 3): tests failing"| a');
  });

  it("draws an otherwise divert as its own edge", () => {
    const rendered = toMermaid(
      graph({
        nodes: [
          { id: "a", skill: "skill-a" },
          { id: "b", skill: "skill-b" },
          { id: "c", skill: "skill-c" },
        ],
        edges: [
          {
            id: "e1",
            from: "a",
            event: "pass",
            guard: { kind: "fileExists", path: "notes.md" },
            goto: "b",
            otherwise: { kind: "goto", node: "c" },
          },
        ],
      }),
    );

    expect(rendered).toContain('a -->|"notes.md exists"| b');
    expect(rendered).toContain('a -->|"otherwise"| c');
  });

  it("leaves an unconditional edge unlabelled", () => {
    const rendered = toMermaid(
      graph({
        edges: [{ id: "e1", from: "a", event: "pass", guard: { kind: "always" }, goto: "b" }],
      }),
    );

    expect(rendered).toContain("\n  a --> b");
    expect(rendered).not.toContain("always");
  });

  it("keeps a label on one line", () => {
    // A guard's command and a node's id are both free text and can arrive with
    // newlines in them. A label broken across lines splits the arrow it belongs
    // to, so the graph source stops being one line per edge.
    const rendered = toMermaid(
      graph({
        nodes: [
          { id: "a\n  second", skill: "skill-a" },
          { id: "b", skill: "skill-b" },
        ],
        entry: "a\n  second",
        edges: [
          {
            id: "e1",
            from: "a\n  second",
            event: "pass",
            guard: { kind: "exitZero", command: "npm test \\\n  --watch false" },
            goto: "b",
          },
        ],
      }),
    );

    expect(rendered).toContain('a___second["a second (skill-a)"]');
    expect(rendered).toContain('a___second -->|"npm test \\ --watch false exits 0"| b');
    // The header, the marker, two steps, a blank line, and two links. A label
    // that kept its newline would make an eighth.
    expect(rendered.trimEnd().split("\n")).toHaveLength(7);
  });

  it("takes the direction from the options", () => {
    expect(toMermaid(graph({}), { direction: "LR" })).toContain("flowchart LR");
    expect(toMermaid(graph({}))).toContain("flowchart TD");
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("toMermaid guards", () => {
  it("reads a mechanical guard as its predicate and a judge as its verdict", () => {
    expect(
      guardLabels([
        { kind: "exitZero", command: "npm test" },
        { kind: "fileExists", path: "notes.md" },
        { kind: "field", path: "findings.count", op: "gt", value: 0 },
        { kind: "field", path: "status", op: "equals", value: "done" },
        { kind: "field", path: "notes", op: "truthy", from: { lane: "file", path: "out.json" } },
        { kind: "judge", question: "Are there unresolved findings?", is: "yes" },
      ]),
    ).toEqual([
      "npm test exits 0",
      "notes.md exists",
      // Escaped, because the renderer draws a label as HTML by default and both
      // brackets are markup there.
      "findings.count &gt; 0",
      "status == &quot;done&quot;",
      "notes is truthy (from out.json)",
      "judge: yes",
    ]);
  });

  it("composes a nested guard tree and counts what it stops expanding", () => {
    const nested: Guard = {
      kind: "all",
      guards: [
        { kind: "exitZero", command: "npm test" },
        {
          kind: "any",
          guards: [
            { kind: "fileExists", path: "notes.md" },
            {
              kind: "all",
              guards: [
                { kind: "fileExists", path: "one" },
                { kind: "fileExists", path: "two" },
                { kind: "fileExists", path: "three" },
              ],
            },
          ],
        },
      ],
    };

    expect(guardLabels([nested])).toEqual([
      "npm test exits 0 and (notes.md exists or (all of 3 checks))",
    ]);
    expect(guardLabels([nested], { guardDepth: 3 })).toEqual([
      "npm test exits 0 and (notes.md exists or (one exists and two exists and three exists))",
    ]);
    expect(guardLabels([nested], { guardDepth: 1 })).toEqual([
      "npm test exits 0 and (any of 2 checks)",
    ]);
  });

  it("renders a negation and an empty composite as what they mean", () => {
    expect(
      guardLabels([
        { kind: "not", guard: { kind: "fileExists", path: "notes.md" } },
        {
          kind: "not",
          guard: {
            kind: "not",
            guard: { kind: "not", guard: { kind: "fileExists", path: "notes.md" } },
          },
        },
        { kind: "all", guards: [] },
        { kind: "any", guards: [] },
      ]),
    ).toEqual(["not (notes.md exists)", "not (not (not (...)))", "always", "never"]);
  });
});
