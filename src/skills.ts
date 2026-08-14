/**
 * Build-time validation of the skills a graph references.
 *
 * This exists because the failure it prevents is silent. A generated step
 * wrapper names its skill in the `skills:` frontmatter field, which preloads the
 * skill body into the step at startup (SPEC §3.6). When that reference does not
 * resolve, or when policy has disabled the skill, Claude Code skips it with a
 * debug-log warning and runs the step anyway. The step then executes with no
 * instructions and reports success, and the run finishes green having done the
 * wrong thing. Validation is therefore required rather than optional: a workflow
 * that fails is recoverable, and one that quietly runs the wrong thing is not.
 *
 * The split here is the one the rest of the package uses. {@link checkSkills}
 * and {@link preloadCost} are pure, taking a graph plus a list of skills someone
 * else discovered, so the interesting half is testable with no filesystem.
 * {@link discoverSkills} is the whole of the I/O and is a loop over directories.
 *
 * Nothing here writes to a skill. The user's files are read, never modified,
 * which is the premise the whole design rests on (D14).
 *
 * @packageDocumentation
 */

import type { IrNode, NodeId } from "./ir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The part of a graph these checks read.
 *
 * Only the nodes, because only a node names a skill. Stated as its own shape
 * rather than as {@link WorkflowIr} so that a draft graph, or one a second
 * front-end produced, can be checked before it has a hash.
 */
export interface SkillReferencingGraph {
  nodes: IrNode[];
}

/**
 * One skill on disk, reduced to what validation needs.
 *
 * `frontmatter` is deliberately raw and unvalidated: keys map to the scalar text
 * that followed them, with nothing coerced and nothing filled in. Deciding
 * whether a field is missing, malformed, or hostile is what {@link checkSkills}
 * is for, and a parser that repaired the input first would hide exactly the
 * faults being looked for.
 */
export interface DiscoveredSkill {
  /**
   * The directory holding `SKILL.md`. This is the name a reference resolves by,
   * which is why the specification requires the frontmatter `name` to match it.
   */
  directory: string;
  /** Where it was read from, so a problem carries an address a reader can open. */
  source: string;
  /** Frontmatter scalars, exactly as written. */
  frontmatter: Record<string, string>;
  /**
   * Characters in the body, meaning everything after the frontmatter block.
   *
   * Characters rather than tokens: the cost that matters is a token count, and
   * counting tokens needs a tokenizer this package does not ship. Reporting the
   * measure actually taken beats reporting a guess dressed as a count.
   */
  bodyChars: number;
}

/**
 * What one referenced skill costs at startup, every invocation of its steps.
 *
 * Preloading moves a skill's body from on-invoke cost to always-on cost (SPEC
 * L21). Agent Skills loads a body only when the model activates the skill; the
 * `skills:` field injects it into the wrapper at startup instead, so the step
 * pays the whole body every time it runs whether or not it needs all of it. This
 * is information rather than a problem, because the trade is the author's to
 * make: for a large skill, referencing it normally and letting the agent
 * activate it can be cheaper than preloading it.
 */
