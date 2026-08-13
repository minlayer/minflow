/**
 * The compiled graph as a Mermaid flowchart.
 *
 * The builder buys validation at the offending line, and it costs the transition
 * table's best property: the graph is no longer legible in one glance (SPEC
 * §1.3). This diagram and `wf.print()` are therefore how a workflow is read
 * rather than a convenience, which fixes what the picture has to carry. Every
 * node with the skill it runs, every edge with what decides it, where a run
 * stops and waits for a human, and both failure paths, a retry and a divert,
 * drawn as their own arrows rather than folded into the edge they belong to.
 *
 * Pure and deterministic: the same IR renders the same string, byte for byte.
 * A diagram that reordered between builds would turn every rebuild into a diff
 * someone has to read, which costs more than the diagram is worth.
 *
 * @packageDocumentation
 */

import type {
  End,
  FieldOp,
  Guard,
  IrEdge,
  JsonValue,
  NodeId,
  PayloadSource,
  WorkflowIr,
} from "./ir.js";
import { END, isEnd } from "./ir.js";

/** Options for {@link toMermaid}. */
export interface MermaidOptions {
  /**
   * Flowchart direction, passed through to Mermaid. Top down by default; a long
   * chain with few branches usually reads better left to right.
   */
  direction?: "TB" | "TD" | "BT" | "LR" | "RL";
  /**
   * Nesting depth at which a composite guard stops expanding and renders as a
   * count of what it holds.
   *
   * An edge label is one line written along an arrow, so a deeply nested
   * `all(any(not(...)))` spelled out in full pushes the graph off the page and
   * the reader loses the shape, which is the one thing a picture is better at
   * than the source. Past this depth the count is kept and the detail is
   * dropped, because the source still has the detail.
   */
  guardDepth?: number;
}

/**
 * Depth at which a composite guard collapses to a count.
 *
 * Two levels, so `all(a, any(b, c))` still reads in full: that is the shape a
 * hand-written guard usually has, and collapsing it would hide the common case
 * to spare the rare one.
 */
const DEFAULT_GUARD_DEPTH = 2;

/**
 * Base name of the marker node the entry arrow starts from.
 *
 * A marker rather than a colour on the entry node, because a fill only shows in
 * a rendered diagram, and the source of this file is read too.
 */
const START = "__start__";

/**
 * Identifiers a flowchart parses as syntax rather than as a node name.
 *
 * `end` is the notorious one, since it closes a subgraph and takes the rest of
 * the diagram with it. `o` and `x` are here because Mermaid reads them as the
 * circle and cross arrowheads when they follow a link. Matched case
 * insensitively and prefixed rather than refused, since a node genuinely named
 * "end" is a legal graph and still has to render.
 */
const RESERVED = new Set([
  "call",
  "class",
  "classdef",
  "click",
  "default",
  "direction",
  "end",
  "flowchart",
  "graph",
  "href",
  "interpolate",
  "linkstyle",
  "o",
  "style",
  "subgraph",
  "x",
]);

/**
 * Renders `ir` as a Mermaid flowchart.
 *
 * Reads the graph and nothing else: no clock, no filesystem, no mutation of the
 * argument.
 */
