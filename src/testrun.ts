/**
 * Running a generated plan against a real emitted dispatcher.
 *
 * Generation is portable, because it reads only the IR. Execution is not: driving
 * a dispatcher is a backend's business, and Claude Code is the only backend that
 * exists. This is that half.
 *
 * **It drives the artifact, not a simulation of it.** Each case replays as hook
 * payloads on a spawned dispatcher, with the plan's synthetic step outputs
 * standing in for what a model would have said, and the run's own trace is then
 * checked against the walk the plan predicted. That is the whole reason to pay
 * for execution when the graph is already statically linted: it exercises the
 * emitted plugin rather than the graph. A template that fails to resolve on one
 * branch, a delivery obligation the wrong lane satisfies, an ask whose questions
 * a step never produced: every one is well formed in the graph and broken in the
 * plugin.
 *
 * No model and no network are involved.
 *
 * @packageDocumentation
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DISPATCHER_PATH, emit, pluginNameFor } from "./emit/claude-code.js";
import type { Graph, JsonValue } from "./ir.js";
import { isCommandNode } from "./ir.js";
import type { Skill } from "./skill.js";
import type { Observations, TestCase, TestSuite } from "./testsuite.js";

/** What one case did. */
export interface CaseResult {
  id: string;
  passed: boolean;
  /** The walk the plan predicted. */
  expected: string[];
  /** The walk the dispatcher actually took, read from its trace. */
  actual: string[];
  /** Why it failed, when it did. */
  problems: string[];
}

/** What a whole run of a plan did. */
export interface RunResult {
  passed: boolean;
  cases: CaseResult[];
  coverage: TestSuite["coverage"];
}

/** Options for {@link runSuite}. */
export interface RunOptions {
  /** Skills to ship into the plugin under test, as `emit` takes them. */
  skills?: Skill[];
  /** Where to build. A temporary directory is made and removed when absent. */
  scratch?: string;
}

/**
 * Run every case in a plan against a freshly emitted plugin.
 *
 * The plan is refused outright if it was generated against a different graph. A
 * stale plan silently testing something else is worse than no plan, and the
 * graph hash is exactly the thing that can tell.
 */
export function runSuite(graph: Graph, plan: TestSuite, options: RunOptions = {}): RunResult {
  if (plan.graphHash !== graph.hash) {
    throw new Error(
      `minflow: this plan was generated against graph ${plan.graphHash}, but the graph now ` +
        `hashes to ${graph.hash}. Regenerate the plan rather than running a stale one against ` +
        "a workflow it does not describe.",
    );
  }

  const owned = options.scratch === undefined;
  const scratch = options.scratch ?? mkdtempSync(join(tmpdir(), "minflow-test-"));
  const results: CaseResult[] = [];

  try {
    const pluginDir = join(scratch, "plugin");
    rmSync(pluginDir, { recursive: true, force: true });
    const files =
      options.skills === undefined ? emit(graph) : emit(graph, { skills: options.skills });
    writeFilesSync(files, pluginDir);

    for (const testCase of plan.cases) {
      results.push(runCase(graph, pluginDir, scratch, testCase));
    }
  } finally {
    if (owned) rmSync(scratch, { recursive: true, force: true });
  }

  return {
    passed: results.every((result) => result.passed),
    cases: results,
    coverage: plan.coverage,
  };
}

