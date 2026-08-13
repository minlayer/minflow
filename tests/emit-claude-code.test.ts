import { describe, expect, it } from "vitest";

import { END, judge, retry, when, workflow } from "../src/builder.js";
import {
  agentNames,
  COMMANDS_DIR,
  COMPILED_GRAPH_PATH,
  DISPATCHER_PATH,
  emit,
  HOOKS_PATH,
  MANIFEST_PATH,
  obligationsFor,
  pluginNameFor,
  RUNNER_PATH,
  RUNTIME_PATH,
  writeFiles,
} from "../src/emit/claude-code.js";
import { evaluate, observationsFor } from "../src/evaluate.js";
import type {
  JsonValue,
  NodeId,
  ObservationRequest,
  ObservationResult,
  PayloadSource,
  RunState,
  Transition,
  WorkflowIr,
} from "../src/ir.js";

/** The three node modules the I/O tests need. */
async function nodeModules() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return { fs, os, path };
}

/**
 * The literal the host substitutes into a hook's argv. It is not a JavaScript
 * placeholder, which is why it is built by hand rather than interpolated.
 */
const PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The §1.3 example, bent to exercise the emitter's edges: a workflow name that
 * is not a legal plugin name, a node id that is not a legal agent name, a guard
 * tree nested two deep over a file payload lane, a gate, a retry, and a judge.
 */
function exampleIr(): WorkflowIr {
  const wf = workflow({ name: "Research & Ship!" });

  wf.step("research", {
    skill: "research-topic",
    model: "haiku",
    prompt: "Research the topic and write up what you found.",
    params: { depth: 3 },
    output: { notes: "string", sources: "string[]" },
  });
  wf.step("plan", { skill: "write-plan" });
  wf.step("implement", { skill: "implement-plan", maxTurns: 25, tools: ["Read", "Write"] });
  wf.step("review:security", { skill: "review-changes" });

  wf.entry("research");

  // The lane is declared on the edge and inherited by every guard in the tree
  // that does not name one, including the one buried under all(not(...)).
  wf.edge(
    "research",
    "plan",
    when.all(when.fileExists("notes.md"), when.not(when.field("blocked").truthy())),
    { from: { lane: "file", path: ".minflow/research.json" } },
  );
  wf.gate("plan", "implement", { command: "approve-plan" });
  wf.edge("implement", "review:security", when.exitZero("npm test"), {
    otherwise: retry(3, "tests failing"),
  });
  wf.branch("review:security", judge("Any unresolved findings?"), { no: END, yes: "implement" });

  return wf.compile();
}

/** Two steps, one of each lane. Small enough to read as a golden file. */
function tinyIr(): WorkflowIr {
  const wf = workflow({ name: "tiny-flow" });
  wf.step("draft", { skill: "write-draft", output: { done: "boolean" } });
  wf.step("check", { skill: "check-draft" });
  wf.entry("draft");
  wf.edge("draft", "check", when.field("done").truthy());
  wf.edge("check", END, when.exitZero("npm test"));
  return wf.compile();
}

/** Three node ids that all fold badly: two collide, one vanishes entirely. */
function collidingIr(): WorkflowIr {
  const wf = workflow({ name: "collisions" });
  wf.step("Review: Security", { skill: "a" });
  wf.step("review/security", { skill: "b" });
  wf.step("!!!", { skill: "c" });
  wf.entry("Review: Security");
  wf.edge("Review: Security", "review/security");
  wf.edge("review/security", "!!!");
  wf.edge("!!!", END);
  return wf.compile();
}

/**
 * One graph, built twice, with `params` and `schema` typed in opposite key
 * orders and the nested objects flipped too. Everything else is identical.
 */
function keyOrderIr(order: "forward" | "reverse"): WorkflowIr {
  const forward = order === "forward";
  const alpha: JsonValue = forward
    ? { type: "number", description: "a" }
    : { description: "a", type: "number" };
  const beta: JsonValue = forward
    ? { type: "string", description: "b" }
    : { description: "b", type: "string" };
  const params: Record<string, JsonValue> = forward
    ? { alpha: 1, beta: "two" }
    : { beta: "two", alpha: 1 };
  // `required` keeps one order in both: array order is semantics in this IR and
  // does reach the hash, so flipping it would be a different graph.
  const schema: JsonValue = forward
    ? { type: "object", properties: { alpha, beta }, required: ["alpha", "beta"] }
    : { required: ["alpha", "beta"], properties: { beta, alpha }, type: "object" };

  const wf = workflow({ name: "key-order" });
  wf.step("one", { skill: "s", params, schema });
  wf.entry("one");
  wf.edge("one", END);
  return wf.compile();
}

/** A chain of steps, every transition gated with the command at that position. */
function gatedIr(commands: string[]): WorkflowIr {
  const wf = workflow({ name: "gated" });
  wf.step("s0", { skill: "s" });
  for (let index = 0; index < commands.length; index += 1) {
    wf.step(`s${index + 1}`, { skill: "s" });
  }
  wf.entry("s0");
  commands.forEach((command, index) => {
    wf.gate(`s${index}`, `s${index + 1}`, { command });
  });
  wf.edge(`s${commands.length}`, END);
  return wf.compile();
}

/**
 * One node with four overlapping outgoing edges.
 *
 * The third repeats every lane, path and command the first already asked for,
 * with the second's between them, so a duplicate is visible. The fourth adds a
 * third distinct set at the end, which is what makes the expected order
 * asymmetric: without it the list reads the same forwards and backwards, and an
 * assertion on "first-encountered order" would hold for any traversal at all.
 */
function repeatedLaneIr(): WorkflowIr {
  const first: PayloadSource = { lane: "file", path: "out/first.json" };
  const second: PayloadSource = { lane: "file", path: "out/second.json" };
  const third: PayloadSource = { lane: "file", path: "out/third.json" };
  const wf = workflow({ name: "repeats" });
  wf.step("fan", { skill: "s" });
  wf.step("next", { skill: "s" });
  wf.entry("fan");
  const fan = (event: string, command: string, path: string, lane: PayloadSource): void => {
    wf.edge(
      "fan",
      event === "d" ? END : "next",
      when.all(when.exitZero(command), when.fileExists(path), when.field(event).truthy()),
      { from: lane, event },
    );
  };
  fan("a", "npm test", "notes.md", first);
  fan("b", "npm run lint", "dist/out.txt", second);
  // Every obligation here was already recorded by edge "a".
  fan("c", "npm test", "notes.md", first);
  fan("d", "npm run build", "build.log", third);
  wf.edge("next", END);
  return wf.compile();
}

/**
 * Three steps whose guards a test can decide from outside: a field on the step's
 * own payload, a shell predicate over a file, and a file-existence check.
 */
function drivableIr(): WorkflowIr {
  const wf = workflow({ name: "drivable" });
  wf.step("draft", { skill: "s", output: { done: "boolean" } });
  wf.step("build", { skill: "s" });
  wf.step("ship", { skill: "s" });
  wf.entry("draft");
  wf.edge("draft", "build", when.field("done").truthy());
  wf.edge("build", "ship", when.exitZero("test -f built.txt"), {
    otherwise: retry(2, "the build produced nothing"),
  });
  wf.edge("ship", END, when.fileExists("shipped.txt"));
  return wf.compile();
}

/**
 * A judged loop over a node that also declares an output contract.
 *
 * Both halves are load-bearing. The loop is what makes a stale verdict visible:
 * reuse one and the second lap routes on the first lap's answer forever. The
 * schema forces a payload observation on the same node, so the verdict round
 * trip has to preserve the step's payload across the two hook fires it takes,
 * and losing it shows up as a run that stops instead of advancing.
 */
function judgedIr(): WorkflowIr {
  const wf = workflow({ name: "judged" });
  wf.step("review", { skill: "s", output: { findings: "number" } });
  wf.step("fix", { skill: "s" });
  wf.entry("review");
  wf.branch("review", judge("Any unresolved findings?"), { no: END, yes: "fix" });
  wf.edge("fix", "review");
  return wf.compile();
}

/**
 * One transition that needs both a command and a verdict.
 *
 * The command is what makes the round trip countable: a judge question costs two
 * hook fires, and everything mechanical at the node is resolved on both of them
 * unless the host remembers what it already found out. `printf` appends a byte
 * per run, so the file is the count.
 */
function tickAndJudgeIr(): WorkflowIr {
  const wf = workflow({ name: "tick-and-judge" });
  wf.step("review", { skill: "s" });
  wf.step("fix", { skill: "s" });
  wf.entry("review");
  wf.edge(
    "review",
    "fix",
    when.all(when.exitZero("printf x >> ticks.txt"), judge("Any findings?").is("yes")),
  );
  wf.edge("review", END);
  wf.edge("fix", END);
  return wf.compile();
}

/**
 * Two slow guard commands on one node, neither slow enough to matter alone.
 *
 * This is the shape a per-command timeout cannot bound: each command is well
 * inside any sane per-command limit, and together they outlive the hook.
 */
function slowGuardsIr(): WorkflowIr {
  const wf = workflow({ name: "slow-guards" });
  wf.step("build", { skill: "s" });
  wf.step("ship", { skill: "s" });
  wf.entry("build");
  // Two commands, not one twice: identical commands share an observation key and
  // would be resolved once however the budget worked.
  wf.edge("build", "ship", when.all(when.exitZero("sleep 1"), when.exitZero("sleep 1 && true")));
  wf.edge("build", END);
  wf.edge("ship", END);
  return wf.compile();
}

/**
 * A judge written with .is(), which declares no verdict set at all.
 *
 * branch() closes the set with its route keys; this shape cannot, so it is the
 * only path where a verdict has to be folded onto a spelling recovered from the
 * graph rather than onto a declared one.
 */
function openJudgeIr(): WorkflowIr {
  const wf = workflow({ name: "open-judge" });
  wf.step("draft", { skill: "s" });
  wf.step("build", { skill: "s" });
  wf.entry("draft");
  wf.edge("draft", "build", judge("Is it good?").is("yes"));
  wf.edge("draft", END);
  wf.edge("build", END);
  return wf.compile();
}

/** A judged branch over a payload the judge reads from a file. */
function judgedFileIr(): WorkflowIr {
  const wf = workflow({ name: "judged-file" });
  wf.step("review", { skill: "s" });
  wf.step("fix", { skill: "s" });
  wf.entry("review");
  wf.branch(
    "review",
    judge("Any unresolved findings?", { from: { lane: "file", path: "out/review.json" } }),
    {
      no: END,
      yes: "fix",
    },
  );
  wf.edge("fix", "review");
  return wf.compile();
}

/**
 * Two nodes whose payload obligation their own guards understate.
 *
 * Each declares an output contract and is left by a guard reading a file lane,
 * one a field guard and one a judge. `observationsFor` adds an inline payload
 * request for any node declaring a schema, so both are asked for two lanes while
 * their guards name one, which is the disagreement a wrapper can be wrong about.
 */
function schemaOverFileIr(): WorkflowIr {
  const wf = workflow({ name: "schema-over-file" });
  wf.step("scan", { skill: "s", output: { clean: "boolean" } });
  wf.step("review", { skill: "s", output: { findings: "number" } });
  wf.entry("scan");
  wf.edge("scan", "review", when.field("clean").truthy(), {
    from: { lane: "file", path: "out/scan.json" },
  });
  wf.branch("review", judge("Ship it?", { from: { lane: "file", path: "out/review.json" } }), {
    yes: END,
    no: "scan",
  });
  return wf.compile();
}

/** A step whose payload is read from a file rather than from its final message. */
function fileLaneIr(): WorkflowIr {
  const wf = workflow({ name: "file-lane" });
  wf.step("scan", { skill: "s" });
  wf.step("act", { skill: "s" });
  wf.entry("scan");
  wf.edge("scan", "act", when.field("clean").truthy(), {
    from: { lane: "file", path: "out/scan.json" },
  });
  wf.edge("act", END);
  return wf.compile();
}

/** A chain of steps with the given ids, so agent-name derivation can be exercised. */
function idIr(ids: string[]): WorkflowIr {
  const wf = workflow({ name: "ids" });
  for (const id of ids) wf.step(id, { skill: "s" });
  const first = ids[0];
  if (first === undefined) throw new Error("fixture error: idIr needs at least one id");
  wf.entry(first);
  ids.forEach((id, index) => {
    const next = ids[index + 1];
    wf.edge(id, next ?? END);
  });
  return wf.compile();
}

/** One step, whose wrapper frontmatter is the thing under test. */
function stepFrontmatter(options: {
  skill: string;
  model?: string;
  tools?: string[];
}): Record<string, string> {
  const wf = workflow({ name: "frontmatter" });
  wf.step("one", options);
  wf.entry("one");
  wf.edge("one", END);
  return frontmatterOf(fileOf(emit(wf.compile()), "agents/step-one.md"));
}

function parseJson(contents: string): Record<string, JsonValue> {
  return JSON.parse(contents) as Record<string, JsonValue>;
}

/**
 * The `PLUGIN` constant the dispatcher is generated around, parsed back out of
 * its source. The dispatcher has no exports and is CommonJS, so reading the
 * literal is the only way to assert on what the emitter baked into it.
 */
