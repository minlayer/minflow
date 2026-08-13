import { describe, expect, it } from "vitest";

import type { IrNode } from "../src/ir.js";
import {
  checkSkills,
  type DiscoveredSkill,
  discoverSkills,
  parseSkill,
  preloadCost,
  SKILL_FILE,
  type SkillReferencingGraph,
} from "../src/skills.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A skill with sound frontmatter, plus whatever the test wants to break. */
function found(directory: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    directory,
    source: `skills/${directory}/${SKILL_FILE}`,
    frontmatter: { name: directory, description: `What ${directory} does.` },
    bodyChars: 100,
    ...overrides,
  };
}

/** The same skill with one frontmatter field replaced or removed. */
function withFrontmatter(
  skill: DiscoveredSkill,
  frontmatter: Record<string, string>,
): DiscoveredSkill {
  return { ...skill, frontmatter };
}

/** A graph of nodes naming skills, which is all these checks read. */
function graph(...pairs: [node: string, skill: string][]): SkillReferencingGraph {
  const nodes: IrNode[] = pairs.map(([id, skill]) => ({ id, skill }));
  return { nodes };
}

/** The one problem a check produced, failing loudly when it produced anything else. */
function onlyProblem(problems: string[]): string {
  if (problems.length !== 1) {
    throw new Error(
      `expected exactly one problem, got ${problems.length}: ${problems.join(" | ")}`,
    );
  }
  const first = problems[0];
  if (first === undefined) throw new Error("unreachable: length was checked");
  return first;
}

async function nodeModules() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return { fs, os, path };
}

// ---------------------------------------------------------------------------
// A sound graph
// ---------------------------------------------------------------------------