export interface SkillCost {
  /** The skill, named as the nodes name it. */
  skill: string;
  /** Every node that preloads it, in the order the graph declares them. */
  nodes: NodeId[];
  /** Body size, as {@link DiscoveredSkill.bodyChars} measures it. */
  bodyChars: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The file that makes a directory a skill. */
export const SKILL_FILE = "SKILL.md";

/**
 * The portable skill name: lowercase letters, digits, and interior hyphens.
 *
 * Written as groups separated by single hyphens, so a leading, trailing, or
 * doubled hyphen fails to match without needing a rule of its own.
 */
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Upper bound on a skill name, from the Agent Skills specification. */
const MAX_NAME_LENGTH = 64;

/**
 * How far a found name may sit from a referenced one and still be offered.
 *
 * A typo is the common case for an unresolved reference, and two edits covers
 * the ones people actually make: a dropped letter, a transposition, a missing
 * hyphen. Wider than that and the suggestion starts naming unrelated skills,
 * which is worse than offering none.
 */
const SUGGESTION_DISTANCE = 2;

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Every reason a graph's skills would fail to reach the steps that name them.
 *
 * Pure: it never touches a filesystem, and `available` is whatever
 * {@link discoverSkills}, a test, or another caller supplies.
 *
 * Only referenced skills are checked. A repository holds skills this workflow
 * has nothing to do with, and reporting their frontmatter here would bury the
 * one line that concerns the graph being compiled.
 *
 * A missing skill is reported once per node, because two nodes reaching for the
 * same absent skill are two separate mistakes and may be two different typos.
 * A frontmatter fault is reported once per skill, because it is one file with
 * one fix however many nodes name it.
 *
 * @returns One line per problem, empty when every referenced skill resolves.
 */
export function checkSkills(graph: SkillReferencingGraph, available: DiscoveredSkill[]): string[] {
  const byDirectory = indexByDirectory(available);
  const problems: string[] = [];
  const examined = new Set<string>();

  for (const node of graph.nodes) {
    const found = byDirectory.get(node.skill);
    if (found === undefined) {
      problems.push(missingSkillProblem(node.id, node.skill, available));
      continue;
    }
    if (examined.has(node.skill)) continue;
    examined.add(node.skill);
    problems.push(...frontmatterProblems(found));
  }

  return problems;
}

/**
 * What each referenced skill adds to every invocation of the steps that use it.
 *
 * Reported separately from {@link checkSkills} because it is not a problem: a
 * large preloaded skill is a cost an author may have chosen. Sorted with the
 * largest first, since that is the one worth acting on, and ties broken by name
 * so the report is stable across runs.
 *
 * Skills that do not resolve are absent: they have no body to measure, and
 * {@link checkSkills} already reports them as the errors they are.
 */
export function preloadCost(
  graph: SkillReferencingGraph,
  available: DiscoveredSkill[],
): SkillCost[] {
  const byDirectory = indexByDirectory(available);
  const costs = new Map<string, SkillCost>();

  for (const node of graph.nodes) {
    const found = byDirectory.get(node.skill);
    if (found === undefined) continue;
    const existing = costs.get(node.skill);
    if (existing === undefined) {
      costs.set(node.skill, { skill: node.skill, nodes: [node.id], bodyChars: found.bodyChars });
    } else {
      existing.nodes.push(node.id);
    }
  }

  return [...costs.values()].sort(
    (left, right) => right.bodyChars - left.bodyChars || compareText(left.skill, right.skill),
  );
}

/**
 * Skills by the name a reference resolves by, which is the directory name.
 *
 * The first entry wins, matching {@link discoverSkills}, where roots are a
 * search path in precedence order.
 */
function indexByDirectory(available: DiscoveredSkill[]): Map<string, DiscoveredSkill> {
  const index = new Map<string, DiscoveredSkill>();
  for (const skill of available) {
    if (!index.has(skill.directory)) index.set(skill.directory, skill);
  }
  return index;
}

/**
 * The unresolved reference, with a way out of it.
 *
 * A near match is offered when one exists, because a typo is what usually
 * produces this line. When nothing is close, the names that were found are
 * listed instead, so the reader can see what the search actually turned up
 * rather than guessing whether it looked in the right place.
 */
function missingSkillProblem(node: NodeId, skill: string, available: DiscoveredSkill[]): string {
  const names = available.map((candidate) => candidate.directory);
  const near = nearestName(skill, names);
  const hint =
    near !== undefined
      ? `Did you mean "${near}"?`
      : names.length === 0
        ? "No skills were found at all, so check the roots that were searched."
        : `Skills found: ${[...names].sort(compareText).join(", ")}.`;
  return (
    `node "${node}" names skill "${skill}", which was not found. ${hint} ` +
    "Claude Code skips a skill it cannot resolve with only a debug-log warning, so this step " +
    "would run without its instructions and still report success."
  );
}

/** Everything wrong with one referenced skill's frontmatter. */
function frontmatterProblems(skill: DiscoveredSkill): string[] {
  return [...nameProblems(skill), ...descriptionProblems(skill), ...invocationProblems(skill)];
}

/**
 * The `name` field: present, portable, and equal to the directory.
 *
 * The match is the load-bearing one. The specification requires it, and a
 * mismatch is the likeliest reason a reference resolves to nothing, since the
 * reference is by directory and the skill answers to something else.
 */
function nameProblems(skill: DiscoveredSkill): string[] {
  const name = skill.frontmatter.name;
  if (name === undefined || name === "") {
    return [
      `skill "${skill.directory}" (${skill.source}) declares no name, which the Agent Skills ` +
        `specification requires. Add "name: ${skill.directory}", matching the directory.`,
    ];
  }

  const problems: string[] = [];
  if (name !== skill.directory) {
    problems.push(
      `skill "${skill.directory}" (${skill.source}) declares name "${name}" but lives in ` +
        `directory "${skill.directory}". The Agent Skills specification requires the two to ` +
        `match, and a reference resolves by the directory, so neither name reaches this skill. ` +
        `Set "name: ${skill.directory}" or rename the directory to "${name}".`,
    );
  }
  if (!isPortableName(name)) {
    problems.push(
      `skill "${skill.directory}" (${skill.source}) declares name "${name}", which is not a ` +
        `portable skill name: 1 to ${MAX_NAME_LENGTH} characters of lowercase letters, digits ` +
        "and hyphens, with no leading, trailing, or consecutive hyphen.",
    );
  }
  return problems;
}

/** The `description` field, which the standard requires alongside `name`. */
function descriptionProblems(skill: DiscoveredSkill): string[] {
  const description = skill.frontmatter.description;
  if (description !== undefined && description !== "") return [];
  return [
    `skill "${skill.directory}" (${skill.source}) declares no description, which the Agent ` +
      "Skills specification requires. Add a description saying what the skill does and when " +
      "it applies.",
  ];
}

/**
 * The one field here that is a Claude Code extension rather than a standard
 * frontmatter key. The portable set is `name`, `description`, `license`,
 * `compatibility`, `metadata`, and the experimental `allowed-tools`; a skill
 * carrying `disable-model-invocation` is already outside it.
 *
 * It matters because it blocks the preloading a generated step wrapper depends
 * on. The wrapper does not ask the model to activate the skill, it injects the
 * body at startup, and a skill that refuses model invocation is skipped instead.
 */
function invocationProblems(skill: DiscoveredSkill): string[] {
  if (skill.frontmatter["disable-model-invocation"] !== "true") return [];
  return [
    `skill "${skill.directory}" (${skill.source}) sets disable-model-invocation: true, which ` +
      "blocks the preloading a generated step wrapper depends on: the wrapper injects the body " +
      "at startup rather than waiting for the model to activate it. Remove the field, or point " +
      "the node at a skill that does not set it.",
  ];
}

function isPortableName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && PORTABLE_NAME.test(name);
}

