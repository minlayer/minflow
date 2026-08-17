/**
 * minflow: a workflow compiler for coding agents.
 *
 * You describe a graph of steps in TypeScript; minflow compiles it to a plugin
 * for a coding agent. Your skills stay exactly as you wrote them: nothing here
 * edits your files, and no workflow machinery leaks into them.
 *
 * ```ts
 * import { workflow, when, judge, retry, END } from "minflow";
 *
 * const wf = workflow({ name: "research-and-ship" });
 * wf.step("research",  { skill: "research-topic", model: "haiku",
 *                        output: { notes: "string", sources: "string[]" } });
 * wf.step("plan",      { skill: "write-plan" });
 * wf.step("implement", { skill: "implement-plan", maxTurns: 25 });
 * wf.step("review",    { skill: "review-changes" });
 *
 * wf.entry("research");
 * wf.edge("research", "plan",    when.fileExists("notes.md"));
 * wf.gate("plan", "implement",   { command: "approve-plan" });
 * wf.edge("implement", "review", when.exitZero("npm test"),
 *                                { otherwise: retry(3, "tests failing") });
 * wf.branch("review", judge("Are there unresolved findings?"), {
 *   no: END,
 *   yes: "implement",
 * });
 *
 * export default wf.compile();
 * ```
 *
 * **The three layers, and why they are separate.**
 *
 * 1. *Authoring*, the builder above. One front-end among possible others.
 * 2. *The IR*, what `compile()` returns. Plain JSON: testable with no model in
 *    the loop, lintable, diffable, hashable, and it outlives any one platform.
 * 3. *Backends*, {@link claudeCode} and, later, its siblings. Adapters that know
 *    one platform's quirks. Replaceable; the IR is not.
 *
 * Between 2 and 3 sits the runtime seam ({@link observationsFor} and
 * {@link evaluate}), which is how a host actually drives a run.
 *
 * This package is in early development. Nothing here is stable, and the public
 * surface will change without notice until the first minor release.
 *
 * @packageDocumentation
 */

// --- Authoring -------------------------------------------------------------
//
// `when.*` is a library of mechanical predicates and `judge()` is a single
// conspicuous function, so that "mechanical by default" is a property of the
// surface rather than a line in the documentation.
//
// `lintGraph` is here too: `compile()` already runs it and refuses to emit if it
// finds anything, so you rarely need it directly. It is exported for the case the
// builder cannot cover. An IR produced some other way deserves the same checks,
// and some of them describe shapes the builder refuses to author at all.

export type {
  AskFromOutput,
  AskOptions,
  EdgeOptions,
  EdgeOtherwise,
  FieldGuard,
  GateOptions,
  JudgeSpec,
  LaneOptions,
  LintableGraph,
  OutputSpec,
  OutputType,
  RetrySpec,
  Routes,
  RunOptions,
  StepOptions,
  WorkflowBuilder,
} from "./builder.js";
export { askFrom, END, judge, lintGraph, retry, when, workflow } from "./builder.js";

// --- Backends --------------------------------------------------------------
//
// ```ts
// import { claudeCode } from "minflow";
// await claudeCode.writeFiles(claudeCode.emit(wf.compile()), "./my-plugin");
// ```
//
// Namespaced rather than flattened, because a backend is one adapter among
// several. A second backend arrives as another namespace, not as a rename of
// these functions.

export * as claudeCode from "./emit/claude-code.js";

// --- The runtime seam ------------------------------------------------------
//
// A host, whether the generated dispatcher or anything else driving a run, asks
// `observationsFor` what it must find out, resolves those observations by
// whatever means the platform provides, and hands the results to `evaluate`,
// which decides the transition.
//
// The split is the point. Everything platform-specific (running a shell command,
// reading a file, asking a model) happens in the host, and `evaluate` is a pure
// function over already-resolved values. It therefore cannot behave differently
// depending on where a value came from, and the whole transition table is
// testable with no model and no filesystem.

export type { ObservationSpec } from "./evaluate.js";
export { evaluate, observationKey, observationsFor } from "./evaluate.js";

// --- Reading a graph -------------------------------------------------------
//
// The builder buys error locality and costs legibility: a graph is no longer
// visible at a glance the way a transition table was. These are what buy it
// back, so they are part of the surface rather than a convenience.
//
// toMermaid renders the graph as a flowchart, including the things easiest to
// omit and most costly to miss: where a run parks for a human, what a retry's
// ceiling is, and where a failing guard diverts to.

export type { MermaidOptions } from "./mermaid.js";
export { toMermaid } from "./mermaid.js";

// --- Skills ----------------------------------------------------------------
//
// Claude Code skips a missing or policy-disabled skill with only a debug-log
// warning, so a step whose skill does not resolve runs without its instructions
// and reports nothing. Checking before emitting is therefore required rather
// than advisable, and it cannot live in emit(), which is pure by design.
//
// checkSkills is the pure half and discoverSkills is the only part that reads a
// filesystem. preloadCost is reported separately because an expensive skill is
// information a caller may act on, not a fault.

export type { SkillData, SkillProblem } from "./skill.js";
export { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, Skill } from "./skill.js";
export type { DiscoveredSkill, SkillCost, SkillReferencingGraph } from "./skills.js";
export { checkSkills, discoverSkills, parseSkill, preloadCost, SKILL_FILE } from "./skills.js";

// --- The IR ----------------------------------------------------------------
//
// Types only. You need these to type a host, a guard, or anything else handling a
// compiled graph. They are not an authoring surface and carry no compatibility
// promise: write graphs with the builder, which reports a mistake at the line
// that caused it rather than as a key lookup against a blob.

export type {
  CommandNode,
  Edge,
  End,
  FieldOp,
  Graph,
  Guard,
  JsonValue,
  Node,
  NodeId,
  ObservationRequest,
  ObservationResult,
  Otherwise,
  PayloadSource,
  PendingAsk,
  RunState,
  StepNode,
  Transition,
  TransitionErrorCode,
} from "./ir.js";
export { isCommandNode } from "./ir.js";

/** The current package version. */
export const VERSION = "0.0.1";