export function toMermaid(ir: WorkflowIr, options: MermaidOptions = {}): string {
  const direction = options.direction ?? "TD";
  const depth = options.guardDepth ?? DEFAULT_GUARD_DEPTH;

  // Per call, never module level. A shared allocator would hand the second
  // rendering of a graph different identifiers from the first, which is exactly
  // the reordering this function promises not to do.
  const taken = new Set<string>();
  const identifiers = new Map<string, string>();
  const declarations: string[] = [];

  function claim(raw: string): string {
    const root = identifier(raw);
    let candidate = root;
    let ordinal = 2;
    while (taken.has(candidate)) {
      candidate = `${root}_${ordinal}`;
      ordinal += 1;
    }
    taken.add(candidate);
    return candidate;
  }

  function identifierFor(node: NodeId | End): string {
    const known = identifiers.get(node);
    if (known !== undefined) return known;
    const assigned = claim(isEnd(node) ? END : node);
    identifiers.set(node, assigned);
    declarations.push(isEnd(node) ? terminalShape(assigned) : stepShape(assigned, node));
    return assigned;
  }

  // The declared nodes claim their identifiers first, in declaration order, so
  // that a graph gaining an END or a marker never renames a step.
  for (const node of ir.nodes) {
    const assigned = claim(node.id);
    identifiers.set(node.id, assigned);
    declarations.push(stepShape(assigned, `${node.id} (${node.skill})`));
  }
  const start = claim(START);

  // `declarations` still grows below: a target that no node declares is declared
  // on first use, since Mermaid would otherwise invent a node from the raw id,
  // and that id is exactly what needs escaping.
  const links = [`  ${start} --> ${identifierFor(ir.entry)}`];
  for (const edge of ir.edges) {
    const from = identifierFor(edge.from);
    // A gated edge does not continue into `goto`, it ends the run segment and
    // waits, so it is drawn as a different kind of arrow and not only labelled.
    const arrow = edge.gate === undefined ? "-->" : "-.->";
    links.push(link(from, arrow, passLabel(edge, depth), identifierFor(edge.goto)));

    const otherwise = edge.otherwise;
    if (otherwise === undefined) continue;
    // The failure path gets its own arrow. Folded into the pass edge it would
    // read as one transition, and a retry ceiling or a silent divert is where a
    // graph goes wrong, so it is the last thing that may be left implied.
    links.push(
      otherwise.kind === "retry"
        ? link(from, "-->", retryLabel(otherwise.reason, edge.limit), from)
        : link(from, "-->", "otherwise", identifierFor(otherwise.node)),
    );
  }

  return [`flowchart ${direction}`, startShape(start), ...declarations, "", ...links, ""].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Shapes and links
// ---------------------------------------------------------------------------

function startShape(name: string): string {
  return `  ${name}(("start"))`;
}

function stepShape(name: string, text: string): string {
  return `  ${name}["${escapeLabel(text)}"]`;
}

/** END is a stadium rather than a box, so a terminal is not read as a step. */
function terminalShape(name: string): string {
  return `  ${name}(["END"])`;
}

function link(from: string, arrow: string, text: string, to: string): string {
  if (text === "") return `  ${from} ${arrow} ${to}`;
  return `  ${from} ${arrow}|"${escapeLabel(text)}"| ${to}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function passLabel(edge: IrEdge, depth: number): string {
  const parts: string[] = [];
  // An unlabelled arrow already says the transition is unconditional, so
  // writing "always" along it adds a word and no information.
  if (edge.guard.kind !== "always") parts.push(describeGuard(edge.guard, 0, depth));
  // The gate names the resume command as the IR carries it. What a human
  // actually types is a backend's business, since each one folds the name into
  // its own command syntax.
  if (edge.gate !== undefined) parts.push(`awaits human: ${edge.gate}`);
  return parts.join(", ");
}

function retryLabel(reason: string, limit: number | undefined): string {
  const ceiling = limit === undefined ? "retry" : `retry (max ${limit})`;
  return `${ceiling}: ${reason}`;
}

/**
 * A guard as the thing it checks.
 *
 * A mechanical guard reads as its predicate, so an arrow says what has to be
 * true rather than which library function was called. A judge reads as the
 * verdict it fires on, since the arms of a branch share one question and differ
 * only in verdict, and it keeps the `judge` prefix because a model deciding
 * control flow is the one thing on this diagram worth spotting from across the
 * room (SPEC §1.5).
 */
function describeGuard(guard: Guard, depth: number, maxDepth: number): string {
  switch (guard.kind) {
    case "always":
      return "always";
    case "exitZero":
      return `${guard.command} exits 0`;
    case "fileExists":
      return `${guard.path} exists`;
    case "field":
      return `${guard.path} ${describeFieldOp(guard.op, guard.value)}${describeLane(guard.from)}`;
    case "judge":
      return `judge: ${guard.is}`;
    case "not":
      if (depth >= maxDepth) return "not (...)";
      return `not (${describeGuard(guard.guard, depth + 1, maxDepth)})`;
    case "all":
      return describeComposite(guard.guards, "all", " and ", depth, maxDepth);
    case "any":
      return describeComposite(guard.guards, "any", " or ", depth, maxDepth);
  }
}

/**
 * An `all` or an `any`, spelled out or counted.
 *
 * Empty is not a degenerate case to ignore: `all([])` holds and `any([])` never
 * does, so both render as what they mean rather than as an empty label that
 * would read like an unconditional edge.
 */
function describeComposite(
  guards: Guard[],
  kind: "all" | "any",
  joiner: string,
  depth: number,
  maxDepth: number,
): string {
  if (guards.length === 0) return kind === "all" ? "always" : "never";
  if (depth >= maxDepth) return `${kind} of ${guards.length} checks`;
  return guards.map((guard) => parenthesize(guard, depth + 1, maxDepth)).join(joiner);
}

/**
 * A nested `all` or `any` is bracketed, since `a and b or c` on an arrow would
 * be read by whichever precedence the reader happens to assume. `not (x)` is
 * already bracketed by its own form.
 */
function parenthesize(guard: Guard, depth: number, maxDepth: number): string {
  const text = describeGuard(guard, depth, maxDepth);
  return guard.kind === "all" || guard.kind === "any" ? `(${text})` : text;
}

function describeFieldOp(op: FieldOp, value: JsonValue | undefined): string {
  const rendered = JSON.stringify(value ?? null);
  switch (op) {
    case "truthy":
      return "is truthy";
    case "equals":
      return `== ${rendered}`;
    case "notEquals":
      return `!= ${rendered}`;
    case "matches":
      return `matches ${rendered}`;
    case "gt":
      return `> ${rendered}`;
    case "lt":
      return `< ${rendered}`;
  }
}

/**
 * The file lane, named on the label. A dot path means nothing without the
 * payload it reads, and inline is the default, so only a file is worth the
 * width.
 */
function describeLane(from: PayloadSource | undefined): string {
  if (from === undefined || from.lane === "inline") return "";
  return ` (from ${from.path})`;
}

/**
 * Text as a Mermaid label: one line, and nothing left in it that the parser or
 * the renderer would take as syntax.
 *
 * A `"` ends a quoted label, so it breaks the parse. A `|` closes an edge
 * label. `<`, `>` and `&` are markup, since the renderer draws a label as HTML
 * by default. Each becomes an entity rather than being dropped, so the label
 * still reads as the author wrote it.
 *
 * **Named entities only, never numeric.** Mermaid runs its own substitution for
 * `#nnn;` before the label is ever treated as HTML, so it eats the tail of a
 * numeric entity and leaves the ampersand behind: `&#124;` renders as `&|`. A
 * literal `#` is escaped for the same reason, and as `&num;` rather than
 * `#35;`, so that nothing this function emits contains a `#` for that pass to
 * find.
 */
function escapeLabel(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/#/g, "&num;")
    .replace(/\|/g, "&verbar;");
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * A node id folded into something Mermaid reads as one identifier.
 *
 * A node id is any string, and the characters this strips are the ones a
 * flowchart would parse as structure. The real id survives on the label, so
 * nothing here loses information; two ids that fold together are separated by
 * the caller, which appends an ordinal.
 */
function identifier(raw: string): string {
  const folded = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (folded === "") return "n";
  if (RESERVED.has(folded.toLowerCase()) || /^[0-9]/.test(folded)) return `n_${folded}`;
  return folded;
}