function pluginConstant(files: Record<string, string>): {
  gates: Record<string, { resume: string; reject: string }>;
  agents: Record<string, string>;
} {
  const source = fileOf(files, DISPATCHER_PATH);
  const match = /const PLUGIN = (\{[\s\S]*?\n\});\n/.exec(source);
  if (match === null) throw new Error("fixture error: no PLUGIN constant in the dispatcher");
  return JSON.parse(match[1] ?? "") as {
    gates: Record<string, { resume: string; reject: string }>;
    agents: Record<string, string>;
  };
}

/** The compiled matcher registered for one hook event. */
function matcherFor(files: Record<string, string>, event: string): RegExp {
  const hooks = parseJson(fileOf(files, HOOKS_PATH));
  const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
  const entries = events[event] ?? [];
  return new RegExp(String(entries[0]?.matcher));
}

function fileOf(files: Record<string, string>, path: string): string {
  const contents = files[path];
  if (contents === undefined) {
    throw new Error(`fixture error: no "${path}" in [${Object.keys(files).join(", ")}]`);
  }
  return contents;
}

function frontmatterOf(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) throw new Error(`no frontmatter block in:\n${markdown.slice(0, 120)}`);
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const split = line.indexOf(":");
    if (split === -1) continue;
    fields[line.slice(0, split)] = line.slice(split + 1).trim();
  }
  return fields;
}

/** The raw frontmatter block, as the physical lines it occupies. */
function frontmatterLinesOf(markdown: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) throw new Error(`no frontmatter block in:\n${markdown.slice(0, 120)}`);
  return (match[1] ?? "").split("\n");
}

/**
 * The invariant an agent name has to hold whatever the node id was: at most 64
 * characters, alphanumeric at both ends, no doubled separator. A name outside
 * this is refused by the platform, or is not the name the wrapper's filename
 * says it is.
 */
function expectLegalAgentName(name: string): void {
  expect(name.length).toBeLessThanOrEqual(64);
  expect(name).toMatch(/^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/);
}

/**
 * The same invariant for a plugin name (SPEC §2.1): 1-64 characters, alphanumeric
 * at both ends, no doubled separator. Worth checking separately from an agent
 * name because a plugin name is not one string but four. It is the manifest
 * `name`, the `SubagentStop` matcher, the namespace on every command, and the
 * default run command, so one illegal character breaks the whole plugin at once.
 * `slug()` folds `.` to `-`, so a derived name never uses the period the charset
 * would also allow.
 */
function expectLegalPluginName(name: string): void {
  expect(name.length).toBeGreaterThan(0);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(name).toMatch(/^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/);
}

// ---------------------------------------------------------------------------
// The vendored runtime, and the differential it is held to
// ---------------------------------------------------------------------------

/** The half of the package's public seam the dispatcher actually calls. */
interface VendoredRuntime {
  observationsFor(ir: WorkflowIr, state: RunState): ObservationRequest[];
  evaluate(
    ir: WorkflowIr,
    state: RunState,
    resolved: Record<string, ObservationResult>,
  ): Transition;
}

/**
 * The emitted evaluator, loaded as the CommonJS module it is.
 *
 * It has to go through a real file and a real `require`: the point of the test
 * it serves is that the *emitted bytes* behave like `src/evaluate.ts`, and
 * evaluating the source any other way would test something else.
 */
async function vendoredRuntime(): Promise<VendoredRuntime> {
  const { fs, os, path } = await nodeModules();
  const { createRequire } = await import("node:module");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-runtime-"));
  const file = path.join(dir, "minflow-runtime.cjs");
  await fs.writeFile(file, fileOf(emit(tinyIr()), RUNTIME_PATH), "utf8");
  const load = createRequire(file);
  const loaded = load(file) as VendoredRuntime;
  // Required and therefore cached in memory; the directory is no longer needed.
  await fs.rm(dir, { recursive: true, force: true });
  return loaded;
}

/** A run sitting at `node`, otherwise fresh. */
function stateAt(ir: WorkflowIr, node: string): RunState {
  return {
    runId: "run-fixture",
    graphHash: ir.hash,
    node,
    status: "running",
    attempts: {},
    steps: 0,
    outputs: {},
  };
}

/**
 * One resolved-observation map per way an observation can come back.
 *
 * `not-a-string` exists for the judge lane specifically: a verdict that is not a
 * string is a violated contract rather than a verdict that failed to match, and
 * that distinction is one of the places a hand-ported copy would be easiest to
 * get subtly wrong.
 */
function resolvedFrom(
  requests: ObservationRequest[],
  mode: "missing" | "broken" | "true" | "false" | "not-a-string",
): Record<string, ObservationResult> {
  const resolved: Record<string, ObservationResult> = {};
  if (mode === "missing") return resolved;
  const holds = mode === "true";
  for (const request of requests) {
    if (mode === "broken") {
      resolved[request.key] = { ok: false, error: "the observation could not be made" };
      continue;
    }
    if (request.kind === "exitZero" || request.kind === "fileExists") {
      resolved[request.key] = { ok: true, value: holds };
    } else if (request.kind === "payload") {
      resolved[request.key] =
        mode === "not-a-string"
          ? { ok: true, value: "a payload that is a bare string" }
          : {
              ok: true,
              value: { done: holds, blocked: !holds, findings: { count: holds ? 0 : 3 } },
            };
    } else {
      resolved[request.key] =
        mode === "not-a-string"
          ? { ok: true, value: 1 }
          : { ok: true, value: holds ? "yes" : "no" };
    }
  }
  return resolved;
}

/**
 * The payload lanes `observationsFor` will have the host resolve at a node, as
 * `inline` and `file:<path>` labels. Sorted, because order is another test's.
 */
function demandedLanes(ir: WorkflowIr, node: NodeId): string[] {
  const lanes: string[] = [];
  for (const request of observationsFor(ir, stateAt(ir, node))) {
    if (request.kind !== "payload" && request.kind !== "judge") continue;
    const lane = request.from.lane === "file" ? `file:${request.from.path}` : "inline";
    if (!lanes.includes(lane)) lanes.push(lane);
  }
  return lanes.sort();
}

