#!/usr/bin/env node
/**
 * The command line: generate a test plan, and run one.
 *
 * Two verbs, deliberately separate. `plan` introspects a graph and **writes**
 * what it intends to run, as a file you can read. `test` runs a plan. Nothing
 * implicit decides what gets tested, which is the whole point of the split.
 *
 * **`test` never runs a model and never touches the network.** It replays
 * generated cases against a real emitted dispatcher with synthetic step outputs.
 * A live run against a real model is a different thing entirely and is not this.
 *
 * The graph is the input, and a compiled plugin already carries it as
 * `workflow.compiled.json`, so nothing here has to load a user's TypeScript.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Graph } from "./ir.js";
import { generatePlan, type TestPlan } from "./testplan.js";
import { runPlan } from "./testrun.js";

/** Where the plan and the scratch build live, on the precedent of every build cache. */
const OUT_DIR = ".minflow";
const PLAN_FILE = "plan.json";

/** Places a compiled graph is likely to be, in the order they are tried. */
const GRAPH_CANDIDATES = [
  "plugin/workflow.compiled.json",
  "workflow.compiled.json",
  "dist/workflow.compiled.json",
];

interface Args {
  command: string;
  graph?: string;
  out: string;
  seed: number;
}

function parse(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "help", out: OUT_DIR, seed: 1 };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--out") {
      args.out = argv[++index] ?? OUT_DIR;
    } else if (token === "--seed") {
      args.seed = Number(argv[++index] ?? 1);
    } else if (token === "--live") {
      args.command = "live";
    } else if (!token.startsWith("-")) {
      args.graph = token;
    }
  }
  return args;
}

/** The graph, from an explicit path or from wherever a compiled plugin left one. */
function loadGraph(explicit: string | undefined): { graph: Graph; from: string } {
  const tried: string[] = [];
  const candidates =
    explicit === undefined
      ? GRAPH_CANDIDATES
      : [explicit, join(explicit, "workflow.compiled.json")];

  for (const candidate of candidates) {
    const path = resolve(candidate);
    tried.push(path);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
    if (typeof graph.hash !== "string" || !Array.isArray(graph.nodes)) continue;
    return { graph, from: path };
  }

  throw new Error(
    `minflow: no compiled graph found. Looked in:\n  ${tried.join("\n  ")}\n\n` +
      "Build your plugin first, or name the graph: minflow test path/to/workflow.compiled.json",
  );
}

function writePlan(plan: TestPlan, out: string): string {
  mkdirSync(resolve(out), { recursive: true });
  const path = join(resolve(out), PLAN_FILE);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return path;
}

function reportCoverage(plan: TestPlan): void {
  const { total, covered, uncovered } = plan.coverage;
  console.log(`${plan.cases.length} cases, covering ${covered} of ${total} reachable outcomes`);
  if (uncovered.length === 0) return;
  console.log("");
  console.log(`${uncovered.length} not covered:`);
  for (const entry of uncovered) {
    console.log(`  ${entry.outcome}`);
    console.log(`    ${entry.reason}`);
  }
}

function main(argv: string[]): number {
  const args = parse(argv);

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(
      [
        "minflow plan [graph]     introspect a graph and write the test plan",
        "minflow test [graph]     run the plan. No model, no network, deterministic",
        "",
        "  --out <dir>            where the plan and the scratch build go. Default .minflow",
        "  --seed <n>             seeds string generation for pattern guards. Default 1",
        "",
        "[graph] is a workflow.compiled.json, or a plugin directory holding one.",
        "Omitted, it is looked for in plugin/, ., and dist/.",
      ].join("\n"),
    );
    return 0;
  }

  if (args.command === "live") {
    console.error(
      [
        "minflow: a live run is not built yet.",
        "",
        "It is a different thing from `minflow test`: a real model, a real run, real cost,",
        "in a temporary directory so it cannot leave counterfeit output where real output",
        "lives. Compiled workflows already have the half it needs, which is auto mode:",
        "start one with --auto and it answers its own questions and stops at any gate.",
      ].join("\n"),
    );
    return 2;
  }

  const { graph, from } = loadGraph(args.graph);

  if (args.command === "plan") {
    const plan = generatePlan(graph, { seed: args.seed });
    const path = writePlan(plan, args.out);
    console.log(`read ${from}`);
    console.log(`wrote ${path}`);
    console.log("");
    reportCoverage(plan);
    return 0;
  }

  if (args.command !== "test") {
    console.error(`minflow: unknown command "${args.command}". Try: minflow help`);
    return 2;
  }

  const plan = generatePlan(graph, { seed: args.seed });
  const path = writePlan(plan, args.out);
  console.log(`read ${from}`);
  console.log(`wrote ${path}`);
  console.log("");

  const result = runPlan(graph, plan, { scratch: join(resolve(args.out), "scratch") });
  for (const testCase of result.cases) {
    console.log(
      `  ${testCase.passed ? "ok  " : "FAIL"} ${testCase.id}  ${testCase.expected.join(" > ")}`,
    );
    for (const problem of testCase.problems) console.log(`       ${problem}`);
  }
  console.log("");
  reportCoverage(plan);
  console.log("");

  const failed = result.cases.filter((testCase) => !testCase.passed).length;
  console.log(
    failed === 0 ? `all ${result.cases.length} cases passed` : `${failed} case(s) failed`,
  );
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
