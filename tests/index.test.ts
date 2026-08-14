import { describe, expect, it } from "vitest";

import * as minflow from "../src/index.js";

describe("the public surface", () => {
  it("exports exactly this, and nothing accidental", () => {
    // Pinned deliberately. This package's whole premise is that the IR is the
    // asset and the front-end and backends are replaceable around it, so what is
    // and is not public is a design statement rather than an implementation
    // detail. A new export should be a decision someone made on purpose, which
    // means updating this line.
    expect(Object.keys(minflow).sort()).toEqual([
      "END",
      "SKILL_FILE",
      "VERSION",
      "checkSkills",
      "claudeCode",
      "discoverSkills",
      "evaluate",
      "judge",
      "lintGraph",
      "observationKey",
      "observationsFor",
      "parseSkill",
      "preloadCost",
      "retry",
      "toMermaid",
      "when",
      "workflow",
    ]);
  });

  it("namespaces the backend rather than flattening it", () => {
    // A backend is one adapter among several. Keeping it behind a namespace is
    // what lets a second one arrive without renaming these.
    expect(typeof minflow.claudeCode.emit).toBe("function");
    expect(typeof minflow.claudeCode.writeFiles).toBe("function");
    expect(minflow.claudeCode.MANIFEST_PATH).toBe(".claude-plugin/plugin.json");
  });

  it("compiles the README's own example end to end", () => {
    // If the example in the package doc does not work as printed, the docs are
    // wrong in the one place a new user is guaranteed to look.
    const wf = minflow.workflow({ name: "research-and-ship" });
    wf.step("research", {
      skill: "research-topic",
      model: "haiku",
      output: { notes: "string", sources: "string[]" },
    });
    // The README documents this interpolation on this exact graph, so it is
    // compiled here rather than left as prose that might not hold. It is legal
    // because research is on every route to plan.
    wf.step("plan", {
      skill: "write-plan",
      prompt: "Write a plan from:\n\n{{ctx.research.notes}}",
    });
    wf.step("implement", { skill: "implement-plan", maxTurns: 25 });
    wf.step("review", { skill: "review-changes" });

    wf.entry("research");
    wf.edge("research", "plan", minflow.when.fileExists("notes.md"));
    wf.gate("plan", "implement", { command: "approve-plan" });
    wf.edge("implement", "review", minflow.when.exitZero("npm test"), {
      otherwise: minflow.retry(3, "tests failing"),
    });
    wf.branch("review", minflow.judge("Are there unresolved findings?"), {
      no: minflow.END,
      yes: "implement",
    });

    const ir = wf.compile();
    expect(ir.entry).toBe("research");
    expect(ir.nodes.map((node) => node.id)).toEqual(["research", "plan", "implement", "review"]);
    expect(ir.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(minflow.lintGraph(ir)).toEqual([]);

    // And it emits a plugin whose entrypoint is reachable.
    const files = minflow.claudeCode.emit(ir);
    expect(Object.keys(files)).toContain("commands/run-research-and-ship.md");

    // The wrapper must not show the step a placeholder it cannot resolve: the
    // value arrives in the instruction the dispatcher writes at spawn time.
    const wrapper = files["agents/step-plan.md"] ?? "";
    expect(wrapper).not.toContain("{{ctx.");
  });

  it("renders a graph a reader can follow, including where it parks and retries", () => {
    // SPEC section 1.3 trades the transition table's one-glance legibility for
    // errors at the offending line, and names this as what buys it back. A
    // diagram that omits the gate or the retry is not that.
    const wf = minflow.workflow({ name: "readable" });
    wf.step("plan", { skill: "write-plan" });
    wf.step("ship", { skill: "ship-it" });
    wf.entry("plan");
    wf.gate("plan", "ship", { command: "approve-plan" });
    wf.edge("ship", minflow.END, minflow.when.exitZero("npm test"), {
      otherwise: minflow.retry(2, "tests failing"),
    });

    const diagram = minflow.toMermaid(wf.compile());
    expect(diagram).toContain("flowchart");
    expect(diagram).toContain("approve-plan");
    expect(diagram).toContain("npm test exits 0");
    expect(diagram).toContain("tests failing");
  });

  it("refuses to let a step name a skill that does not resolve", () => {
    // The failure this prevents is silent: the platform skips a missing skill
    // with only a debug-log warning, so the step runs without its instructions
    // and the run reports nothing wrong.
    const wf = minflow.workflow({ name: "skills" });
    wf.step("research", { skill: "research-topic" });
    wf.entry("research");
    wf.edge("research", minflow.END);
    const ir = wf.compile();

    expect(minflow.checkSkills(ir, [])).not.toHaveLength(0);
    expect(
      minflow.checkSkills(ir, [
        {
          directory: "research-topic",
          source: "./skills/research-topic/SKILL.md",
          frontmatter: { name: "research-topic", description: "How to research a topic." },
          bodyChars: 400,
        },
      ]),
    ).toEqual([]);
  });

  it("exposes a semver version string that matches the package", async () => {
    expect(minflow.VERSION).toMatch(/^\d+\.\d+\.\d+/);

    // Two sources of truth for one number drift silently, and the first symptom
    // is a released package reporting the wrong version of itself.
    const fs = await import("node:fs/promises");
    const manifest = JSON.parse(await fs.readFile("package.json", "utf8")) as { version: string };
    expect(minflow.VERSION).toBe(manifest.version);
  });
});