/** The same labels, read back out of a step wrapper's delivery section. */
function promisedLanes(wrapper: string): string[] {
  const lanes: string[] = [];
  for (const match of wrapper.matchAll(/Write your JSON payload to `([^`]+)`/g)) {
    const path = match[1];
    if (path !== undefined && !lanes.includes(`file:${path}`)) lanes.push(`file:${path}`);
  }
  if (wrapper.includes("fenced `json` block")) lanes.push("inline");
  return lanes.sort();
}

/** Recursively freezes, so any write inside `emit` throws instead of passing. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The artifact (SPEC §3.1)
// ---------------------------------------------------------------------------

describe("the artifact", () => {
  it("is exactly this file map: manifest, registrations, runner, one wrapper per node, graph", () => {
    // SPEC §3.1's tree is a partial oracle rather than the assertion: it also
    // lists a hand-written `src/workflow.ts` and an optional package.json plus
    // lockfile, neither of which the emitter produces. This pins what emit()
    // actually returns, and is meant to fail loudly the day another file joins
    // the map.
    //
    // The three commands/ files are load-bearing rather than decoration. The
    // UserPromptExpansion event fires when a *command* expands, so a matcher
    // naming commands that nothing defines can never run, and the plugin it
    // belongs to installs, validates, reads correctly, and does nothing at all.
    expect(Object.keys(emit(exampleIr())).sort()).toEqual(
      [
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
        "hooks/dispatch.cjs",
        "hooks/minflow-runtime.cjs",
        "commands/run-research-ship.md",
        "commands/approve-plan.md",
        "commands/reject-plan.md",
        "agents/runner.md",
        "agents/step-research.md",
        "agents/step-plan.md",
        "agents/step-implement.md",
        "agents/step-review-security.md",
        "workflow.compiled.json",
      ].sort(),
    );
  });

  it("puts nothing but the manifest in .claude-plugin/", () => {
    const inside = Object.keys(emit(exampleIr())).filter((path) =>
      path.startsWith(".claude-plugin/"),
    );
    expect(inside).toEqual([MANIFEST_PATH]);
  });

  it("names the dispatcher .cjs, never .js", () => {
    // Node resolves CJS-vs-ESM from the nearest ancestor package.json, and a
    // compiled plugin usually sits inside the user's repo. A .js dispatcher
    // under "type": "module" dies with "require is not defined" on every fire.
    const paths = Object.keys(emit(exampleIr()));
    expect(paths).toContain("hooks/dispatch.cjs");
    expect(paths.filter((path) => path.endsWith(".js"))).toEqual([]);
  });

  it("writes the IR back verbatim, pretty-printed", () => {
    const ir = exampleIr();
    const emitted = fileOf(emit(ir), COMPILED_GRAPH_PATH);
    expect(JSON.parse(emitted)).toEqual(ir);
    expect(emitted).toContain('\n  "irVersion": 1,');
    expect(emitted.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

describe("the manifest", () => {
  it("emits only fields the validator recognizes", () => {
    // An unrecognized top-level field loads, but `claude plugin validate` warns
    // about it and --strict turns that warning into an error in the user's CI.
    const manifest = parseJson(fileOf(emit(exampleIr()), MANIFEST_PATH));
    expect(Object.keys(manifest).sort()).toEqual(
      ["author", "description", "metadata", "name", "version"].sort(),
    );
  });

  it("always carries an author, because --strict makes a missing one fatal", () => {
    const fallback = parseJson(fileOf(emit(exampleIr()), MANIFEST_PATH));
    expect(fallback.author).toEqual({ name: "minflow" });

    const named = parseJson(fileOf(emit(exampleIr(), { author: "Ariel Arevalo" }), MANIFEST_PATH));
    expect(named.author).toEqual({ name: "Ariel Arevalo" });

    const full = parseJson(
      fileOf(emit(exampleIr(), { author: { name: "Ariel", email: "a@b.c" } }), MANIFEST_PATH),
    );
    expect(full.author).toEqual({ name: "Ariel", email: "a@b.c" });

    // `url` is the third permitted sub-field and is emitted on the same terms:
    // present when given, absent otherwise. toEqual is exact, so each of these
    // also asserts that the sub-fields nobody passed stayed out.
    const linked = parseJson(
      fileOf(
        emit(exampleIr(), { author: { name: "Ariel", url: "https://enki.cr" } }),
        MANIFEST_PATH,
      ),
    );
    expect(linked.author).toEqual({ name: "Ariel", url: "https://enki.cr" });

    const both = parseJson(
      fileOf(
        emit(exampleIr(), { author: { name: "Ariel", email: "a@b.c", url: "https://enki.cr" } }),
        MANIFEST_PATH,
      ),
    );
    expect(both.author).toEqual({ name: "Ariel", email: "a@b.c", url: "https://enki.cr" });
  });

  it("emits homepage and license only when they are given", () => {
    // The manifest schema is closed (SPEC §2.1) and --strict turns an
    // unrecognized or malformed top-level field into a hard error in the user's
    // CI, so both directions matter: a dropped field loses the attribution the
    // caller asked for, and a field emitted empty is a validator failure.
    const bare = parseJson(fileOf(emit(exampleIr()), MANIFEST_PATH));
    expect(bare).not.toHaveProperty("homepage");
    expect(bare).not.toHaveProperty("license");

    const full = parseJson(
      fileOf(
        emit(exampleIr(), { homepage: "https://example.com/wf", license: "MIT" }),
        MANIFEST_PATH,
      ),
    );
    expect(full.homepage).toBe("https://example.com/wf");
    expect(full.license).toBe("MIT");
    // Still nothing outside the permitted ten, and metadata stays last so the
    // hand-readable fields come first.
    expect(Object.keys(full)).toEqual([
      "name",
      "description",
      "version",
      "author",
      "homepage",
      "license",
      "metadata",
    ]);

    // One given and not the other, so neither can be riding on the other's guard.
    const homed = parseJson(
      fileOf(emit(exampleIr(), { homepage: "https://example.com/wf" }), MANIFEST_PATH),
    );
    expect(homed.homepage).toBe("https://example.com/wf");
    expect(homed).not.toHaveProperty("license");

    const licensed = parseJson(fileOf(emit(exampleIr(), { license: "MIT" }), MANIFEST_PATH));
    expect(licensed.license).toBe("MIT");
    expect(licensed).not.toHaveProperty("homepage");
  });

  it("puts the graph hash in metadata, not in a custom top-level field", () => {
    const ir = exampleIr();
    const manifest = parseJson(fileOf(emit(ir), MANIFEST_PATH));
    expect(manifest.metadata).toMatchObject({
      generator: "minflow",
      graphHash: ir.hash,
      workflow: ir.name,
      entry: ir.entry,
      irVersion: "1",
      steps: "4",
    });
    expect(manifest).not.toHaveProperty("graphHash");
    expect(manifest).not.toHaveProperty("hash");
  });

  it("folds the workflow name into a legal plugin name, or takes one given", () => {
    expect(parseJson(fileOf(emit(exampleIr()), MANIFEST_PATH)).name).toBe("research-ship");
    expect(pluginNameFor(exampleIr())).toBe("research-ship");
    expect(pluginNameFor(exampleIr(), { name: "My Workflow!!" })).toBe("my-workflow");
    // 1-64 chars of a-z, 0-9 and -, alphanumeric at both ends, no doubled -.
    expect(pluginNameFor(exampleIr())).toMatch(/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$/);
  });

  it("keeps the plugin name legal at the 64-character boundary", () => {
    // The cap is applied by truncating, and a truncation can land immediately
    // after a separator, so slug() re-trims afterwards. pluginNameFor is the only
    // caller where that shows: agentNames prefixes "step-", so its own cut always
    // lands five characters further into the body and can never sit on a hyphen.
    const ir = exampleIr();
    const cases: [label: string, source: string, expected: string][] = [
      // Exactly at the cap: nothing is cut at all.
      ["at the cap", "b".repeat(64), "b".repeat(64)],
      // One over: the cut lands inside the body, which is the easy case.
      ["one over the cap", "c".repeat(65), "c".repeat(64)],
      // 74 characters once folded, and the cut at 64 lands ON the hyphen, so
      // without the re-trim this is a 64-character name ending in "-".
      ["cut landing on the separator", `${"a".repeat(63)} ${"b".repeat(10)}`, "a".repeat(63)],
      // Two separators in a row fold to one, then the cut lands on it.
      ["cut landing on a folded run", `${"a".repeat(63)}!?!${"b".repeat(10)}`, "a".repeat(63)],
    ];
    for (const [label, source, expected] of cases) {
      const name = pluginNameFor(ir, { name: source });
      expect(`${label}: ${name}`).toBe(`${label}: ${expected}`);
      expectLegalPluginName(name);
    }
  });

  it("truncates two long names onto one, rather than onto two illegal ones", () => {
    // Truncation is lossy and pluginNameFor does not de-duplicate, so two workflows
    // whose names agree for 63 characters compile to the same plugin. That is the
    // documented cost of the cap; what is not acceptable is the collision landing
    // on a trailing hyphen, which is where both of these end without the re-trim.
    const shared = "a".repeat(63);
    const one = pluginNameFor(exampleIr(), { name: `${shared} one` });
    const two = pluginNameFor(exampleIr(), { name: `${shared} two` });
    expect(one).toBe(shared);
    expect(two).toBe(shared);
    expectLegalPluginName(one);
    expectLegalPluginName(two);
  });

  it("propagates a legal name into the manifest, the matcher and the run command", () => {
    // One illegal character reaches four places at once, so the boundary is
    // asserted end to end and not just at pluginNameFor's return.
    const body = "a".repeat(63);
    const files = emit(exampleIr(), { name: `${body} ${"b".repeat(10)}` });
    const manifest = parseJson(fileOf(files, MANIFEST_PATH));
    expect(manifest.name).toBe(body);
    expectLegalPluginName(String(manifest.name));
    expect(matcherFor(files, "SubagentStop").source).toBe(`^${body}:runner$`);
    expect(Object.keys(files)).toContain(`${COMMANDS_DIR}/run-${body}.md`);
    expect(fileOf(files, DISPATCHER_PATH)).toContain(`"runner": "${body}:runner"`);
  });

  it("refuses a name nothing legal survives, at compile time", () => {
    const wf = workflow({ name: "!!!" });
    wf.step("only", { skill: "s" });
    wf.entry("only");
    wf.edge("only", END);
    expect(() => emit(wf.compile())).toThrow(/cannot derive a plugin name/);
  });

  it("defaults the version and describes the graph", () => {
    const manifest = parseJson(fileOf(emit(exampleIr()), MANIFEST_PATH));
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.description).toContain("4 steps");
    expect(parseJson(fileOf(emit(exampleIr(), { version: "1.2.3" }), MANIFEST_PATH)).version).toBe(
      "1.2.3",
    );

    // A one-node graph reads "1 step", not "1 steps".
    const wf = workflow({ name: "singular" });
    wf.step("only", { skill: "s" });
    wf.entry("only");
    wf.edge("only", END);
    expect(parseJson(fileOf(emit(wf.compile()), MANIFEST_PATH)).description).toBe(
      'Compiled minflow workflow "singular": 1 step, entry "only".',
    );
  });

  it("takes a description from options in place of the derived one", () => {
    const given = parseJson(
      fileOf(
        emit(exampleIr(), { description: "Researches a topic, then ships it." }),
        MANIFEST_PATH,
      ),
    );
    expect(given.description).toBe("Researches a topic, then ships it.");
    // The derived line is replaced, not appended to.
    expect(given.description).not.toContain("4 steps");
    // The graph's own numbers stay reachable in metadata, which the override
    // does not touch.
    expect(given.metadata).toMatchObject({ steps: "4" });
  });
});

// ---------------------------------------------------------------------------
// Hook registrations
// ---------------------------------------------------------------------------

describe("the hook registrations", () => {
  it("wraps the event names in a top-level hooks object", () => {
    // Without the wrapper the registration does not load at all, and the
    // validator reports schema errors under the path hooks.<EventName>.
    const registered = parseJson(fileOf(emit(exampleIr()), HOOKS_PATH));
    expect(Object.keys(registered)).toEqual(["hooks"]);
    expect(Object.keys(registered.hooks as Record<string, JsonValue>).sort()).toEqual([
      "SubagentStop",
      "UserPromptExpansion",
    ]);
  });

  it("anchors the SubagentStop matcher to this plugin's runner", () => {
    // Matchers are evaluated unanchored, so a bare name over-matches.
    const hooks = parseJson(fileOf(emit(exampleIr()), HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    const entries = events.SubagentStop ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe("^research-ship:runner$");
    const matcher = new RegExp(String(entries[0]?.matcher));
    expect(matcher.test("research-ship:runner")).toBe(true);
    expect(matcher.test("other:research-ship:runner-helper")).toBe(false);
  });

  it("scopes UserPromptExpansion to the run command and each gate's commands", () => {
    const hooks = parseJson(fileOf(emit(exampleIr()), HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    const entries = events.UserPromptExpansion ?? [];
    expect(entries).toHaveLength(1);
    const matcher = new RegExp(String(entries[0]?.matcher));

    // The matcher is tested against the payload's `command_name`, which is always
    // the plugin-namespaced form. Measured on 2.1.229: a bare name is not merely
    // a different spelling, it is an unknown command, so a matcher written in
    // bare form never fires for anything.
    expect(matcher.test("research-ship:run-research-ship")).toBe(true);
    expect(matcher.test("research-ship:approve-plan")).toBe(true);
    expect(matcher.test("research-ship:reject-plan")).toBe(true);
    // The bare forms must NOT match: matching them would be harmless in practice
    // but would mean the matcher had been built from the wrong string.
    expect(matcher.test("run-research-ship")).toBe(false);
    expect(matcher.test("approve-plan")).toBe(false);
    // Zero idle footprint: nothing else may wake the dispatcher.
    expect(matcher.test("research-ship:approve-plan-later")).toBe(false);
    expect(matcher.test("research-ship:plan")).toBe(false);
    expect(matcher.test("other-plugin:approve-plan")).toBe(false);
    expect(matcher.test("commit")).toBe(false);
  });

  it("escapes a regex metacharacter in a command name, so the matcher matches only itself", () => {
    // A matcher is a regular expression, and a command name is a literal that
    // gets embedded in one. `.` is legal in both a plugin name and a command name
    // and is also "any character", so an unescaped one silently widens the
    // matcher: the dispatcher would wake for commands this plugin never defined,
    // which is the zero-idle-footprint requirement (D9) broken quietly.
    const run = matcherFor(emit(tinyIr(), { command: "ship.it" }), "UserPromptExpansion");
    expect(run.source).toBe("^tiny-flow:ship\\.it$");
    expect(run.test("tiny-flow:ship.it")).toBe(true);
    expect(run.test("tiny-flow:shipXit")).toBe(false);
    expect(run.test("tiny-flow:ship-it")).toBe(false);

    // And in a multi-alternative matcher, where the gate's derived reject command
    // inherits the metacharacter from the resume command it was derived from.
    const gates = matcherFor(emit(gatedIr(["approve-v1.0"])), "UserPromptExpansion");
    expect(gates.test("gated:approve-v1.0")).toBe(true);
    expect(gates.test("gated:reject-v1.0")).toBe(true);
    expect(gates.test("gated:approve-v1X0")).toBe(false);
    expect(gates.test("gated:reject-v1X0")).toBe(false);
  });

  it("registers no gate commands for a graph with no gates", () => {
    const hooks = parseJson(fileOf(emit(tinyIr()), HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    expect(events.UserPromptExpansion?.[0]?.matcher).toBe("^tiny-flow:run-tiny-flow$");
  });

  it("takes the run command from options", () => {
    const hooks = parseJson(fileOf(emit(tinyIr(), { command: "ship-it" }), HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    // Namespaced even when the run command is chosen by the caller.
    expect(events.UserPromptExpansion?.[0]?.matcher).toBe("^tiny-flow:ship-it$");
  });

  it("routes both registrations at the .cjs dispatcher under the plugin root", () => {
    const hooks = parseJson(fileOf(emit(exampleIr()), HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    for (const entries of Object.values(events)) {
      expect(entries[0]?.hooks).toEqual([
        {
          type: "command",
          command: "node",
          args: [`${PLUGIN_ROOT}/hooks/dispatch.cjs`],
        },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate commands
// ---------------------------------------------------------------------------

describe("the commands", () => {
  /** The literal names an anchored matcher accepts, unescaped. */
  function alternativesOf(files: Record<string, string>): string[] {
    const hooks = parseJson(fileOf(files, HOOKS_PATH));
    const events = hooks.hooks as Record<string, Array<Record<string, JsonValue>>>;
    const source = String(events.UserPromptExpansion?.[0]?.matcher);
    const inner = source.replace(/^\^(\(\?:)?/, "").replace(/(\))?\$$/, "");
    return inner.split("|").map((name) => name.replace(/\\(.)/g, "$1"));
  }

  function commandNamesIn(files: Record<string, string>): string[] {
    return Object.keys(files)
      .filter((path) => path.startsWith(`${COMMANDS_DIR}/`))
      .map((path) => path.slice(COMMANDS_DIR.length + 1, -".md".length))
      .sort();
  }

  it("defines exactly the commands its matcher accepts, and no others", () => {
    // The invariant, and why it is one: the hook fires on a command EXPANDING,
    // so a matcher over a command nothing defines is unreachable, and the whole
    // plugin is inert while looking perfectly well-formed. Checked in both
    // directions on purpose: an orphaned matcher alternative is a dead
    // entrypoint, and an orphaned command file is a command that does nothing.
    // The last case carries a regex metacharacter through the whole round trip:
    // escaped into the matcher here, unescaped back out by alternativesOf.
    for (const ir of [
      exampleIr(),
      tinyIr(),
      gatedIr(["approve-plan", "approve-ship"]),
      gatedIr(["approve-v1.0"]),
    ]) {
      const files = emit(ir);
      const plugin = pluginNameFor(ir);
      const accepted = alternativesOf(files).sort();
      const defined = commandNamesIn(files)
        .map((name) => `${plugin}:${name}`)
        .sort();
      expect(accepted).toEqual(defined);
    }
  });

  it("puts commands at the plugin root, never under .claude-plugin/", () => {
    for (const path of Object.keys(emit(exampleIr()))) {
      if (path.endsWith(".md") && path.includes("command")) {
        expect(path.startsWith(`${COMMANDS_DIR}/`)).toBe(true);
      }
    }
  });

  it("gives every command a description, since that is what the picker shows", () => {
    const files = emit(gatedIr(["approve-plan"]));
    for (const name of commandNamesIn(files)) {
      const front = frontmatterOf(fileOf(files, `${COMMANDS_DIR}/${name}.md`));
      expect(front.description ?? "").not.toBe("");
    }
  });

  it("names the runner in its namespaced form inside the run command", () => {
    // A reader following this text by hand needs the form that actually resolves.
    const files = emit(tinyIr());
    expect(fileOf(files, `${COMMANDS_DIR}/run-tiny-flow.md`)).toContain("`tiny-flow:runner`");
  });
});

describe("a gate's two commands", () => {
  it("derives reject-<gate> when nothing survives the approve prefix", () => {
    const files = emit(gatedIr(["approve"]));
    // Stripping unconditionally would leave the malformed "reject-", which names
    // no command, so the gate would have no way to be rejected at all.
    // The dispatcher stores namespaced names because that is the form it will
    // compare against the payload's command_name.
    expect(pluginConstant(files).gates).toEqual({
      approve: { resume: "gated:approve", reject: "gated:reject-approve" },
    });
    const matcher = matcherFor(files, "UserPromptExpansion");
    expect(matcher.test("gated:reject-approve")).toBe(true);
    expect(matcher.test("gated:reject-")).toBe(false);
  });

  it("de-duplicates two gates that derive the same reject command", () => {
    // "approve-plan" strips to "plan"; "plan" has no prefix to strip. Both want
    // "reject-plan", and one command cannot mean two gates: whichever run the
    // dispatcher found first would be the one killed.
    const gates = pluginConstant(emit(gatedIr(["approve-plan", "plan"]))).gates;
    expect(gates["approve-plan"]?.reject).toBe("gated:reject-plan");
    expect(gates.plan?.reject).toBe("gated:reject-plan-2");
  });

  it("never derives a reject command that collides with another gate's resume", () => {
    const gates = pluginConstant(emit(gatedIr(["approve-plan", "reject-plan"]))).gates;
    // "reject-plan" is already somebody's resume command, so the derived one
    // steps aside rather than shadowing it.
    expect(gates["approve-plan"]?.reject).toBe("gated:reject-plan-2");
    expect(gates["reject-plan"]?.reject).toBe("gated:reject-reject-plan");

    const names = Object.values(gates).flatMap((commands) => [commands.resume, commands.reject]);
    expect(new Set(names).size).toBe(names.length);
    const matcher = matcherFor(
      emit(gatedIr(["approve-plan", "reject-plan"])),
      "UserPromptExpansion",
    );
    for (const name of names) expect(matcher.test(name)).toBe(true);
  });
});

describe("a command name", () => {
  it("is folded into a name that cannot leave the commands directory", () => {
    // A command name is also a file name. `opts.command` reaches
    // `commands/<name>.md` directly, so a separator in it writes wherever it
    // points, outside the plugin and outside anything the caller named.
    const files = emit(tinyIr(), { command: "../../evil" });
    expect(Object.keys(files)).toContain(`${COMMANDS_DIR}/evil.md`);
    for (const path of Object.keys(files)) {
      expect(`${path}: ${path.split("/").includes("..")}`).toBe(`${path}: false`);
    }
    // The matcher and the dispatcher's routing table carry the folded name too.
    // Folding the file name alone would leave a command that exists under a name
    // neither of them recognises, so the plugin would install and do nothing.
    expect(matcherFor(files, "UserPromptExpansion").source).toBe("^tiny-flow:evil$");
    expect(fileOf(files, DISPATCHER_PATH)).toContain('"runCommand": "tiny-flow:evil"');
  });

  it("is refused at compile time when nothing legal survives the fold", () => {
    expect(() => emit(tinyIr(), { command: "../.." })).toThrow(/cannot derive a command name/);
    expect(() => emit(gatedIr(["!!!"]))).toThrow(/cannot derive a command name/);
  });

  it("folds a gate's command without touching the gate's own name", () => {
    // The gate names a sign-off and is what a parked run stores; its command is
    // that name folded into what a command may be called. Folding the state key
    // as well would strand every run parked before the recompile.
    const files = emit(gatedIr(["Approve Plan!"]));
    expect(Object.keys(files)).toContain(`${COMMANDS_DIR}/approve-plan.md`);
    expect(pluginConstant(files).gates).toEqual({
      "Approve Plan!": { resume: "gated:approve-plan", reject: "gated:reject-plan" },
    });
    // And the step before the gate tells its reviewer the command, not the gate.
    expect(fileOf(files, "agents/step-s0.md")).toContain("/gated:approve-plan");
  });

  it("refuses a gate that claims the run command, which could never release it", () => {
    // Both would be written to commands/run-gated.md, the gate's overwriting the
    // run command's, and the dispatcher matches the run command first, so this
    // gate would have no way to be released at all.
    expect(() => emit(gatedIr(["run-gated"]))).toThrow(/could never be released/);
    // The same collision approached from the other side.
    expect(() => emit(gatedIr(["approve-plan"]), { command: "approve-plan" })).toThrow(
      /could never be released/,
    );
    // And two gates cannot share one resume command either: one command file
    // cannot mean two gates, and the second would be unreleasable the same way.
    expect(() => emit(gatedIr(["approve plan", "approve-plan"]))).toThrow(
      /cannot release two gates/,
    );
    // A gate whose command merely resembles the run command is fine.
    expect(() => emit(gatedIr(["run-gated-later"]))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

describe("the dispatcher", () => {
  it("keeps a workflow name out of its own syntax", () => {
    // The name is interpolated into a `//` comment. A raw line terminator would
    // push the rest of the sentence onto the next line as code, and a .cjs that
    // does not parse kills every hook fire, silently.
    const wf = workflow({ name: "multi\nline" });
    wf.step("one", { skill: "s" });
    wf.entry("one");
    wf.edge("one", END);
    const source = fileOf(emit(wf.compile()), DISPATCHER_PATH);

    expect(source).toContain('// Generated by minflow from the workflow "multi line".');
    const body = source.slice(source.indexOf("\n") + 1);
    expect(() => new Function(body)).not.toThrow();
  });

  it("is CommonJS and parses as JavaScript", () => {
    const source = fileOf(emit(exampleIr()), DISPATCHER_PATH);
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(source).toContain('require("node:fs")');
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/^export\s/m);
    // Parses the whole file without running it. The shebang is not JS.
    const body = source.slice(source.indexOf("\n") + 1);
    expect(() => new Function(body)).not.toThrow();
  });

  it("reads its state directory from the hook environment and never rebuilds it", () => {
    const source = fileOf(emit(exampleIr()), DISPATCHER_PATH);
    expect(source).toContain("process.env.CLAUDE_PLUGIN_DATA");
    // $CLAUDE_CONFIG_DIR moves the config dir, and a --plugin-dir plugin gets
    // the id "{name}-inline", so any reconstructed path is wrong sooner or later.
    expect(source).not.toContain("plugins/data");
    expect(source).not.toContain(".claude/plugins");
    expect(source).not.toMatch(/homedir\(\)|process\.env\.HOME/);
    // State never goes under the plugin root, which changes on every update.
    expect(source).not.toMatch(/path\.join\(\s*ROOT\s*,\s*"(runs|sessions|trace)"/);
  });

  it("carries the graph's identity but not the graph's logic", () => {
    const ir = exampleIr();
    const source = fileOf(emit(ir), DISPATCHER_PATH);
    expect(source).toContain(`"graphHash": "${ir.hash}"`);
    expect(source).toContain('"runner": "research-ship:runner"');
    expect(source).toContain(`"graphFile": "${COMPILED_GRAPH_PATH}"`);
    // Node id to agent name, since the ids are not legal agent names.
    expect(source).toContain('"review:security": "step-review-security"');
    // Guards stay in the JSON, not inlined here (SPEC D8).
    expect(source).not.toContain("npm test");
    expect(source).not.toContain("Any unresolved findings?");
  });

  it("routes through the shared seam rather than through rules of its own", () => {
    const source = fileOf(emit(exampleIr()), DISPATCHER_PATH);
    // The two functions that decide anything both come from the vendored
    // evaluator. A dispatcher deciding a transition itself would be a second
    // transition semantics, free to drift from the one the IR defines.
    expect(source).toContain('require("./minflow-runtime.cjs")');
    expect(source).toContain("runtime.observationsFor(graph, state)");
    expect(source).toContain("runtime.evaluate(graph, state, resolved)");
    expect(source).not.toContain("TODO(runtime)");
  });

  it("handles every kind of transition the evaluator can return", () => {
    const source = fileOf(emit(exampleIr()), DISPATCHER_PATH);
    // Five kinds, and a missing one is not a compile error anywhere: an
    // unhandled `gate` would look like a dispatcher that simply stops.
    for (const kind of ["advance", "retry", "gate", "end", "error"]) {
      expect(source).toContain(kind);
    }
    // The two that block, and the three that deliberately do not.
    expect(source).toContain('transition.kind === "advance"');
    expect(source).toContain('transition.kind === "retry"');
    expect(source).toContain('transition.kind === "gate"');
    expect(source).toContain('transition.kind === "end"');
  });

  it("resolves guards against the project directory, not against its own cwd", () => {
    // A hook's cwd is not promised to be anything in particular, and every path
    // and command in a graph was written against the user's repository.
    const source = fileOf(emit(exampleIr()), DISPATCHER_PATH);
    expect(source).toContain("process.env.CLAUDE_PROJECT_DIR");
    expect(source).toContain("cwd: PROJECT");
  });
});

