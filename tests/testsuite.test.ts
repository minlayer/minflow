import { describe, expect, it } from "vitest";

import { END, judge, retry, when, workflow } from "../src/builder.js";
import { Skill } from "../src/skill.js";
import { runSuite } from "../src/testrun.js";
import { generateSuite, outcomesOf, solveOutcome } from "../src/testsuite.js";

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

/**
 * A graph whose retry lands on a command node.
 *
 * `branchy` retries a step, and a step gets a fresh hook fire per visit. A
 * command node is drained without leaving the dispatcher, so its visits share
 * one process, which is the case that can tell them apart from the one that
 * cannot.
 */
function retriedCommand() {
  const wf = workflow({ name: "retried-command" });
  wf.step("draft", { skill: "s" });
  wf.run("build", { command: "true" });
  wf.step("ship", { skill: "s" });
  wf.entry("draft");
  wf.edge("draft", "build");
  wf.edge("build", "ship", when.field("exitCode").equals(0), {
    otherwise: retry(2, "the build failed"),
  });
  wf.edge("ship", END);
  return wf.compile();
}

/**
 * A graph whose entry is a command node.
 *
 * It drains during the start itself, before any step has stopped, so there is no
 * earlier fire to hang its answers on.
 */
function commandAtEntry() {
  const wf = workflow({ name: "command-at-entry" });
  wf.run("check", { command: "true" });
  wf.step("fix", { skill: "s" });
  wf.step("ship", { skill: "s" });
  wf.entry("check");
  wf.edge("check", "ship", when.field("exitCode").equals(0), { otherwise: "fix" });
  wf.edge("fix", "check");
  wf.edge("ship", END);
  return wf.compile();
}

/** A graph with a gate, which parks the run until a person releases it. */
function gated() {
  const wf = workflow({ name: "gated" });
  wf.step("draft", { skill: "s" });
  wf.step("ship", { skill: "s" });
  wf.entry("draft");
  wf.gate("draft", "ship", { command: "approve" });
  wf.edge("ship", END);
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

  it("reports a pattern nothing can fail as unreachable, rather than guessing", () => {
    // A generated string that fails the guard is what makes an otherwise
    // coverable. /.*/ matches every string there is, so no such string exists.
    // Returning one that matches anyway produced a case whose walk the run could
    // never take, and it failed as though the graph were wrong.
    const wf = workflow({ name: "anything" });
    wf.step("draft", { skill: "s", output: { tag: "string" } });
    wf.step("ship", { skill: "s" });
    wf.step("fix", { skill: "s" });
    wf.entry("draft");
    wf.edge("draft", "ship", when.field("tag").matches(".*"), { otherwise: "fix" });
    wf.edge("fix", "draft");
    wf.edge("ship", END);
    const graph = wf.compile();

    const plan = generateSuite(graph);
    const blocked = plan.coverage.uncovered.find((entry) => entry.outcome === "draft:1/otherwise");
    expect(blocked?.reason).toMatch(/matches every string/);
    expect(plan.cases.every((entry) => !entry.walk.includes("fix"))).toBe(true);

    const result = runSuite(graph, plan, { skills: skills() });
    expect(result.passed).toBe(true);
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
    const plan = generateSuite(branchy());
    expect(plan.coverage.covered).toBe(plan.coverage.total);
    expect(plan.coverage.uncovered.map((entry) => entry.outcome)).toContain("fix/nomatch");
  });

  it("is reproducible: same graph and seed, same plan", () => {
    expect(generateSuite(branchy(), { seed: 3 })).toEqual(generateSuite(branchy(), { seed: 3 }));
  });

  it("takes a retry to its ceiling by repeating the step", () => {
    const plan = generateSuite(branchy());
    const exhausting = plan.cases.find((entry) => entry.covers.includes("build:1/exhaust"));
    // limit 2, so three attempts: the third is the one past the ceiling.
    expect(exhausting?.walk.filter((node) => node === "build")).toHaveLength(3);
    expect(exhausting?.ends).toBe("error");
  });

  it("pins itself to the graph it was generated against", () => {
    const plan = generateSuite(branchy());
    const other = { ...branchy(), hash: "0000000000000000" };
    expect(() => runSuite(other, plan, { skills: skills() })).toThrow(/Regenerate the plan/);
  });
});