/**
 * Locale-independent ordering, so a report reads the same on every machine.
 * `localeCompare` would not: its result depends on the host's collation.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The closest found name to a referenced one, when anything is close enough.
 *
 * Ties go to the first candidate in sorted order rather than in discovery order,
 * so the same graph against the same skills always suggests the same name.
 */
function nearestName(wanted: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGESTION_DISTANCE + 1;
  for (const name of [...names].sort(compareText)) {
    const distance = editDistance(wanted, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return bestDistance <= SUGGESTION_DISTANCE ? best : undefined;
}

/**
 * Levenshtein distance, one row of the matrix at a time.
 *
 * Written out rather than pulled in, because it is fifteen lines and this
 * package ships no runtime dependencies.
 */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[right.length] ?? right.length;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A frontmatter fence: three dashes alone on a line. */
const FENCE = /^---\s*$/;

/** A line that continues a value rather than opening a key: indented, or a list item. */
const CONTINUATION = /^[\s-]/;

/**
 * One `SKILL.md`, read into the shape the checks consume.
 *
 * Pure, and exported for that reason: it is where the awkward inputs live, and a
 * test should be able to hand it a malformed file without writing one to disk.
 *
 * The parser handles scalars and nothing else. Frontmatter that opens without
 * closing, or a file with no frontmatter at all, yields no fields rather than a
 * repair, so the required-field checks report it as the fault it is. A nested
 * block or a list is skipped rather than flattened, since no field checked here
 * takes one, and inventing a reading for it would only produce a confident wrong
 * answer.
 */
export function parseSkill(text: string, directory: string, source: string): DiscoveredSkill {
  const lines = text.split("\n");
  const close = closingFence(lines);
  if (close === undefined) {
    return { directory, source, frontmatter: {}, bodyChars: bodySize(text) };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    if (line.trim() === "" || line.startsWith("#") || CONTINUATION.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    frontmatter[key] = unquote(line.slice(colon + 1).trim());
  }

  return { directory, source, frontmatter, bodyChars: bodySize(lines.slice(close + 1).join("\n")) };
}

/**
 * Where a frontmatter block ends, when the file opens with one at all.
 *
 * Undefined covers both "no frontmatter" and "opened but never closed". They are
 * the same outcome here: nothing in the file can be read as a field, so the
 * required-field checks report what is missing.
 */
function closingFence(lines: string[]): number | undefined {
  const opening = lines[0];
  if (opening === undefined || !FENCE.test(opening)) return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && FENCE.test(line)) return index;
  }
  return undefined;
}

/**
 * Body size, with surrounding blank space discounted. A skill file typically
 * ends with a newline, and counting it as content would make two identical
 * skills report different costs.
 */
function bodySize(body: string): number {
  return body.trim().length;
}

/** YAML quoting, to the extent a scalar can carry it. */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

/**
 * Read the skills under each root, in precedence order.
 *
 * The whole of this module's I/O, kept trivial for the same reason the emitter's
 * `writeFiles` is: everything worth testing happens in the pure functions above.
 *
 * A skill is a directory holding a `SKILL.md`, one level under a root. Nothing
 * recurses: a nested directory is not how skills are laid out, and walking a
 * whole tree would turn a build check into a filesystem crawl.
 *
 * `roots` is a search path, so the earliest root wins when two of them hold a
 * skill of the same name, and a root that does not exist is skipped rather than
 * failing the build. Any other read failure is thrown: a directory that cannot
 * be read is not the same event as one that is not there, and treating it as
 * "no skills here" would produce a confident report of an unresolved reference.
 *
 * The result is sorted by name, not left in the order the roots and the
 * filesystem happened to produce. `readdir` order is a property of the
 * filesystem, sorted on APFS and hash-ordered on ext4, so an unsorted result
 * would read differently on a developer's machine and in CI for no reason a
 * reader could see. Sorting costs nothing here and the array carries no
 * precedence information to lose: precedence was already applied by keeping the
 * first copy of a duplicated name, and `source` says which root that was.
 *
 * @returns One entry per skill name, sorted by name.
 */
export async function discoverSkills(roots: string[]): Promise<DiscoveredSkill[]> {
  // Imported here rather than at module scope so that importing the pure half of
  // this module pulls in no Node built-ins at all.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(root, { withFileTypes: true });
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    for (const directory of entries) {
      if (seen.has(directory)) continue;
      const source = path.join(root, directory, SKILL_FILE);
      let text: string;
      try {
        text = await fs.readFile(source, "utf8");
      } catch (error) {
        // A directory with no SKILL.md is not a skill. Skipping it is why a
        // reference to it is reported as unresolved rather than as sound.
        if (isMissing(error)) continue;
        throw error;
      }
      seen.add(directory);
      found.push(parseSkill(text, directory, source));
    }
  }

  return found.sort((left, right) => compareText(left.directory, right.directory));
}

/** ENOENT, narrowed from `unknown` without asserting anything about the value. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}
