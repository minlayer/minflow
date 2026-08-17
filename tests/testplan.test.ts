import { describe, expect, it } from "vitest";

import { END, judge, retry, when, workflow } from "../src/builder.js";
import { Skill } from "../src/skill.js";
import { generatePlan, outcomesOf, solveOutcome } from "../src/testplan.js";
import { runPlan } from "../src/testrun.js";

/** A graph with a branch, a retry with a ceiling, and a divert. */
function branchy() {
  const wf = workflow({ name: "branchy" });
  wf.step("draft", { skill: "s", output: { ready: "boolean" } });
  wf.step("build", { skill: "s" });
  wf.step("ship", { skill: "s" });
  wf.step("fix", { skill: "s" });
  wf.entry("draft");
  wf.edge("draft", "build", when.field("ready").truthy(), { otherwise: "fix" });
  wf.edge("build", "ship", when.exitZero("true"), { otherwise: retry(2, "tests failing") });
  wf.branch("ship", judge("Shipped cleanly?"), { yes: END, no: "fix" });
  wf.edge("fix", "build");
  return wf.compile();
}

const skills = () => [Skill.from({ name: "s", description: "Does a step.", body: "# s\n" })];

describe("what a graph can decide", () => {
  it("counts an edge's outcomes separately, not the edge once", () => {
    // An edge that fires, an edge whose otherwise is taken, and that retry
    // running out are three different decisions with three different causes.
    const ids = outcomesOf(branchy()).map((outcome) => outcome.id);
    expect(ids).toContain("build:1/fire");
    expect(ids).toContain("build:1/otherwise");
    expect(ids).toContain("build:1/exhaust");
  });

  it("reports an unconditional edge as shadowing everything after it", () => {
    const wf = workflow({ name: "shadow" });
    wf.step("a", { skill: "s" });
    wf.step("b", { skill: "s" });
    wf.entry("a");
    wf.edge("a", "b");
    wf.edge("a", END, when.fileExists("never.txt"));
    wf.edge("b", END);
    const outcomes = outcomesOf(wf.compile());
    const shadowed = outcomes.find((outcome) => outcome.id === "a:2/fire");
    expect(shadowed?.infeasible).toMatch(/unconditional, so no later edge is ever tried/);
  });

  it("reports a node that can always route as never reaching no-match", () => {
    const outcomes = outcomesOf(branchy());
    expect(outcomes.find((outcome) => outcome.id === "fix/nomatch")?.infeasible).toMatch(
      /always routes somewhere/,
    );
  });
});

describe("forcing a decision", () => {
  it("inverts each guard kind into the observations that force it", () => {
    const graph = branchy();
    const outcomes = outcomesOf(graph);

    const fired = outcomes.find((outcome) => outcome.id === "draft:1/fire");
    const holds = solveOutcome(graph, fired!, 1);
    expect(holds.ok).toBe(true);
    if (holds.ok) {
      const payload = Object.values(holds.observations)[0];
      expect(payload).toEqual({ ok: true, value: { ready: true } });
    }

    // The same guard, falsified, is what makes the otherwise branch reachable.
    const diverted = outcomes.find((outcome) => outcome.id === "draft:1/otherwise");
    const fails = solveOutcome(graph, diverted!, 1);
    expect(fails.ok).toBe(true);
    if (fails.ok) {
      expect(Object.values(fails.observations)[0]).toEqual({ ok: true, value: { ready: false } });
    }
  });

  it("refuses when the edges at a node want one observation to be two things", () => {
    // A closed verdict set with both verdicts routed: no verdict makes both
    // edges fail, so the node can never fall through to no-match.
    const graph = branchy();
    const nomatch = outcomesOf(graph).find((outcome) => outcome.id === "ship/nomatch");
    const solved = solveOutcome(graph, nomatch!, 1);
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/want them to be different things/);
  });

  it("generates a string for a pattern guard, deterministically", () => {
    const wf = workflow({ name: "patterned" });
    wf.step("a", { skill: "s", output: { tag: "string" } });
    wf.entry("a");
    wf.edge("a", END, when.field("tag").matches(/^v\d\.\d$/));
    const graph = wf.compile();
    const fire = outcomesOf(graph).find((outcome) => outcome.id === "a:1/fire");

    const once = solveOutcome(graph, fire!, 7);
    const twice = solveOutcome(graph, fire!, 7);
    expect(once).toEqual(twice);
    if (once.ok) {
      const result = Object.values(once.observations)[0];
      expect(result?.ok).toBe(true);
      const value = result?.ok === true ? (result.value as { tag: string }) : { tag: "" };
      expect(value.tag).toMatch(/^v\d\.\d$/);
    }
  });
});

describe("a generated plan", () => {
  it("covers every outcome the graph can reach, and names the ones it cannot", () => {
    const plan = generatePlan(branchy());
    expect(plan.coverage.covered).toBe(plan.coverage.total);
    expect(plan.coverage.uncovered.map((entry) => entry.outcome)).toContain("fix/nomatch");
  });

  it("is reproducible: same graph and seed, same plan", () => {
    expect(generatePlan(branchy(), { seed: 3 })).toEqual(generatePlan(branchy(), { seed: 3 }));
  });

  it("takes a retry to its ceiling by repeating the step", () => {
    const plan = generatePlan(branchy());
    const exhausting = plan.cases.find((entry) => entry.covers.includes("build:1/exhaust"));
    // limit 2, so three attempts: the third is the one past the ceiling.
    expect(exhausting?.walk.filter((node) => node === "build")).toHaveLength(3);
    expect(exhausting?.ends).toBe("error");
  });

  it("pins itself to the graph it was generated against", () => {
    const plan = generatePlan(branchy());
    const other = { ...branchy(), hash: "0000000000000000" };
    expect(() => runPlan(other, plan, { skills: skills() })).toThrow(/Regenerate the plan/);
  });
});

describe("running a plan against the emitted dispatcher", () => {
  it("walks exactly where the plan said it would, on every case", () => {
    const graph = branchy();
    const result = runPlan(graph, generatePlan(graph), { skills: skills() });
    for (const testCase of result.cases) {
      expect({ id: testCase.id, problems: testCase.problems }).toEqual({
        id: testCase.id,
        problems: [],
      });
    }
    expect(result.passed).toBe(true);
  });

  it("catches a graph whose emitted plugin does not do what the graph says", () => {
    // The plan is generated from the graph, then the graph is bent underneath it
    // so the run takes a different route. The walk check is what notices.
    const graph = branchy();
    const plan = generatePlan(graph);
    const bent = structuredClone(graph);
    const edge = bent.edges.find((candidate) => candidate.id === "draft:1");
    if (edge !== undefined) edge.goto = "fix";
    bent.hash = graph.hash;

    const result = runPlan(bent, plan, { skills: skills() });
    expect(result.passed).toBe(false);
    expect(result.cases.some((testCase) => /walked/.test(testCase.problems.join(" ")))).toBe(true);
  });
});
