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
      "VERSION",
      "claudeCode",
      "evaluate",
      "judge",
      "lintGraph",
      "observationKey",
      "observationsFor",
      "retry",
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
    wf.step("plan", { skill: "write-plan" });
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
  });

  it("exposes a semver version string", () => {
    expect(minflow.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