/** `writeFiles` is async and this path is synchronous throughout; inline the loop. */
function writeFilesSync(files: Record<string, string>, destDir: string): void {
  const root = resolve(destDir);
  for (const relative of Object.keys(files).sort()) {
    const target = join(root, ...relative.split("/"));
    if (!target.startsWith(root)) {
      throw new Error(`minflow: refusing to write ${relative} outside ${root}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files[relative] ?? "", "utf8");
  }
}

/**
 * Replay one case.
 *
 * The dispatcher is a separate process reading a hook payload on stdin, exactly
 * as the platform invokes it, so nothing here can accidentally test an in-process
 * shortcut that the real thing does not take.
 */
function runCase(graph: Graph, pluginDir: string, scratch: string, testCase: TestCase): CaseResult {
  const name = pluginNameFor(graph);
  const dataDir = mkdtempSync(join(scratch, "data-"));
  const projectDir = mkdtempSync(join(scratch, "project-"));
  const problems: string[] = [];
  const reported: string[] = [];

  // Rewritten before each stop, so the dispatcher answers that step's guards
  // with that step's values. Without it a case could set a payload and nothing
  // else, and no generated test could ever make a build command fail.
  const stubs = join(dataDir, "observations.json");

  const fire = (event: Record<string, JsonValue>): { decision: string | null; stderr: string } => {
    const finished = spawnSync(process.execPath, [join(pluginDir, DISPATCHER_PATH)], {
      input: JSON.stringify(event),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PROJECT_DIR: projectDir,
        MINFLOW_TEST_OBSERVATIONS: stubs,
      },
    });
    if (finished.status !== 0) {
      problems.push(`the dispatcher exited ${String(finished.status)}: ${finished.stderr.trim()}`);
    }
    // The dispatcher explains a stopped run on stderr, and that explanation is
    // the most useful thing a failing case can carry.
    const said = finished.stderr.trim();
    if (said !== "") reported.push(said);
    const out = finished.stdout.trim();
    return { decision: out === "" ? null : out, stderr: finished.stderr };
  };

  // A command node runs inside the dispatcher, between two of the runner's
  // stops, so it never gets a stop of its own. Its observations have to be in
  // place for the fire that drains it, which is the one belonging to the step
  // before it.
  const commandNodes = new Set(
    graph.nodes.filter((node) => isCommandNode(node)).map((node) => node.id),
  );

  // Keyed by node, because one fire can resolve observations for a step and for
  // every command node drained after it, and they share the inline payload key.
  // A flat value per node is not enough either: a retry to a command node visits
  // it twice inside one fire, so repeats become a list consumed in order.
  const answersFor = (steps: TestCase["steps"]): Record<string, Observations | Observations[]> => {
    const answering: Record<string, Observations | Observations[]> = {};
    for (const step of steps) {
      const already = answering[step.node];
      if (already === undefined) {
        answering[step.node] = step.observations;
      } else if (Array.isArray(already)) {
        already.push(step.observations);
      } else {
        answering[step.node] = [already, step.observations];
      }
    }
    return answering;
  };

  // A command node at the entry drains during the start itself, before any step
  // has stopped, so there is no earlier fire to hang its answers on. They have to
  // be on disk before the runner first stands by, or the node resolves against
  // the world and the case silently tests something else.
  const leading: TestCase["steps"] = [];
  for (const step of testCase.steps) {
    if (!commandNodes.has(step.node)) break;
    leading.push(step);
  }
  if (leading.length > 0) {
    writeFileSync(stubs, JSON.stringify(answersFor(leading)), "utf8");
  }

  // The two-beat start: the command seeds state and says nothing, then the
  // runner stands by and is redirected into the entry step.
  fire({
    hook_event_name: "UserPromptExpansion",
    session_id: "plan",
    command_name: `${name}:run-${name}`,
    command_args: "",
    command_source: "plugin",
    expansion_type: "slash_command",
  });
  fire({
    hook_event_name: "SubagentStop",
    session_id: "plan",
    agent_type: "runner",
    last_assistant_message: "Standing by.",
  });

  const stop = (message: string): { decision: string | null; stderr: string } =>
    fire({
      hook_event_name: "SubagentStop",
      session_id: "plan",
      agent_type: "runner",
      last_assistant_message: message,
    });

  for (let index = 0; index < testCase.steps.length; index += 1) {
    const step = testCase.steps[index];
    if (step === undefined) continue;
    if (commandNodes.has(step.node)) continue;

    // This step, plus every command node drained after it on the same fire.
    const batch: TestCase["steps"] = [step];
    for (let ahead = index + 1; ahead < testCase.steps.length; ahead += 1) {
      const next = testCase.steps[ahead];
      if (next === undefined || !commandNodes.has(next.node)) break;
      batch.push(next);
    }

    writeFileSync(stubs, JSON.stringify(answersFor(batch)), "utf8");
    const fired = stop(inlineReport(step.observations));

    // A transition that asks parks the run, and the harness plays the part the
    // session plays: it relays the marker, writes the answers, and spawns the
    // runner again. That drives the real mechanism rather than switching the
    // workflow into a mode real users are not in.
    if (step.answers !== undefined) {
      // Read out of the decision's reason, not out of the raw JSON: the reason
      // is an escaped string, so a regular expression over the wire format
      // captures the escapes as well as the path.
      let reason = "";
      try {
        reason = (JSON.parse(fired.decision ?? "{}") as { reason?: string }).reason ?? "";
      } catch {
        reason = "";
      }
      const marker = /MINFLOW-ASK (\S+)/.exec(reason);
      if (marker === null) {
        problems.push(`step "${step.node}" was expected to ask, and did not`);
        continue;
      }
      const questionsPath = marker[1] ?? "";
      // Beat two: the runner says the marker and is allowed to stop, which is
      // what would put it in front of the session.
      stop(`MINFLOW-ASK ${questionsPath}`);
      const asked = JSON.parse(readFileSync(questionsPath, "utf8")) as { answersPath: string };
      writeFileSync(asked.answersPath, JSON.stringify(step.answers), "utf8");
      // Beat three: the session spawns the runner again to stand by.
      stop("Standing by.");
    }
  }

  const walked = traceWalk(dataDir);
  const expected = testCase.walk;
  if (!sameWalk(walked, expected)) {
    problems.push(
      `the run walked ${walked.join(" > ") || "(nowhere)"} but the plan expected ` +
        `${expected.join(" > ")}`,
    );
    for (const said of reported) problems.push(`the dispatcher said: ${said}`);
  }

  return {
    id: testCase.id,
    passed: problems.length === 0,
    expected,
    actual: walked,
    problems,
  };
}

/**
 * A step's payload as a runner would report it.
 *
 * Only the inline payload can travel this way. A guard reading a file lane is
 * answered by the file the case wrote, and one reading an exit code by the
 * command actually running, which is why those two are not yet driven here.
 */
function inlineReport(observations: Record<string, { ok: boolean; value?: JsonValue }>): string {
  for (const [key, result] of Object.entries(observations)) {
    if (!key.startsWith("payload:") || !key.includes('"lane":"inline"')) continue;
    if (result.ok !== true) continue;
    return `Done.\n\n\`\`\`json\n${JSON.stringify(result.value, null, 2)}\n\`\`\``;
  }
  return "Done.";
}

/** The nodes a run visited, in order, read out of the trace it wrote. */
function traceWalk(dataDir: string): string[] {
  const dir = join(dataDir, "trace");
  if (!existsSync(dir)) return [];
  const walk: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let entry: { decision?: string; node?: string };
      try {
        entry = JSON.parse(line) as { decision?: string; node?: string };
      } catch {
        continue;
      }
      // Decisions, not every hook fire: a fire with no decision is the platform
      // asking and the dispatcher declining, which is not a step of the walk.
      if (entry.decision === undefined || entry.node === undefined) continue;
      if (!DECIDING.has(entry.decision)) continue;
      walk.push(entry.node);
    }
  }
  return walk;
}

/**
 * Trace decisions that mean a node was left, as opposed to bookkeeping.
 *
 * `command` is deliberately absent. A command node writes two lines, one saying
 * it ran and one saying where it went, and only the second is a transition.
 * Counting both would show every mechanical check twice in the walk.
 */
const DECIDING = new Set(["advance", "retry", "gate", "ask", "end", "stopped"]);

function sameWalk(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((node, index) => node === expected[index]);
}
