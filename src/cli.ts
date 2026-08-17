#!/usr/bin/env node
/**
 * The command line.
 *
 * One verb: `minflow test` derives a suite of cases from the graph, writes it
 * out, and runs it. The generated suite is an **artifact you can read**, the way
 * a collected pytest suite is: every case, the decision it targets, and the
 * exact inputs that force it, on disk under `.minflow/`. Nothing implicit
 * decides what gets tested, and `--collect-only` stops before running for when
 * you want to look first.
 *
 * **It never runs a model and never touches the network.** Cases replay against
 * a real emitted dispatcher with synthetic step outputs. A live run against a
 * real model is a different thing entirely and is not this.
 *
 * The graph is the input, and a compiled plugin already carries it as
 * `workflow.compiled.json`, so nothing here has to load a user's TypeScript.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { Graph } from "./ir.js";
import { runSuite } from "./testrun.js";
import { generateSuite, type TestSuite } from "./testsuite.js";

/** Where the suite and the scratch build live, on the precedent of every build cache. */
const OUT_DIR = ".minflow";
const SUITE_FILE = "suite.json";

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
  collectOnly: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "help", out: OUT_DIR, seed: 1, collectOnly: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--out") {
      args.out = argv[++index] ?? OUT_DIR;
    } else if (token === "--seed") {
      args.seed = Number(argv[++index] ?? 1);
    } else if (token === "--collect-only") {
      args.collectOnly = true;
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

function writeSuite(suite: TestSuite, out: string): string {
  mkdirSync(resolve(out), { recursive: true });
  const path = join(resolve(out), SUITE_FILE);
  writeFileSync(path, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  return path;
}

/** A path as the reader would type it, when it is under the working directory. */
function display(path: string): string {
  const here = relative(process.cwd(), path);
  return here === "" || here.startsWith("..") ? path : here;
}

function reportCoverage(suite: TestSuite): void {
  const { total, covered, uncovered } = suite.coverage;
  console.log(`${suite.cases.length} cases, covering ${covered} of ${total} reachable outcomes`);
  if (uncovered.length === 0) return;
  // Not a shortfall, and saying "not covered" next to "8 of 8" reads as a
  // contradiction. These are outcomes nothing can reach, which is a fact about
  // the graph rather than a gap in the suite, so it comes with the reason.
  console.log("");
  const count = uncovered.length;
  console.log(`${count} further ${count === 1 ? "outcome is" : "outcomes are"} unreachable:`);
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
        "minflow test [graph]     derive a suite from the graph, write it, and run it",
        "                         No model, no network, deterministic",
        "",
        "  --collect-only         write the suite and stop, without running it",
        "  --out <dir>            where the suite and scratch build go. Default .minflow",
        "  --seed <n>             seeds string generation for pattern guards. Default 1",
        "",
        "[graph] is a workflow.compiled.json, or a plugin directory holding one.",
        "Omitted, it is looked for in plugin/, ., and dist/.",
        "",
        "The suite it writes is meant to be read. It names every case, the decision",
        "each one targets, and the exact inputs that force it.",
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
        "lives. Compiled workflows already have the half it needs, which is auto mode,",
        "and `minflow test --live` will turn it on itself rather than asking you to.",
      ].join("\n"),
    );
    return 2;
  }

  if (args.command !== "test") {
    console.error(`minflow: unknown command "${args.command}". Try: minflow help`);
    return 2;
  }

  const { graph, from } = loadGraph(args.graph);
  const suite = generateSuite(graph, { seed: args.seed });
  const path = writeSuite(suite, args.out);
  console.log(`read ${display(from)}`);
  console.log(`wrote ${display(path)}`);
  console.log("");

  if (args.collectOnly) {
    for (const testCase of suite.cases) {
      console.log(`  ${testCase.id}  ${testCase.walk.join(" > ")}`);
    }
    console.log("");
    reportCoverage(suite);
    return 0;
  }

  const result = runSuite(graph, suite, { scratch: join(resolve(args.out), "scratch") });
  for (const testCase of result.cases) {
    console.log(
      `  ${testCase.passed ? "ok  " : "FAIL"} ${testCase.id}  ${testCase.expected.join(" > ")}`,
    );
    for (const problem of testCase.problems) console.log(`       ${problem}`);
  }
  console.log("");
  reportCoverage(suite);
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