// ---------------------------------------------------------------------------
// The vendored runtime
// ---------------------------------------------------------------------------

describe("the vendored evaluator", () => {
  it("is CommonJS, parses, and exports the runtime seam", () => {
    const source = fileOf(emit(exampleIr()), RUNTIME_PATH);
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/^export\s/m);
    expect(source).toContain("module.exports");
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain("observationsFor: observationsFor");
    expect(source).toContain("evaluate: evaluate");
  });

  it("is the same file for every graph, since it carries no graph", () => {
    // The artifact's only graph-shaped file is workflow.compiled.json (D8). If
    // this ever varied by graph, the emitter would have started inlining logic.
    const source = fileOf(emit(exampleIr()), RUNTIME_PATH);
    expect(fileOf(emit(tinyIr()), RUNTIME_PATH)).toBe(source);
    expect(fileOf(emit(gatedIr(["approve-plan"])), RUNTIME_PATH)).toBe(source);
    expect(source).not.toContain("npm test");
    expect(source).not.toContain("research");
  });

  it("agrees with src/evaluate.ts on every transition, so the copy cannot drift", async () => {
    // The one real cost of vendoring instead of resolving the package at run
    // time is that this file is a copy. This is what stops the copy from
    // becoming a second implementation: both are executed over the same graphs,
    // states and observations, and any divergence fails here rather than in
    // somebody's compiled plugin months later.
    const vendored = await vendoredRuntime();
    const graphs = [exampleIr(), tinyIr(), gatedIr(["approve-plan"]), repeatedLaneIr(), judgedIr()];
    const modes = ["missing", "broken", "true", "false", "not-a-string"] as const;
    let compared = 0;

    for (const graph of graphs) {
      for (const node of [...graph.nodes.map((entry) => entry.id), "no-such-node"]) {
        for (const mode of modes) {
          const requests = observationsFor(graph, stateAt(graph, node));
          // The seam itself first: if the two disagree about what to ask, they
          // would disagree about every key they then look results up under.
          expect(vendored.observationsFor(graph, stateAt(graph, node))).toEqual(requests);
          const resolved = resolvedFrom(requests, mode);
          for (const state of [
            stateAt(graph, node),
            { ...stateAt(graph, node), attempts: { "implement:1": 3, "build:1": 9 }, steps: 7 },
            { ...stateAt(graph, node), steps: 1000 },
            { ...stateAt(graph, node), graphHash: "0000000000000000" },
            // Host scratch present, because carrying it through untouched on one
            // kind of transition and dropping it on another is exactly the kind
            // of detail a copy loses.
            { ...stateAt(graph, node), host: { asking: { key: "k" } } },
          ]) {
            expect(vendored.evaluate(graph, state, resolved)).toEqual(
              evaluate(graph, state, resolved),
            );
            compared += 1;
          }
        }
      }
    }
    // The loop above is the assertion; this only stops it passing vacuously.
    expect(compared).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// The dispatcher, executed
// ---------------------------------------------------------------------------
//
// Everything above asserts on emitted text. These run the emitted plugin: the
// file map goes into a temp directory, a hook payload goes in on stdin, and the
// decision, the state files and stderr come back out. It is a stronger test of
// the same bytes, and it is the only way to see the parts that only exist across
// two hook fires, such as a verdict being asked for and then arriving.

/** One hook fire's worth of dispatcher output. */
interface Fired {
  /** The parsed decision, or `null` when the dispatcher rendered none. */
  decision: { decision: string; reason: string } | null;
  /** The block reason, or `""` when nothing was blocked. */
  reason: string;
  stderr: string;
}

interface Harness {
  /** Runs the dispatcher over one hook payload. */
  fire(event: Record<string, JsonValue>): Fired;
  /** Every run state on disk, by run id. */
  runs(): RunState[];
  /** The only run state on disk; fails if there is not exactly one. */
  onlyRun(): RunState;
  /** Writes a file into the project directory the guards resolve against. */
  write(relative: string, contents: string): void;
  /** Reads a file back out of that directory, or `""` when it is not there. */
  read(relative: string): string;
  /**
   * Every trace entry written for every run, in order.
   *
   * The trace outlives the run state on purpose, so it is the only evidence a
   * finished or failed run leaves behind.
   */
  trace(): Record<string, JsonValue>[];
  /** Rewrites the compiled graph, as an editor recompiling mid-run would. */
  editGraph(change: (graph: Record<string, JsonValue>) => void): void;
  /**
   * Starts a run the way the platform actually starts one, in two beats.
   *
   * The command renders NO decision: on `UserPromptExpansion` a `block` cancels
   * the expansion and prints the reason, so the model would never see the
   * command at all. The command's own body is what spawns the runner. The runner
   * then stands by and stops, and it is that stop, a `SubagentStop`, which gets
   * redirected into the first step. Returns the redirect.
   */
  begin(session?: string): Fired;
}

/** A `SubagentStop` payload: the runner has stopped, and this is what it said. */
function stopped(message: string, session = "session-1"): Record<string, JsonValue> {
  return {
    hook_event_name: "SubagentStop",
    session_id: session,
    agent_type: "runner",
    last_assistant_message: message,
  };
}

/** A `UserPromptExpansion` payload, with `command_name` in its namespaced form. */
function typed(command: string, session = "session-1", args = ""): Record<string, JsonValue> {
  return {
    hook_event_name: "UserPromptExpansion",
    session_id: session,
    command_name: command,
    command_args: args,
    command_source: "plugin",
    expansion_type: "slash_command",
  };
}

/** A step's final message: some prose, then the payload as a fenced json block. */
function reported(value: JsonValue, prefix = ""): string {
  return `${prefix}Here is what I did.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * Writes the plugin to a temp directory and hands `body` a way to fire hooks at
 * it, with `$CLAUDE_PLUGIN_DATA`, `$CLAUDE_PLUGIN_ROOT` and `$CLAUDE_PROJECT_DIR`
 * pointing at three directories the test owns. Nothing is written anywhere near
 * the repository, and the whole tree is removed afterwards.
 *
 * `env` adds to the hook environment, which is how a test reaches the knobs a
 * real host would set: the guard budget in particular, since waiting out the
 * default would cost the suite three quarters of a minute per assertion.
 */
async function withPlugin(
  ir: WorkflowIr,
  body: (harness: Harness) => void,
  env: Record<string, string> = {},
): Promise<void> {
  const { fs, os, path } = await nodeModules();
  const { spawnSync } = await import("node:child_process");
  const sync = await import("node:fs");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-dispatch-"));
  try {
    const pluginDir = path.join(root, "plugin");
    const dataDir = path.join(root, "data");
    const projectDir = path.join(root, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await writeFiles(emit(ir), pluginDir);

    const local = (relative: string): string => path.join(pluginDir, ...relative.split("/"));
    const graphFile = local(COMPILED_GRAPH_PATH);

    const harness: Harness = {
      fire(event) {
        const finished = spawnSync(process.execPath, [local(DISPATCHER_PATH)], {
          input: JSON.stringify(event),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: dataDir,
            CLAUDE_PLUGIN_ROOT: pluginDir,
            CLAUDE_PROJECT_DIR: projectDir,
            ...env,
          },
        });
        // A hook that exits non-zero, or throws its way out of main, is a
        // failure of this test wherever it happens: the platform would discard
        // the output and the run would stall with nothing to read.
        expect(finished.status).toBe(0);
        expect(finished.stderr).not.toContain("dispatcher failed");
        const stdout = finished.stdout.trim();
        const decision =
          stdout === "" ? null : (JSON.parse(stdout) as { decision: string; reason: string });
        return {
          decision,
          reason: decision === null ? "" : decision.reason,
          stderr: finished.stderr,
        };
      },
      begin(session = "session-1") {
        const name = pluginNameFor(ir);
        const started = harness.fire(typed(`${name}:run-${name}`, session));
        // Seeding only. A decision here would cancel the command.
        expect(started.decision).toBeNull();
        return harness.fire(stopped("Standing by.", session));
      },
      trace() {
        const dir = path.join(dataDir, "trace");
        if (!sync.existsSync(dir)) return [];
        return sync
          .readdirSync(dir)
          .sort()
          .flatMap((name: string) =>
            sync
              .readFileSync(path.join(dir, name), "utf8")
              .split("\n")
              .filter((line: string) => line.trim() !== "")
              .map((line: string) => JSON.parse(line) as Record<string, JsonValue>),
          );
      },
      runs() {
        const dir = path.join(dataDir, "runs");
        if (!sync.existsSync(dir)) return [];
        return sync
          .readdirSync(dir)
          .sort()
          .map((name) => JSON.parse(sync.readFileSync(path.join(dir, name), "utf8")) as RunState);
      },
      onlyRun() {
        const runs = harness.runs();
        expect(runs).toHaveLength(1);
        return runs[0] as RunState;
      },
      write(relative, contents) {
        const target = path.join(projectDir, ...relative.split("/"));
        sync.mkdirSync(path.dirname(target), { recursive: true });
        sync.writeFileSync(target, contents, "utf8");
      },
      read(relative) {
        const target = path.join(projectDir, ...relative.split("/"));
        return sync.existsSync(target) ? sync.readFileSync(target, "utf8") : "";
      },
      editGraph(change) {
        const graph = JSON.parse(sync.readFileSync(graphFile, "utf8")) as Record<string, JsonValue>;
        change(graph);
        sync.writeFileSync(graphFile, JSON.stringify(graph, null, 2), "utf8");
      },
    };

    body(harness);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("a run, driven through the emitted dispatcher", () => {
  it("starts on the run command: mints a run, seeds state, spawns the runner", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      // Beat one: the command itself. It seeds state and says nothing, because a
      // decision on this event cancels the expansion rather than instructing the
      // conversation. The command's body is what spawns the runner.
      const started = plugin.fire(typed("drivable:run-drivable"));
      expect(started.decision).toBeNull();
      expect(plugin.onlyRun()).toEqual({
        runId: expect.stringMatching(/^run-\d{14}-[0-9a-f]{6}$/),
        graphHash: drivableIr().hash,
        node: "draft",
        status: "running",
        attempts: {},
        steps: 0,
        outputs: {},
        // Marked as not started, so the runner's first stop hands over the entry
        // step instead of evaluating guards on a node that has not run.
        host: { node: "draft", steps: 0, answers: {}, start: true },
      });

      // Beat two: the runner stands by and stops. THIS is the redirect.
      const fired = plugin.fire(stopped("Standing by."));
      expect(fired.decision?.decision).toBe("block");
      expect(fired.reason).toContain("drivable:step-draft");
      // A block on SubagentStop is read BY the runner, so it must name the step.
      // Naming the runner here tells the runner to spawn a second runner, which
      // then spawns the step: a redundant layer holding a context window open for
      // the whole run, and a start path shaped unlike every other transition.
      expect(fired.reason).not.toContain("drivable:runner");
      // And the marker is spent, so the next stop is a real step report.
      expect(plugin.onlyRun().host).toEqual({ node: "draft", steps: 0, answers: {} });
    });
  });

  it("never tells the runner to spawn a runner, on any transition", async () => {
    // The invariant behind the assertion above, checked across every kind of
    // block a run can produce. Only a command body may name the runner, because
    // only the conversation reads one.
    await withPlugin(drivableIr(), (plugin) => {
      const reasons = [
        plugin.begin(),
        plugin.fire(stopped(reported({ done: true }))),
        plugin.fire(stopped("no payload here")),
      ].map((fired) => fired.reason);

      for (const reason of reasons) {
        expect(reason).not.toContain("drivable:runner");
      }
      // And the run did move, so this is not vacuously true on empty reasons.
      expect(reasons.filter((reason) => reason.includes("drivable:step-"))).not.toHaveLength(0);
    });
  });

  it("puts the instruction to spawn the runner in the command body, where it can be seen", () => {
    // Since the hook cannot instruct on this event, the command file carries it.
    // If this text stops naming the runner, a run can never start at all, and no
    // dispatcher test would notice because the dispatcher is not involved.
    const body = fileOf(emit(drivableIr()), "commands/run-drivable.md");
    expect(body).toContain("drivable:runner");
    expect(body).toContain("Agent tool");
    // The first step is deliberately NOT named here: a command file is written at
    // compile time and cannot know where a resumed run is parked.
    expect(body).not.toContain("step-draft");
  });

  it("advances on a passing guard, over a payload wearing a harness marker line", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      // SPEC L17: the platform may prepend a marker line of its own to a
      // subagent's final report. A parser that does not survive it turns every
      // inline payload into a broken contract.
      const fired = plugin.fire(stopped(reported({ done: true }, "[harness: reviewed output]\n")));

      expect(fired.reason).toContain("drivable:step-build");
      const state = plugin.onlyRun();
      expect(state.node).toBe("build");
      expect(state.steps).toBe(1);
      // The payload became the node's output, which is what later steps read.
      expect(state.outputs).toEqual({ draft: { done: true } });
    });
  });

  it("recovers a payload the platform put stray backslashes into", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      // SPEC L17: the same scan that prepends a marker line may also insert
      // backslashes into instruction-shaped text. A JSON string admits a fixed
      // set of escapes and `\!` is not among them, so the block below could not
      // have parsed as written; dropping the stray backslash repairs text that
      // was already invalid rather than rewriting a payload that was fine.
      const mangled = '```json\n{"done": true, "note": "run \\!important"}\n```';
      const fired = plugin.fire(stopped(mangled));

      expect(fired.reason).toContain("drivable:step-build");
      expect(plugin.onlyRun().outputs).toEqual({ draft: { done: true, note: "run !important" } });
    });
  });

  it("retries with the edge's reason, then stops visibly at the limit", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped(reported({ done: true })));

      // `test -f built.txt` is false, and the edge declares retry(2).
      const first = plugin.fire(stopped("I built nothing."));
      expect(first.reason).toContain("the build produced nothing");
      expect(first.reason).toContain("drivable:step-build");
      expect(plugin.onlyRun().attempts).toEqual({ "build:1": 1 });

      plugin.fire(stopped("Still nothing."));
      const exhausted = plugin.fire(stopped("Still nothing."));
      // Past the limit the run stops rather than looping: no decision at all,
      // and the reason on stderr where a human can read it.
      expect(exhausted.decision).toBeNull();
      expect(exhausted.stderr).toContain("retry-limit-exceeded");
      expect(exhausted.stderr).toContain("past its limit of 2");
    });
  });

  it("runs guard commands and file checks against the project directory", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped(reported({ done: true })));

      plugin.write("built.txt", "built");
      expect(plugin.fire(stopped("Built it.")).reason).toContain("drivable:step-ship");

      // The last edge goes to END, and only once its file exists.
      const stalled = plugin.fire(stopped("Shipped it."));
      expect(stalled.decision).toBeNull();
      expect(stalled.stderr).toContain("no-matching-edge");

      plugin.write("shipped.txt", "shipped");
    });
  });

  it("ends the run at END: no decision, and the state is deleted", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped(reported({ done: true })));
      plugin.write("built.txt", "built");
      plugin.fire(stopped("Built it."));
      plugin.write("shipped.txt", "shipped");

      const finished = plugin.fire(stopped("Shipped it."));
      expect(finished.decision).toBeNull();
      expect(finished.stderr).toContain("finished");
      expect(plugin.runs()).toEqual([]);
    });
  });

  it("reads the file lane, and says so when the file is not there", async () => {
    await withPlugin(fileLaneIr(), (plugin) => {
      plugin.begin();

      // Nothing written: a missing payload is a broken contract, never a guard
      // that quietly failed.
      const missing = plugin.fire(stopped("I scanned."));
      expect(missing.decision).toBeNull();
      expect(missing.stderr).toContain("observation-failed");
      expect(missing.stderr).toContain("out/scan.json");

      // The run is over, not merely paused. An errored run kept at status
      // "running" is still a live run: the next stop reloads it, re-evaluates
      // the same failed guard and reports the same error again. There is no
      // resume-from-error path, so leaving it on disk only leaks a run nothing
      // will ever collect.
      expect(plugin.runs()).toHaveLength(0);
      expect(plugin.fire(stopped("I scanned again.")).stderr).not.toContain("observation-failed");

      // The lane itself reads correctly when the step honours its contract.
      plugin.write("out/scan.json", JSON.stringify({ clean: true }));
      plugin.begin();
      const fired = plugin.fire(stopped("I scanned."));
      expect(fired.reason).toContain("file-lane:step-act");
      expect(plugin.onlyRun().outputs).toEqual({ scan: { clean: true } });
    });
  });

  it("tells the step where to write, deriving it from the graph rather than a table", async () => {
    await withPlugin(fileLaneIr(), (plugin) => {
      const fired = plugin.begin();
      expect(fired.reason).toContain("Write your JSON payload to out/scan.json");
    });
  });

  it("parks at a gate without blocking, and resumes in a session that never saw it", async () => {
    await withPlugin(gatedIr(["approve-plan"]), (plugin) => {
      plugin.begin();

      const parked = plugin.fire(stopped("Planned."));
      // A gate ends the run segment: subagents cannot ask a human anything, so
      // there is nothing to block for (SPEC §3.9).
      expect(parked.decision).toBeNull();
      expect(parked.stderr).toContain("/gated:approve-plan");
      expect(plugin.onlyRun()).toMatchObject({
        status: "awaiting",
        gate: "approve-plan",
        node: "s1",
      });

      // A different session id, because state is keyed by run and a gate may be
      // released days later from a session that did not start the run (D11).
      const resumed = plugin.fire(typed("gated:approve-plan", "session-2"));
      // No decision here either: the resume command's body is what spawns a
      // fresh runner, exactly as the run command's body does.
      expect(resumed.decision).toBeNull();
      const state = plugin.onlyRun();
      expect(state.status).toBe("running");
      expect(state.gate).toBeUndefined();

      // The fresh runner stands by, stops, and is redirected into the node the
      // run parked into. The resume command never had to name that node.
      const released = plugin.fire(stopped("Standing by.", "session-2"));
      expect(released.reason).toContain("gated:step-s1");
      expect(fileOf(emit(gatedIr(["approve-plan"])), "commands/approve-plan.md")).toContain(
        "gated:runner",
      );
    });
  });

  it("abandons the run on the reject command, without blocking", async () => {
    await withPlugin(gatedIr(["approve-plan"]), (plugin) => {
      plugin.begin();
      plugin.fire(stopped("Planned."));

      const rejected = plugin.fire(typed("gated:reject-plan", "session-3"));
      expect(rejected.decision).toBeNull();
      expect(rejected.stderr).toContain("abandoned");
      expect(plugin.runs()).toEqual([]);
    });
  });

  it("refuses to resume a run whose graph moved under it", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();
      plugin.editGraph((graph) => {
        graph.hash = "0000000000000000";
      });

      const refused = plugin.fire(stopped(reported({ done: true })));
      expect(refused.decision).toBeNull();
      expect(refused.stderr).toContain("Refusing to resume");
      // Still where it was: a graph that moved must not advance a run against
      // nodes that may have moved with it (L5).
      expect(plugin.onlyRun().node).toBe("draft");
    });
  });

  it("stays silent when the stopping runner belongs to no run of ours", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      // Zero idle footprint (D9): a matcher-scoped hook that fires with no run
      // in flight renders no decision and writes no state.
      const idle = plugin.fire(stopped("Some unrelated agent finished."));
      expect(idle.decision).toBeNull();
      expect(plugin.runs()).toEqual([]);
    });
  });

  it("asks the runner for one word, then routes on the answer it gives", async () => {
    await withPlugin(judgedIr(), (plugin) => {
      plugin.begin();

      // Pass one: a command hook cannot ask the model anything, so the verdict
      // is obtained by asking and being called again.
      const asked = plugin.fire(stopped(reported({ findings: 2 })));
      expect(asked.reason).toContain("Any unresolved findings?");
      expect(asked.reason).toContain("exactly one of these words");
      expect(asked.reason).toContain("no, yes");
      const parked = plugin.onlyRun();
      expect(parked.node).toBe("review");
      expect(parked.steps).toBe(0);
      const host = parked.host as Record<string, JsonValue>;
      expect((host.asking as Record<string, JsonValue>).question).toBe("Any unresolved findings?");
      expect(host.answers).toEqual({});

      // Pass two: the answer arrives as the runner's next message, wrapped in
      // whatever emphasis and punctuation a model reaches for.
      const answered = plugin.fire(stopped("**Yes.**"));
      expect(answered.reason).toContain("judged:step-fix");
      const advanced = plugin.onlyRun();
      expect(advanced.node).toBe("fix");
      // The step's payload survived the round trip. Without it the schema on
      // "review" would have gone unmet and the run would have stopped instead.
      expect(advanced.outputs).toEqual({ review: { findings: 2 } });
      // And the scratch is gone with the departure.
      expect(advanced.host).toBeUndefined();
    });
  });

  it("folds a judge answer onto the verdict an .is() guard fires on", async () => {
    // The guard declares no verdict set, so nothing closes the menu and the
    // dispatcher has to recover "yes" from the graph in order to fold "Yes."
    // onto it. Without that, a byte-exact compare fails, the guard reads as a
    // plain false, and the run takes the next edge to END while reporting that
    // it finished normally: a silent misroute rather than a visible stop.
    await withPlugin(openJudgeIr(), (plugin) => {
      plugin.begin();
      const asked = plugin.fire(stopped("Drafted."));
      expect(asked.reason).toContain("Is it good?");

      const answered = plugin.fire(stopped("Yes."));
      expect(answered.reason).toContain("open-judge:step-build");
    });
  });

  it("leaves an answer no .is() guard names alone, since that set is open", async () => {
    // The mirror of the case above. A declared set is closed and an answer
    // outside it is a broken contract, but .is() declares nothing, so an answer
    // of "no" is a legitimate verdict that simply is not this edge's, and the
    // run should take the next edge rather than stop.
    await withPlugin(openJudgeIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped("Drafted."));
      const answered = plugin.fire(stopped("no"));
      expect(answered.decision).toBeNull();
      expect(answered.stderr).toContain("finished");
      expect(answered.stderr).not.toContain("observation-failed");
    });
  });

  it("asks again on the second lap, rather than routing on the first lap's verdict", async () => {
    await withPlugin(judgedIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped(reported({ findings: 2 })));
      plugin.fire(stopped("yes"));
      // Back round the loop: fix has no guard, so it advances straight to review.
      expect(plugin.fire(stopped("Fixed.")).reason).toContain("judged:step-review");

      const asked = plugin.fire(stopped(reported({ findings: 0 })));
      // Reusing the recorded "yes" here would send this loop round forever, and
      // nothing in the transition would look wrong while it did.
      expect(asked.reason).toContain("Any unresolved findings?");
      expect((plugin.onlyRun().host as Record<string, JsonValue>).answers).toEqual({});

      const finished = plugin.fire(stopped("no"));
      expect(finished.decision).toBeNull();
      expect(finished.stderr).toContain("finished");
      expect(plugin.runs()).toEqual([]);
    });
  });

  it("quotes a file-lane payload into the question, since the runner cannot open it", async () => {
    await withPlugin(judgedFileIr(), (plugin) => {
      plugin.begin();
      plugin.write("out/review.json", JSON.stringify({ findings: ["a dangling pointer"] }));

      const asked = plugin.fire(stopped("Reviewed."));
      // The runner has the Agent tool and nothing else, so a payload it is asked
      // to judge has to travel to it inside the question.
      expect(asked.reason).toContain("out/review.json");
      expect(asked.reason).toContain("a dangling pointer");

      // A marker line on the answer too: the same platform behaviour that
      // mangles a payload can mangle a one-word reply.
      const answered = plugin.fire(stopped("[harness: checked]\nno"));
      expect(answered.decision).toBeNull();
      expect(answered.stderr).toContain("finished");
    });
  });

  it("refuses to guess which run a gate command meant, and names the choices", async () => {
    await withPlugin(gatedIr(["approve-plan"]), (plugin) => {
      // Two runs parked at one gate, started from two sessions.
      plugin.begin("session-a");
      plugin.fire(stopped("Planned.", "session-a"));
      plugin.begin("session-b");
      plugin.fire(stopped("Planned.", "session-b"));
      expect(plugin.runs()).toHaveLength(2);

      // From an unrelated session, neither run is the obvious one. Releasing the
      // wrong run is worse than asking which.
      const ambiguous = plugin.fire(typed("gated:approve-plan", "session-c"));
      expect(ambiguous.decision).toBeNull();
      expect(ambiguous.stderr).toContain("2 runs are parked");

      // Named explicitly, it releases that one and leaves the other parked.
      const chosen = plugin.runs()[1] as RunState;
      const resumed = plugin.fire(typed("gated:approve-plan", "session-c", chosen.runId));
      // Same two beats as starting: the command seeds, the runner's stand-by stop
      // is what gets redirected.
      expect(resumed.decision).toBeNull();
      const released = plugin.fire(stopped("Standing by.", "session-c"));
      expect(released.reason).toContain("gated:step-s1");
      const after = plugin.runs();
      expect(after.map((state) => state.status)).toEqual(["awaiting", "running"]);
    });
  });

  it("finds the run its own session started, without being told which", async () => {
    await withPlugin(gatedIr(["approve-plan"]), (plugin) => {
      plugin.begin("session-a");
      plugin.fire(stopped("Planned.", "session-a"));
      plugin.begin("session-b");
      plugin.fire(stopped("Planned.", "session-b"));

      // Ambiguous to a stranger, unambiguous here: this session started one of
      // them, and the session pointer is a hint that finds a run even though it
      // is never the key one is stored under.
      const resumed = plugin.fire(typed("gated:approve-plan", "session-a"));
      expect(resumed.decision).toBeNull();
      expect(resumed.stderr).not.toContain("runs are parked");

      // The right one was released: session-a's run is running again, session-b's
      // is still parked.
      const byStatus = plugin
        .runs()
        .map((state) => state.status)
        .sort();
      expect(byStatus).toEqual(["awaiting", "running"]);
      expect(plugin.fire(stopped("Standing by.", "session-a")).reason).toContain("gated:step-s1");
    });
  });

  it("stops on a verdict outside the declared set instead of guessing one", async () => {
    await withPlugin(judgedIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped(reported({ findings: 2 })));

      const confused = plugin.fire(stopped("It depends, honestly."));
      expect(confused.decision).toBeNull();
      expect(confused.stderr).toContain("observation-failed");
      expect(confused.stderr).toContain("declared verdicts");
    });
  });

  it("runs each guard command once per visit, not once per hook fire", async () => {
    await withPlugin(tickAndJudgeIr(), (plugin) => {
      plugin.begin();

      // Pass one: the command runs, and the unanswered judge question ends the
      // pass. Pass two brings the answer, and the transition is decided from the
      // exit code pass one already established.
      const asked = plugin.fire(stopped("Reviewed."));
      expect(asked.reason).toContain("Any findings?");
      expect(plugin.read("ticks.txt")).toBe("x");

      const answered = plugin.fire(stopped("yes"));
      expect(answered.reason).toContain("tick-and-judge:step-fix");
      // One transition, one run of the command. A guard command is arbitrary
      // shell: `npm test` twice is a suite run twice, and a counter moved twice
      // is a graph whose own guard changed the thing it was measuring.
      expect(plugin.read("ticks.txt")).toBe("x");
    });
  });

  it("resolves a guard again on the next visit, since the scratch is scoped to one", async () => {
    // The other half of the cache: it is scoped to a node and a step count, so
    // it can shorten one visit and can never decide the next one. Without this
    // the fix above would be a cache that outlives its answer.
    await withPlugin(tickAndJudgeIr(), (plugin) => {
      plugin.begin();
      plugin.fire(stopped("Reviewed."));
      plugin.fire(stopped("yes"));
      expect(plugin.read("ticks.txt")).toBe("x");

      // fix has one unconditional edge to END, so the run finishes there. A
      // second run walks the same node again and pays for the command again.
      plugin.fire(stopped("Fixed."));
      plugin.begin();
      plugin.fire(stopped("Reviewed again."));
      expect(plugin.read("ticks.txt")).toBe("xx");
    });
  });

  it("stops with a budget it can name when the guards outlive the hook", async () => {
    await withPlugin(
      slowGuardsIr(),
      (plugin) => {
        plugin.begin();
        const stalled = plugin.fire(stopped("Built it."));

        // Neither command is slow on its own, and a per-command bound would let
        // both through. The hook they share is what has a deadline, and a hook
        // cancelled for outrunning it is discarded whole: no decision, no
        // message, a runner that stops for real and a state left at "running"
        // with nothing to explain it. Stopping here is the visible alternative.
        expect(stalled.decision).toBeNull();
        expect(stalled.stderr).toContain("observation-failed");
        expect(stalled.stderr).toContain("guard budget");
        expect(stalled.stderr).toContain("sleep 1 && true");
        // And it did not quietly take the transition anyway.
        expect(stalled.stderr).not.toContain("slow-guards:step-ship");
      },
      { MINFLOW_GUARD_BUDGET_MS: "1200" },
    );
  });

  it("names the payload that never parsed, not the round trip that followed it", async () => {
    await withPlugin(judgedIr(), (plugin) => {
      plugin.begin();

      // The step returns no payload at all, on a pass that also has a judge
      // question to ask, so nothing is reported until the answer arrives.
      const asked = plugin.fire(stopped("Reviewed it, but I forgot the JSON."));
      expect(asked.reason).toContain("Any unresolved findings?");

      const answered = plugin.fire(stopped("no"));
      expect(answered.decision).toBeNull();
      expect(answered.stderr).toContain("observation-failed");
      // The cause is a payload the step never wrote. Reporting the judge round
      // trip instead sends a reader to redesign a lane that was working, over a
      // step that simply did not do what it was told.
      expect(answered.stderr).toContain("no JSON payload could be parsed");
      expect(answered.stderr).not.toContain("the inline payload is gone");
    });
  });

  it("stops when the payload cannot be parsed, rather than reading it as false", async () => {
    await withPlugin(drivableIr(), (plugin) => {
      plugin.begin();

      const unparseable = plugin.fire(stopped("I finished, but I forgot the JSON."));
      expect(unparseable.decision).toBeNull();
      // A violated contract is an error, never a guard that happens to fail:
      // "done" is absent here, and reading that as `done: false` would route the
      // run down a branch it was never meant to take.
      expect(unparseable.stderr).toContain("observation-failed");
      // Ended, with the final state preserved in the trace rather than on disk:
      // state is ephemeral and the trace is what survives a run (D11).
      expect(plugin.runs()).toHaveLength(0);
      expect(plugin.trace()).toContainEqual(
        expect.objectContaining({ decision: "stopped", code: "observation-failed" }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe("the step wrappers", () => {
  it("never puts a colon in an agent name, because the platform refuses to load it", () => {
    const files = emit(exampleIr());
    const wrapper = fileOf(files, "agents/step-review-security.md");
    expect(frontmatterOf(wrapper).name).toBe("step-review-security");
    for (const [path, contents] of Object.entries(files)) {
      if (!path.startsWith("agents/")) continue;
      expect(frontmatterOf(contents).name).not.toContain(":");
      expect(frontmatterOf(contents).name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("keeps the file name and the agent name in step, since both are scoped", () => {
    const files = emit(exampleIr());
    for (const [path, contents] of Object.entries(files)) {
      if (!path.startsWith("agents/")) continue;
      expect(`agents/${frontmatterOf(contents).name}.md`).toBe(path);
    }
  });

  it("resolves lossy-sanitization collisions deterministically", () => {
    const ir = collidingIr();
    expect(agentNames(ir)).toEqual({
      "Review: Security": "step-review-security",
      "review/security": "step-review-security-2",
      "!!!": "step-node",
    });
    expect(Object.keys(emit(ir))).toContain("agents/step-review-security-2.md");
  });

  it("stays inside the 64-character cap, alphanumeric at both ends, at the boundary", () => {
    // slug() promises alphanumeric ends; the cap is applied by truncation, and a
    // truncation can land immediately after a hyphen.
    const long = "a".repeat(58);
    const ids = [
      "b".repeat(64),
      "c".repeat(65),
      // 69 characters, whose cut at 64 lands one past a hyphen.
      `${long} ${"d".repeat(10)}`,
    ];
    const names = Object.values(agentNames(idIr(ids)));
    expect(names).toHaveLength(3);
    for (const name of names) expectLegalAgentName(name);
    expect(names[2]).toBe(`step-${long}`);
  });

  it("resolves a collision that only exists after truncation", () => {
    const shared = "e".repeat(59);
    const names = agentNames(idIr([`${shared}-one`, `${shared}-two`]));
    const derived = Object.values(names);
    expect(derived[0]).toBe(`step-${shared}`);
    expect(derived[1]).toBe(`step-${"e".repeat(57)}-2`);
    expect(new Set(derived).size).toBe(derived.length);
    for (const name of derived) expectLegalAgentName(name);
  });

  it("preloads the node's skill, which is how a user's file becomes a node", () => {
    const front = frontmatterOf(fileOf(emit(exampleIr()), "agents/step-research.md"));
    expect(front.skills).toBe("[research-topic]");
  });

  it("emits model, maxTurns and tools only when the node sets them", () => {
    const files = emit(exampleIr());
    const research = frontmatterOf(fileOf(files, "agents/step-research.md"));
    expect(research.model).toBe("haiku");
    expect(research).not.toHaveProperty("maxTurns");
    expect(research).not.toHaveProperty("tools");

    const implement = frontmatterOf(fileOf(files, "agents/step-implement.md"));
    expect(implement.maxTurns).toBe("25");
    expect(implement.tools).toBe("Read, Write");
    expect(implement).not.toHaveProperty("model");

    const plan = frontmatterOf(fileOf(files, "agents/step-plan.md"));
    expect(Object.keys(plan).sort()).toEqual(["description", "name", "skills"]);
  });

  it("emits an explicit empty sequence for an empty tool allowlist, never a bare key", () => {
    // A bare `tools:` is YAML null, which the platform reads as "inherit the
    // default set", the opposite of the empty allowlist the author asked for.
    expect(stepFrontmatter({ skill: "s", tools: [] }).tools).toBe("[]");
  });

  it("quotes a tool entry a plain scalar cannot carry, and takes the whole field with it", () => {
    // A leading `*` opens an alias, so the wrapper stops parsing as YAML. And a
    // quote inside a plain scalar is a literal character rather than quoting, so
    // one entry needing quotes moves the entire field into a flow sequence.
    expect(stepFrontmatter({ skill: "s", tools: ["Read", "mcp__server__*"] }).tools).toBe(
      '[Read, "mcp__server__*"]',
    );
    expect(stepFrontmatter({ skill: "s", tools: ["*"] }).tools).toBe('["*"]');
    expect(stepFrontmatter({ skill: "s", tools: ["Read, Write"] }).tools).toBe('["Read, Write"]');
    // Measured on 2.1.229: the comma-joined plain form survives for plain entries.
    expect(stepFrontmatter({ skill: "s", tools: ["Read", "Write"] }).tools).toBe("Read, Write");
  });

  it("quotes a name a YAML scalar resolver would hand back as a non-string", () => {
    // An unquoted `true`, `no`, `null` or `2` arrives as a boolean, a null or a
    // number, so the preload matches no skill and the step runs without its
    // instructions, and a failed preload is only a debug-log warning.
    const resolved = [
      ...["true", "False", "TRUE", "yes", "NO", "on", "Off", "y", "n"],
      ...["null", "Null", "NULL"],
      ...["1", "42", "0755", "0x1f", "0b1010", "1_000"],
      ...["1.5", "0.0", "1e3", "3.14"],
    ];
    for (const name of resolved) {
      const front = stepFrontmatter({ skill: name, model: name });
      expect(front.skills).toBe(`["${name}"]`);
      expect(front.model).toBe(`"${name}"`);
    }
  });

  it("leaves a name that genuinely resolves as a string unquoted", () => {
    for (const name of ["haiku", "research-topic", "1.2.3", "y2", "on-call", "no-op"]) {
      const front = stepFrontmatter({ skill: name, model: name });
      expect(front.skills).toBe(`[${name}]`);
      expect(front.model).toBe(name);
    }
  });

  it("quotes a description that would otherwise break the YAML", () => {
    const description = frontmatterOf(fileOf(emit(exampleIr()), "agents/step-plan.md")).description;
    // The workflow name contains a quote-forcing character, so the scalar has
    // to arrive double-quoted or the file does not parse as YAML at all.
    expect(description?.startsWith('"')).toBe(true);
    expect(() => JSON.parse(String(description))).not.toThrow();
  });

  it("collapses a line terminator out of every frontmatter description", () => {
    // A description is a YAML scalar, and both the workflow name and the node id
    // are interpolated into one. A line terminator in either has to be gone by
    // the time it lands: even quoted, where it survives as an escape rather than
    // splitting the line, it leaves a multi-line description in the picker, and
    // one unquoted would end the scalar and turn the rest of the sentence into a
    // key the parser cannot read.
    const wf = workflow({ name: "multi\nline" });
    wf.step("first\nsecond", { skill: "s" });
    wf.entry("first\nsecond");
    wf.edge("first\nsecond", END);
    const files = emit(wf.compile());

    const described: [where: string, markdown: string, fields: number][] = [
      ["the runner", fileOf(files, RUNNER_PATH), 3],
      ["the step wrapper", fileOf(files, "agents/step-first-second.md"), 3],
      ["the run command", fileOf(files, `${COMMANDS_DIR}/run-multi-line.md`), 1],
    ];
    for (const [where, markdown, fields] of described) {
      // One physical line per field: nothing spilled into a line of its own.
      const lines = frontmatterLinesOf(markdown);
      expect(`${where}: ${lines.length}`).toBe(`${where}: ${fields}`);
      for (const line of lines) expect(line).toMatch(/^[A-Za-z]+: \S/);

      // And the value the resolver hands back is a single line too. It arrives
      // double-quoted because the interpolated names carry quotes, and a
      // double-quoted YAML scalar is JSON, so this both parses it and proves it
      // parses at all.
      const description = String(frontmatterOf(markdown).description);
      expect(description.startsWith('"')).toBe(true);
      const text = JSON.parse(description) as string;
      // Every line terminator YAML knows, since `\s` covers all of them.
      expect(`${where}: ${/[\n\r\u2028\u2029]/.test(text)}`).toBe(`${where}: false`);
      expect(text).toContain('"multi line"');
    }

    // The node id is collapsed too, not only the workflow name.
    const wrapper = frontmatterOf(fileOf(files, "agents/step-first-second.md"));
    expect(JSON.parse(String(wrapper.description)) as string).toContain('Step "first second"');
  });

  it("restricts the runner to the Agent tool and gives it no turn ceiling", () => {
    const runner = fileOf(emit(exampleIr()), RUNNER_PATH);
    const front = frontmatterOf(runner);
    expect(front.name).toBe("runner");
    expect(front.tools).toBe("Agent");
    // One runner is redirected once per transition for a whole run segment, so
    // a ceiling here would be a ceiling on graph length.
    expect(front).not.toHaveProperty("maxTurns");
    expect(runner).toContain("verbatim");
  });

  it("carries the step's prompt, params and output schema into the wrapper", () => {
    const wrapper = fileOf(emit(exampleIr()), "agents/step-research.md");
    expect(wrapper).toContain("Research the topic and write up what you found.");
    expect(wrapper).toContain("- `depth`: 3");
    expect(wrapper).toContain('"additionalProperties": false');
  });

  it("tells a step whose successor is gated that the run parks", () => {
    const wrapper = fileOf(emit(exampleIr()), "agents/step-plan.md");
    // Namespaced, because the bare form is an unknown command: telling a
    // reviewer to run `/approve-plan` would send them to a dead end.
    expect(wrapper).toContain("/research-ship:approve-plan");
    expect(wrapper).not.toContain("`/approve-plan`");
    expect(fileOf(emit(exampleIr()), "agents/step-research.md")).not.toContain("parks");
  });
});

// ---------------------------------------------------------------------------
// Derived delivery obligations
// ---------------------------------------------------------------------------

describe("derived delivery obligations", () => {
  it("unions every lane the outgoing guards read, nested ones included", () => {
    const ir = exampleIr();
    expect(obligationsFor(ir, "research")).toEqual({
      inline: false,
      payloadFiles: [".minflow/research.json"],
      fileChecks: ["notes.md"],
      commandChecks: [],
    });
    expect(obligationsFor(ir, "implement")).toEqual({
      inline: false,
      payloadFiles: [],
      fileChecks: [],
      commandChecks: ["npm test"],
    });
    // The judge on both branch edges reads one lane, and it defaults to inline.
    expect(obligationsFor(ir, "review:security")).toEqual({
      inline: true,
      payloadFiles: [],
      fileChecks: [],
      commandChecks: [],
    });
    // Nothing reads anything out of `plan`: its only edge is an always gate.
    expect(obligationsFor(ir, "plan")).toEqual({
      inline: false,
      payloadFiles: [],
      fileChecks: [],
      commandChecks: [],
    });
  });

  it("records each lane, path and command once, in first-encountered order", () => {
    // Two edges out of one node routinely read the same file and run the same
    // check. That is what a fan-out over one payload looks like. The obligation
    // is a set with an order, not a bag: a duplicate would print the same
    // instruction twice in the wrapper, and a step told to write one file twice
    // reads as a step told to write two.
    const ir = repeatedLaneIr();
    expect(obligationsFor(ir, "fan")).toEqual({
      inline: false,
      // The third edge repeats the first's lane, path and command exactly, with
      // the second edge's in between, so each list below is the order they were
      // first met: not sorted, not last-wins, and not the reverse.
      payloadFiles: ["out/first.json", "out/second.json", "out/third.json"],
      fileChecks: ["notes.md", "dist/out.txt", "build.log"],
      commandChecks: ["npm test", "npm run lint", "npm run build"],
    });

    // And the wrapper it feeds says each of them exactly once.
    const wrapper = fileOf(emit(ir), "agents/step-fan.md");
    const occurrences = (needle: string): number => wrapper.split(needle).length - 1;
    expect(occurrences("Write your JSON payload to `out/first.json`")).toBe(1);
    expect(occurrences("`notes.md` must exist on disk")).toBe(1);
    expect(occurrences("`npm test` will be run")).toBe(1);
  });

  it("tells the step to write the payload to the path its guard reads", () => {
    const wrapper = fileOf(emit(exampleIr()), "agents/step-research.md");
    expect(wrapper).toContain("Write your JSON payload to `.minflow/research.json`");
    // The author declared the lane on the edge; nobody hand-maintained this.
    // The inline block is asked for as well, and only because this node declares
    // a schema: `observationsFor` adds a payload request on the default lane for
    // any node that does, whatever its guards read. A wrapper that decided the
    // question from the guards alone would leave this step's contract unmet.
    expect(wrapper).toContain("fenced `json` block");

    // A node with the same file lane and no schema is told about the file only.
    expect(fileOf(emit(fileLaneIr()), "agents/step-scan.md")).not.toContain("fenced `json` block");
  });

  it("asks for exactly the lanes the evaluator will demand, on every node", () => {
    // The two sides of one contract, computed and compared rather than pinned to
    // a string. The wrapper is written at compile time and the demand is made at
    // run time, by `observationsFor`, so nothing but this stops them drifting:
    // a step told to write only a file, whose node also declares a schema, is
    // failed at run time for an inline payload nobody ever asked it for.
    for (const ir of [exampleIr(), tinyIr(), schemaOverFileIr(), repeatedLaneIr(), judgedIr()]) {
      const files = emit(ir);
      const names = agentNames(ir);
      for (const node of ir.nodes) {
        const wrapper = fileOf(files, `agents/${names[node.id]}.md`);
        expect(`${node.id}: ${promisedLanes(wrapper).join(", ")}`).toBe(
          `${node.id}: ${demandedLanes(ir, node.id).join(", ")}`,
        );
      }
    }
  });

  it("asks for the inline lane when that is what a guard reads", () => {
    const wrapper = fileOf(emit(exampleIr()), "agents/step-review-security.md");
    expect(wrapper).toContain("fenced `json` block");
    expect(wrapper).not.toContain("Write your JSON payload to");
  });

  it("surfaces fileExists and exitZero checks as obligations of the step before them", () => {
    const files = emit(exampleIr());
    expect(fileOf(files, "agents/step-research.md")).toContain("`notes.md` must exist on disk");
    expect(fileOf(files, "agents/step-implement.md")).toContain("`npm test` will be run");
  });

  it("asks nothing of a step nothing reads", () => {
    const wrapper = fileOf(emit(exampleIr()), "agents/step-plan.md");
    expect(wrapper).not.toContain("## Delivery");
    expect(wrapper).not.toContain("## Checked after you finish");
  });

  it("still asks for the payload inline when a schema is declared and no lane reads it", () => {
    const wf = workflow({ name: "schema-only" });
    wf.step("one", { skill: "s", output: { ok: "boolean" } });
    wf.entry("one");
    wf.edge("one", END);
    const wrapper = fileOf(emit(wf.compile()), "agents/step-one.md");
    expect(wrapper).toContain("fenced `json` block");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("emit", () => {
  it("is deterministic: the same graph twice yields deeply equal maps", () => {
    const ir = exampleIr();
    expect(emit(ir)).toEqual(emit(ir));
    // And two independently built copies of the same graph agree too.
    expect(emit(exampleIr(), { version: "1.0.0" })).toEqual(
      emit(exampleIr(), { version: "1.0.0" }),
    );
  });

  it("is a function of the graph's value, not of anyone's key insertion order", () => {
    // Two builds of one graph whose `params` and `schema` objects were typed in
    // opposite orders. Key order carries no meaning in the IR, and `graphHash`
    // sorts before it digests, so these are the same graph by the only
    // definition that counts, the one a resume compares against.
    const forward = keyOrderIr("forward");
    const reverse = keyOrderIr("reverse");
    expect(reverse.hash).toBe(forward.hash);

    // Deep equality over a map of strings is byte equality per file.
    expect(emit(forward)).toEqual(emit(reverse));
    expect(fileOf(emit(forward), COMPILED_GRAPH_PATH)).toBe(
      fileOf(emit(reverse), COMPILED_GRAPH_PATH),
    );
  });

  it("renders the graph, params and schema in canonical key order", () => {
    const files = emit(keyOrderIr("reverse"));
    // Sorted at every level, including inside a nested schema object, so the
    // rendering is canonical rather than merely stable for this one fixture.
    expect(fileOf(files, COMPILED_GRAPH_PATH).startsWith('{\n  "edges": [')).toBe(true);
    const wrapper = fileOf(files, "agents/step-one.md");
    expect(wrapper).toContain(
      ["{", '  "properties": {', '    "alpha": {', '      "description": "a",'].join("\n"),
    );
    expect(wrapper.indexOf("- `alpha`: 1")).toBeGreaterThan(-1);
    expect(wrapper.indexOf("- `alpha`: 1")).toBeLessThan(wrapper.indexOf('- `beta`: "two"'));
  });

  it("does not mutate the graph it is given", () => {
    const ir = deepFreeze(exampleIr());
    expect(() => emit(ir)).not.toThrow();
    expect(ir).toEqual(exampleIr());
  });

  it("touches no filesystem: the module imports no node builtin at module scope", async () => {
    const { fs } = await nodeModules();
    // Relative to the vitest root, which is this repository.
    const source = await fs.readFile("src/emit/claude-code.ts", "utf8");
    // The only node imports are the lazy ones inside writeFiles, awaited at call
    // time rather than at module scope. The module does import `hash.ts`,
    // which reaches node:crypto at module scope; that is deliberate, since one
    // definition of canonical form serves the hash and the emitter both, and
    // hashing is not I/O, so emit() stays a pure function of the graph.
    expect(source).not.toMatch(/^import[^\n]*"node:/m);
    expect(source).not.toMatch(/^const \{[^\n]*await import/m);
    // Synchronous, so it cannot be awaiting I/O either.
    expect(emit.constructor.name).toBe("Function");
  });
});

// ---------------------------------------------------------------------------
// writeFiles: the emitter's only I/O
// ---------------------------------------------------------------------------

describe("writeFiles", () => {
  it("puts the map on disk byte for byte, nested directories and all, and overwrites", async () => {
    const { fs, os, path } = await nodeModules();
    // Unique per run and under the OS temp dir, so two runs of this suite cannot
    // collide and nothing is written anywhere near the repository.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-emit-"));
    try {
      const files = emit(exampleIr());
      const written = await writeFiles(files, dir);

      expect(written).toHaveLength(Object.keys(files).length);
      expect(written).toEqual([...written].sort());

      for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(dir, ...relative.split("/"));
        expect(written).toContain(target);
        expect(await fs.readFile(target, "utf8")).toBe(contents);
      }

      // Named explicitly, so the loop above cannot pass by iterating nothing.
      const manifest = path.join(dir, ".claude-plugin", "plugin.json");
      const wrapper = path.join(dir, "agents", "step-research.md");
      expect(await fs.readFile(manifest, "utf8")).toBe(fileOf(files, MANIFEST_PATH));
      expect(await fs.readFile(wrapper, "utf8")).toBe(fileOf(files, "agents/step-research.md"));

      // Directories, created on the way, not filenames containing a slash.
      expect((await fs.stat(path.join(dir, ".claude-plugin"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(dir, "agents"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(dir, "hooks"))).isDirectory()).toBe(true);
      expect((await fs.stat(manifest)).isFile()).toBe(true);

      // A second write over the same directory overwrites and does not throw:
      // regenerating in place is the normal case, and an EEXIST here would make
      // every rebuild a manual cleanup.
      const rebuilt = emit(exampleIr(), { version: "9.9.9" });
      await expect(writeFiles(rebuilt, dir)).resolves.toEqual(written);
      expect(await fs.readFile(manifest, "utf8")).toBe(fileOf(rebuilt, MANIFEST_PATH));
      expect(await fs.readFile(manifest, "utf8")).toContain('"version": "9.9.9"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a path that leaves the directory it was given, and writes nothing", async () => {
    const { fs, os, path } = await nodeModules();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-escape-"));
    try {
      const dest = path.join(dir, "plugin");
      // This function takes a map, not a graph, so it cannot assume the map came
      // from emit(). A path that leaves the destination is refused here, at the
      // one place in the emitter that touches a filesystem, rather than trusted
      // to have been sanitized upstream.
      const escapes = [
        "../escaped.md",
        "commands/../../escaped.md",
        path.join(dir, "absolute.md"),
        `${dir}-sibling/near-miss.md`,
      ];
      for (const relative of escapes) {
        await expect(writeFiles({ [relative]: "x" }, dest)).rejects.toThrow(/refusing to write/);
      }

      // Whole-map refusal: the legal entry alongside an escaping one is not
      // written either, so a rejected map leaves no half-plugin behind.
      await expect(
        writeFiles({ "commands/fine.md": "x", "../escaped.md": "x" }, dest),
      ).rejects.toThrow(/refusing to write/);
      expect(await fs.readdir(dir)).toEqual([]);

      // The same relative path one directory deeper is inside, and is written.
      await writeFiles({ "commands/fine.md": "x" }, dest);
      expect(await fs.readFile(path.join(dest, "commands", "fine.md"), "utf8")).toBe("x");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe("a small compiled workflow", () => {
  it("emits this, byte for byte", () => {
    const files = emit(tinyIr(), { author: "Ariel Arevalo <ariel@enki.cr>" });
    // The dispatcher and the runtime are asserted structurally and by execution
    // above. Both are fixed skeletons, the dispatcher's only graph-dependent
    // part being its PLUGIN constant and the runtime having none at all, so
    // pasting them here would bury everything that actually varies.
    const golden: Record<string, string> = {};
    for (const [path, contents] of Object.entries(files)) {
      if (path !== DISPATCHER_PATH && path !== RUNTIME_PATH) golden[path] = contents;
    }
    expect(golden).toMatchInlineSnapshot(`
      {
        ".claude-plugin/plugin.json": "{
        "name": "tiny-flow",
        "description": "Compiled minflow workflow \\"tiny-flow\\": 2 steps, entry \\"draft\\".",
        "version": "0.0.0",
        "author": {
          "name": "Ariel Arevalo <ariel@enki.cr>"
        },
        "metadata": {
          "generator": "minflow",
          "workflow": "tiny-flow",
          "graphHash": "7f2f316644e9db4e",
          "irVersion": "1",
          "entry": "draft",
          "steps": "2"
        }
      }
      ",
        "agents/runner.md": "---
      name: runner
      description: "Runs the \\"tiny-flow\\" workflow one step at a time. Started by /tiny-flow:run-tiny-flow; not for direct use."
      tools: Agent
      ---

      You are a dispatcher, not a worker.

      Spawn exactly the agent the most recent instruction names, using the Agent tool, and
      pass it exactly the text you were given, verbatim: no paraphrase, no additions, no
      improvements. Do not do the step's work yourself. Do not read, write or run anything.
      Do not spawn anything else.

      When that agent returns, stop and report its result unchanged.
      ",
        "agents/step-check.md": "---
      name: step-check
      description: "Step \\"check\\" of the \\"tiny-flow\\" workflow. Runs the \\"check-draft\\" skill."
      skills: [check-draft]
      ---

      # Step \`check\`

      You are one step of the compiled workflow **tiny-flow**. The skill \`check-draft\` is
      already loaded into your context, so follow it. Do this step's work and nothing else:
      do not decide what runs next, and you never spawn another agent.

      ## Checked after you finish

      The workflow evaluates these to decide where the run goes next:

      - \`npm test\` will be run, and the route depends on its exit code.
      ",
        "agents/step-draft.md": "---
      name: step-draft
      description: "Step \\"draft\\" of the \\"tiny-flow\\" workflow. Runs the \\"write-draft\\" skill."
      skills: [write-draft]
      ---

      # Step \`draft\`

      You are one step of the compiled workflow **tiny-flow**. The skill \`write-draft\` is
      already loaded into your context, so follow it. Do this step's work and nothing else:
      do not decide what runs next, and you never spawn another agent.

      ## Output contract

      Your payload is JSON and must conform to this schema exactly:

      \`\`\`json
      {
        "additionalProperties": false,
        "properties": {
          "done": {
            "type": "boolean"
          }
        },
        "required": [
          "done"
        ],
        "type": "object"
      }
      \`\`\`

      ## Delivery

      The workflow reads your output from these places. Producing them is not optional:

      - End your final message with your JSON payload as a single fenced \`json\` block, with nothing after it. It is read from the message itself, so anything following it is noise the parser has to survive.
      ",
        "commands/run-tiny-flow.md": "---
      description: "Start the \\"tiny-flow\\" workflow."
      ---

      Start the **tiny-flow** workflow, which begins at \`draft\`.

      Spawn the subagent \`tiny-flow:runner\` with the Agent tool, and give
      it exactly this instruction, verbatim:

      > Stand by. You will be told which step to spawn. Spawn nothing until then.

      Do not do any of the workflow's own work yourself, and spawn nothing else. Report
      back whatever the runner returns.
      ",
        "hooks/hooks.json": "{
        "hooks": {
          "UserPromptExpansion": [
            {
              "matcher": "^tiny-flow:run-tiny-flow$",
              "hooks": [
                {
                  "type": "command",
                  "command": "node",
                  "args": [
                    "\${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.cjs"
                  ]
                }
              ]
            }
          ],
          "SubagentStop": [
            {
              "matcher": "^tiny-flow:runner$",
              "hooks": [
                {
                  "type": "command",
                  "command": "node",
                  "args": [
                    "\${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.cjs"
                  ]
                }
              ]
            }
          ]
        }
      }
      ",
        "workflow.compiled.json": "{
        "edges": [
          {
            "event": "pass",
            "from": "draft",
            "goto": "check",
            "guard": {
              "kind": "field",
              "op": "truthy",
              "path": "done"
            },
            "id": "draft:1"
          },
          {
            "event": "pass",
            "from": "check",
            "goto": "__end__",
            "guard": {
              "command": "npm test",
              "kind": "exitZero"
            },
            "id": "check:1"
          }
        ],
        "entry": "draft",
        "hash": "7f2f316644e9db4e",
        "irVersion": 1,
        "name": "tiny-flow",
        "nodes": [
          {
            "id": "draft",
            "schema": {
              "additionalProperties": false,
              "properties": {
                "done": {
                  "type": "boolean"
                }
              },
              "required": [
                "done"
              ],
              "type": "object"
            },
            "skill": "write-draft"
          },
          {
            "id": "check",
            "skill": "check-draft"
          }
        ]
      }
      ",
      }
    `);
  });

  it("bakes the graph's identity into the dispatcher it also emits", () => {
    const ir = tinyIr();
    const source = fileOf(emit(ir), DISPATCHER_PATH);
    expect(source).toContain(`"name": "tiny-flow"`);
    expect(source).toContain(`"graphHash": "${ir.hash}"`);
    // Namespaced: this is compared against the payload's command_name.
    expect(source).toContain(`"runCommand": "tiny-flow:run-tiny-flow"`);
    expect(source).toContain(`"agents": {\n    "draft": "step-draft",\n    "check": "step-check"`);
  });
});