describe("checkSkills", () => {
  it("reports nothing when every referenced skill resolves and is well formed", () => {
    const skills = [found("research-topic"), found("write-plan"), found("review-changes")];
    const sound = graph(
      ["research", "research-topic"],
      ["plan", "write-plan"],
      ["review", "review-changes"],
    );

    expect(checkSkills(sound, skills)).toEqual([]);
  });

  it("ignores skills the graph does not name", () => {
    // A repository holds skills this workflow has nothing to do with. Their
    // frontmatter is not this graph's problem, and reporting it here would bury
    // the lines that are.
    const broken = withFrontmatter(found("unrelated"), {});
    expect(checkSkills(graph(["research", "research-topic"]), [found("research-topic"), broken])) //
      .toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 1. The skill exists
  // -------------------------------------------------------------------------

  it("names the node and the skill when a reference does not resolve", () => {
    const problems = checkSkills(graph(["research", "research-topic"]), []);
    const problem = onlyProblem(problems);

    expect(problem).toContain('node "research"');
    expect(problem).toContain('names skill "research-topic"');
    // The consequence is the reason this check exists at all: without it the run
    // is green and the step ran with no instructions.
    expect(problem).toContain("debug-log warning");
    expect(problem).toContain("No skills were found at all");
  });

  it("suggests the near match, since a typo is what usually produces this", () => {
    const problems = checkSkills(graph(["research", "reserch-topic"]), [
      found("research-topic"),
      found("write-plan"),
    ]);

    expect(onlyProblem(problems)).toContain('Did you mean "research-topic"?');
  });

  it("lists what was found when nothing is close enough to suggest", () => {
    const problems = checkSkills(graph(["research", "research-topic"]), [
      found("write-plan"),
      found("audit"),
    ]);
    const problem = onlyProblem(problems);

    expect(problem).not.toContain("Did you mean");
    // Sorted, not in discovery order, so the same inputs always read the same.
    expect(problem).toContain("Skills found: audit, write-plan.");
  });

  it("reports an unresolved reference once per node, because each is its own typo", () => {
    const problems = checkSkills(
      graph(["research", "reserch-topic"], ["recheck", "research-topi"]),
      [found("research-topic")],
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('node "research" names skill "reserch-topic"');
    expect(problems[1]).toContain('node "recheck" names skill "research-topi"');
    for (const problem of problems) {
      expect(problem).toContain('Did you mean "research-topic"?');
    }
  });

  // -------------------------------------------------------------------------
  // 2. name matches the parent directory
  // -------------------------------------------------------------------------

  it("reports a name that does not match its parent directory", () => {
    const mismatched = withFrontmatter(found("reviewer"), {
      name: "review-changes",
      description: "Reviews changes.",
    });
    const problems = checkSkills(graph(["review", "reviewer"]), [mismatched]);
    const problem = onlyProblem(problems);

    expect(problem).toContain('declares name "review-changes"');
    expect(problem).toContain('directory "reviewer"');
    expect(problem).toContain("skills/reviewer/SKILL.md");
    // Both ways out, because either edit is legitimate and the author knows
    // which name the rest of their setup already uses.
    expect(problem).toContain('Set "name: reviewer"');
    expect(problem).toContain('rename the directory to "review-changes"');
  });

  it("reports a frontmatter fault once, however many nodes name that skill", () => {
    // One file, one fix. Repeating it per node would turn a single edit into a
    // report the reader has to deduplicate by hand.
    const mismatched = withFrontmatter(found("reviewer"), {
      name: "review-changes",
      description: "Reviews changes.",
    });
    const problems = checkSkills(graph(["review", "reviewer"], ["recheck", "reviewer"]), [
      mismatched,
    ]);

    expect(problems).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 3. disable-model-invocation
  // -------------------------------------------------------------------------

  it("reports disable-model-invocation, which blocks the preloading a wrapper needs", () => {
    const disabled = withFrontmatter(found("research-topic"), {
      name: "research-topic",
      description: "Researches a topic.",
      "disable-model-invocation": "true",
    });
    const problem = onlyProblem(checkSkills(graph(["research", "research-topic"]), [disabled]));

    expect(problem).toContain("disable-model-invocation: true");
    expect(problem).toContain("blocks the preloading");
  });

  it("leaves disable-model-invocation: false alone", () => {
    const enabled = withFrontmatter(found("research-topic"), {
      name: "research-topic",
      description: "Researches a topic.",
      "disable-model-invocation": "false",
    });

    expect(checkSkills(graph(["research", "research-topic"]), [enabled])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. Required fields and the portable name charset
  // -------------------------------------------------------------------------

  it("reports a missing name and a missing description separately", () => {
    const bare = withFrontmatter(found("research-topic"), {});
    const problems = checkSkills(graph(["research", "research-topic"]), [bare]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("declares no name");
    expect(problems[0]).toContain('Add "name: research-topic"');
    expect(problems[1]).toContain("declares no description");
  });

  it("treats an empty name or description as absent", () => {
    const blank = withFrontmatter(found("research-topic"), { name: "", description: "" });
    const problems = checkSkills(graph(["research", "research-topic"]), [blank]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("declares no name");
    expect(problems[1]).toContain("declares no description");
  });

  it("does not add a mismatch line when the name is absent, since there is none to mismatch", () => {
    const bare = withFrontmatter(found("research-topic"), { description: "Researches a topic." });

    expect(onlyProblem(checkSkills(graph(["research", "research-topic"]), [bare]))).toContain(
      "declares no name",
    );
  });

  it("rejects every name outside the portable charset", () => {
    const unportable = [
      "Research-Topic",
      "research topic",
      "research_topic",
      "-research",
      "research-",
      "research--topic",
      "résearch",
      "a".repeat(65),
    ];

    for (const name of unportable) {
      // The directory is set to the same string, so the mismatch check cannot
      // fire and the charset line is the only one left.
      const skill = withFrontmatter(found(name), { name, description: "Does a thing." });
      const problem = onlyProblem(checkSkills(graph(["research", name]), [skill]));
      expect(problem, `expected "${name}" to be rejected as a name`).toContain(
        "which is not a portable skill name",
      );
    }
  });

  it("accepts the names the charset allows", () => {
    for (const name of ["a", "research", "research-topic", "step-2-of-3", "a".repeat(64)]) {
      const skill = withFrontmatter(found(name), { name, description: "Does a thing." });
      expect(checkSkills(graph(["research", name]), [skill]), name).toEqual([]);
    }
  });

  it("reports the charset alongside the mismatch when a name breaks both rules", () => {
    const skill = withFrontmatter(found("research-topic"), {
      name: "Research Topic",
      description: "Researches a topic.",
    });
    const problems = checkSkills(graph(["research", "research-topic"]), [skill]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("requires the two to match");
    expect(problems[1]).toContain("not a portable skill name");
  });

  it("resolves a reference by directory, not by the name the frontmatter declares", () => {
    // The graph names what the frontmatter says, and the directory says
    // something else. Both lines are true and together they explain the failure.
    const mismatched = withFrontmatter(found("reviewer"), {
      name: "review-changes",
      description: "Reviews changes.",
    });
    const problems = checkSkills(graph(["review", "review-changes"]), [mismatched]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'node "review" names skill "review-changes", which was not found',
    );
  });
});

// ---------------------------------------------------------------------------
// The always-on cost
// ---------------------------------------------------------------------------

describe("preloadCost", () => {
  it("reports each referenced skill's body size, largest first", () => {
    const skills = [
      found("research-topic", { bodyChars: 400 }),
      found("write-plan", { bodyChars: 9000 }),
      found("review-changes", { bodyChars: 400 }),
    ];
    // The two skills of equal size are declared in the order that a stable sort
    // would preserve and a name tie-break would reverse, so this pins the
    // tie-break rather than the sort's incidental stability.
    const costs = preloadCost(
      graph(["review", "review-changes"], ["plan", "write-plan"], ["research", "research-topic"]),
      skills,
    );

    expect(costs).toEqual([
      { skill: "write-plan", nodes: ["plan"], bodyChars: 9000 },
      { skill: "research-topic", nodes: ["research"], bodyChars: 400 },
      { skill: "review-changes", nodes: ["review"], bodyChars: 400 },
    ]);
  });

  it("lists every node paying for a skill, since each pays the body per invocation", () => {
    const costs = preloadCost(graph(["review", "reviewer"], ["recheck", "reviewer"]), [
      found("reviewer", { bodyChars: 250 }),
    ]);

    expect(costs).toEqual([{ skill: "reviewer", nodes: ["review", "recheck"], bodyChars: 250 }]);
  });

  it("omits a skill that does not resolve, which has no body to measure", () => {
    const costs = preloadCost(graph(["research", "research-topic"], ["plan", "write-plan"]), [
      found("write-plan", { bodyChars: 10 }),
    ]);

    expect(costs).toEqual([{ skill: "write-plan", nodes: ["plan"], bodyChars: 10 }]);
  });
});

// ---------------------------------------------------------------------------
// Parsing one SKILL.md
// ---------------------------------------------------------------------------

describe("parseSkill", () => {
  it("reads scalars out of the frontmatter and measures the body", () => {
    const text = [
      "---",
      "name: research-topic",
      'description: "Researches a topic."',
      "disable-model-invocation: true",
      "---",
      "",
      "Do the research.",
      "",
    ].join("\n");

    const skill = parseSkill(text, "research-topic", "skills/research-topic/SKILL.md");

    expect(skill.frontmatter).toEqual({
      name: "research-topic",
      description: "Researches a topic.",
      "disable-model-invocation": "true",
    });
    // The body, with the frontmatter and the surrounding blank lines discounted.
    expect(skill.bodyChars).toBe("Do the research.".length);
    expect(skill.directory).toBe("research-topic");
    expect(skill.source).toBe("skills/research-topic/SKILL.md");
  });

  it("survives CRLF line endings and single quotes", () => {
    const text = "---\r\nname: 'plan'\r\ndescription: Plans.\r\n---\r\nBody.\r\n";
    const skill = parseSkill(text, "plan", "skills/plan/SKILL.md");

    expect(skill.frontmatter).toEqual({ name: "plan", description: "Plans." });
  });

  it("reads no fields from a file with no frontmatter, rather than inventing them", () => {
    const skill = parseSkill("# Just a document\n\nBody.\n", "plan", "skills/plan/SKILL.md");

    expect(skill.frontmatter).toEqual({});
    expect(skill.bodyChars).toBe("# Just a document\n\nBody.".length);
    // Which is exactly what makes the required-field checks fire on it.
    expect(checkSkills(graph(["plan", "plan"]), [skill])).toHaveLength(2);
  });

  it("reads no fields from an unterminated frontmatter block", () => {
    const skill = parseSkill("---\nname: plan\ndescription: Plans.\n", "plan", "s/plan/SKILL.md");

    expect(skill.frontmatter).toEqual({});
  });

  it("skips comments, list items, and indented continuations", () => {
    const text = [
      "---",
      "# a comment: not a field",
      "name: plan",
      "description: Plans.",
      "allowed-tools:",
      "  - Read",
      "  - Grep",
      "metadata:",
      "  owner: platform",
      "---",
      "Body.",
    ].join("\n");

    const skill = parseSkill(text, "plan", "skills/plan/SKILL.md");

    // Keys whose value is a nested block are recorded as empty rather than
    // flattened, and nothing indented under them becomes a field of its own.
    expect(skill.frontmatter).toEqual({
      name: "plan",
      description: "Plans.",
      "allowed-tools": "",
      metadata: "",
    });
  });

  it("keeps a colon inside a value", () => {
    const text = "---\nname: plan\ndescription: Use when: planning work.\n---\nBody.";
    const skill = parseSkill(text, "plan", "skills/plan/SKILL.md");

    expect(skill.frontmatter.description).toBe("Use when: planning work.");
  });
});

// ---------------------------------------------------------------------------
// discoverSkills: the whole of the I/O
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  it("reads SKILL.md one level under each root, with earlier roots winning", async () => {
    const { fs, os, path } = await nodeModules();
    // Unique per run and under the OS temp dir, so two runs of this suite cannot
    // collide and nothing is written anywhere near the repository.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-skills-"));
    try {
      const project = path.join(dir, "project");
      const personal = path.join(dir, "personal");

      const write = async (root: string, directory: string, text: string) => {
        await fs.mkdir(path.join(root, directory), { recursive: true });
        await fs.writeFile(path.join(root, directory, SKILL_FILE), text, "utf8");
      };

      await write(project, "research-topic", "---\nname: research-topic\ndesc: x\n---\nBody.\n");
      await write(
        project,
        "write-plan",
        "---\nname: write-plan\ndescription: Plans.\n---\nPlan.\n",
      );
      await write(personal, "write-plan", "---\nname: shadowed\ndescription: Other.\n---\nNo.\n");
      await write(
        personal,
        "review-changes",
        "---\nname: review-changes\ndescription: Reviews.\n---\nReview.\n",
      );
      // A directory with no SKILL.md is not a skill, so a reference to it stays
      // unresolved rather than quietly passing the existence check.
      await fs.mkdir(path.join(project, "not-a-skill"), { recursive: true });
      // A loose file beside the directories is not a skill either.
      await fs.writeFile(path.join(project, "README.md"), "nothing", "utf8");

      const skills = await discoverSkills([project, personal, path.join(dir, "absent")]);

      // Sorted by name rather than left in root order or in whatever order the
      // filesystem returned, which differs between APFS and ext4.
      expect(skills.map((skill) => skill.directory)).toEqual([
        "research-topic",
        "review-changes",
        "write-plan",
      ]);

      const plan = skills.find((skill) => skill.directory === "write-plan");
      expect(plan?.source).toBe(path.join(project, "write-plan", SKILL_FILE));
      // The first root wins: the personal copy declaring "shadowed" is not it.
      expect(plan?.frontmatter).toEqual({ name: "write-plan", description: "Plans." });
      expect(plan?.bodyChars).toBe("Plan.".length);

      // And the checks run over exactly what was read: the project skill is
      // missing a description, and the personal one is missing nothing.
      const problems = checkSkills(
        graph(["research", "research-topic"], ["plan", "write-plan"], ["review", "review-changes"]),
        skills,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('skill "research-topic"');
      expect(problems[0]).toContain("declares no description");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing when no root exists, rather than failing the build", async () => {
    const { fs, os, path } = await nodeModules();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-skills-empty-"));
    try {
      await expect(discoverSkills([path.join(dir, "absent")])).resolves.toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when a root cannot be read, which is not the same as not being there", async () => {
    const { fs, os, path } = await nodeModules();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-skills-unreadable-"));
    try {
      const notADirectory = path.join(dir, "skills");
      await fs.writeFile(notADirectory, "this is a file", "utf8");
      // Swallowing this would report "no skills here", and every reference into
      // that root would then be reported as an unresolved name, which is a
      // confident answer to the wrong question.
      await expect(discoverSkills([notADirectory])).rejects.toThrow(/ENOTDIR/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