describe("running a plan against the emitted dispatcher", () => {
  it("walks exactly where the plan said it would, on every case", () => {
    const graph = branchy();
    const result = runSuite(graph, generateSuite(graph), { skills: skills() });
    for (const testCase of result.cases) {
      expect({ id: testCase.id, problems: testCase.problems }).toEqual({
        id: testCase.id,
        problems: [],
      });
    }
    expect(result.passed).toBe(true);
  });

  it("answers each visit in turn when one fire visits a node twice", () => {
    const graph = retriedCommand();
    const plan = generateSuite(graph);

    // The case that matters fails the build once and passes it on the retry, so
    // the two visits need different answers. Both happen inside one dispatcher
    // process, and the harness is blocked while that runs, so it cannot rewrite
    // the stub file between them. Answering per node rather than per visit made
    // the second visit silently overwrite the first, and the run advanced on the
    // first attempt instead of retrying.
    const failsThenPasses = plan.cases.find(
      (entry) => entry.walk.filter((node) => node === "build").length === 2,
    );
    expect(failsThenPasses?.walk).toEqual(["draft", "build", "build", "ship"]);

    const result = runSuite(graph, plan, { skills: skills() });
    for (const testCase of result.cases) {
      expect({ id: testCase.id, problems: testCase.problems }).toEqual({
        id: testCase.id,
        problems: [],
      });
    }
  });

  it("answers a command node that drains during the start", () => {
    const graph = commandAtEntry();
    const plan = generateSuite(graph);

    // Every other command node is drained on the fire belonging to the step
    // before it, and that is where its answers are written. An entry command
    // node has no step before it: it runs while the runner is still standing by
    // for the first time. Its answers were never written at all, so it resolved
    // against the world, the command succeeded, and the case that needed it to
    // fail first walked straight past the divert.
    const diverting = plan.cases.find((entry) => entry.walk.includes("fix"));
    expect(diverting?.walk).toEqual(["check", "fix", "check", "ship"]);

    const result = runSuite(graph, plan, { skills: skills() });
    for (const testCase of result.cases) {
      expect({ id: testCase.id, problems: testCase.problems }).toEqual({
        id: testCase.id,
        problems: [],
      });
    }
  });

  it("releases a gate, so what is downstream of one can be tested at all", () => {
    const graph = gated();
    const plan = generateSuite(graph);

    // A gate is released by a command a person runs. Without the harness playing
    // that part the run parks and stays parked, so every node past a gate is
    // unreachable to the suite and reported as a routing failure that is not one.
    expect(plan.cases.some((entry) => entry.walk.includes("ship"))).toBe(true);

    const result = runSuite(graph, plan, { skills: skills() });
    for (const testCase of result.cases) {
      expect({ id: testCase.id, problems: testCase.problems }).toEqual({
        id: testCase.id,
        problems: [],
      });
    }
  });

  it("catches a graph whose emitted plugin does not do what the graph says", () => {
    // The plan is generated from the graph, then the graph is bent underneath it
    // so the run takes a different route. The walk check is what notices.
    const graph = branchy();
    const plan = generateSuite(graph);
    const bent = structuredClone(graph);
    const edge = bent.edges.find((candidate) => candidate.id === "draft:1");
    if (edge !== undefined) edge.goto = "fix";
    bent.hash = graph.hash;

    const result = runSuite(bent, plan, { skills: skills() });
    expect(result.passed).toBe(false);
    expect(result.cases.some((testCase) => /walked/.test(testCase.problems.join(" ")))).toBe(true);
  });
});
