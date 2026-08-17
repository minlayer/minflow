import { describe, expect, it } from "vitest";

import { Skill } from "../src/skill.js";

/** A skill carrying one of every kind of field: owned, passthrough, unknown. */
function source(): string {
  return [
    "---",
    "name: draft-section",
    'description: "Draft one section: in place."',
    "allowed-tools: Read, Edit",
    "license: MIT",
    "custom-vendor-field: keep me",
    "---",
    "",
    "# Draft one section",
    "",
    "Body text.",
    "",
  ].join("\n");
}

describe("reading a skill", () => {
  it("types the fields it owns and passes the rest through", () => {
    const skill = Skill.parse(source(), "draft-section");
    expect(skill.name).toBe("draft-section");
    expect(skill.description).toBe("Draft one section: in place.");
    expect(skill.field("allowed-tools")).toBe("Read, Edit");
    expect(skill.field("license")).toBe("MIT");
    expect(skill.field("custom-vendor-field")).toBe("keep me");
    // Owned fields are not also passthrough, or a round trip would write them twice.
    expect(Object.keys(skill.fields).sort()).toEqual([
      "allowed-tools",
      "custom-vendor-field",
      "license",
    ]);
  });

  it("reads an absent user-invocable as true, which is the platform's default", () => {
    expect(Skill.parse(source(), "draft-section").userInvocable).toBe(true);
  });

  it("reads a declared user-invocable", () => {
    const text = source().replace("license: MIT", "user-invocable: false\nlicense: MIT");
    expect(Skill.parse(text, "draft-section").userInvocable).toBe(false);
  });

  it("keeps the body exactly, including its blank lines", () => {
    expect(Skill.parse(source(), "draft-section").body).toBe(
      "\n# Draft one section\n\nBody text.\n",
    );
  });

  it("falls back to the directory name when the frontmatter omits one", () => {
    const text = ["---", "description: Something.", "---", "", "Body."].join("\n");
    expect(Skill.parse(text, "from-the-directory").name).toBe("from-the-directory");
  });

  it("reports a missing frontmatter block rather than throwing", () => {
    const skill = Skill.parse("# Just a heading\n", "orphan");
    expect(skill.problems().map((problem) => problem.field)).toContain("frontmatter");
    // Still usable, so a compiler can report every fault in one pass.
    expect(skill.body).toBe("# Just a heading\n");
  });

  it("reports unparseable YAML rather than throwing", () => {
    const text = ["---", "name: [unclosed", "---", "", "Body."].join("\n");
    const problems = Skill.parse(text, "broken").problems();
    expect(problems.some((problem) => /not valid YAML/.test(problem.detail))).toBe(true);
  });

  it("reports a description that would never be matched on", () => {
    const text = ["---", "name: nameless", "---", "", "Body."].join("\n");
    const problems = Skill.parse(text, "nameless").problems();
    expect(problems.some((problem) => problem.field === "description")).toBe(true);
    expect(problems.map((problem) => problem.detail).join(" ")).toMatch(/never selected/);
  });

  it("reports a name that will not resolve portably", () => {
    const text = ["---", "name: Draft_Section", "description: x", "---", "", "y"].join("\n");
    const problems = Skill.parse(text, "Draft_Section").problems();
    expect(problems.some((problem) => problem.field === "name")).toBe(true);
  });

  it("reports a user-invocable that is not a boolean, and reads it as false", () => {
    const text = source().replace("license: MIT", 'user-invocable: "no"\nlicense: MIT');
    const skill = Skill.parse(text, "draft-section");
    expect(skill.problems().some((problem) => problem.field === "user-invocable")).toBe(true);
    expect(skill.userInvocable).toBe(false);
  });
});

describe("writing a skill back", () => {
  it("round trips every field, owned and not", () => {
    const written = Skill.parse(source(), "draft-section").toMarkdown();
    const again = Skill.parse(written, "draft-section");
    expect(again.name).toBe("draft-section");
    expect(again.description).toBe("Draft one section: in place.");
    expect(again.field("allowed-tools")).toBe("Read, Edit");
    expect(again.field("custom-vendor-field")).toBe("keep me");
    expect(again.body.trim()).toBe("# Draft one section\n\nBody text.");
  });

  it("quotes a description that would otherwise break the YAML", () => {
    // The failure this prevents is silent: Claude Code loads a skill whose
    // frontmatter will not parse with every field dropped, so the skill has no
    // description and is never selected.
    const written = Skill.parse(source(), "draft-section").toMarkdown();
    expect(written).toContain('description: "Draft one section: in place."');
    expect(Skill.parse(written, "draft-section").description).toBe("Draft one section: in place.");
  });

  it("writes user-invocable only when it is false", () => {
    const open = Skill.parse(source(), "draft-section");
    expect(open.toMarkdown()).not.toContain("user-invocable");
    expect(open.withUserInvocable(false).toMarkdown()).toContain("user-invocable: false");
  });

  it("puts the owned fields first, so a compiler's change is the visible line", () => {
    const written = Skill.parse(source(), "draft-section").withUserInvocable(false).toMarkdown();
    const lines = written.split("\n");
    expect(lines[1]).toBe("name: draft-section");
    expect(lines[2]).toBe('description: "Draft one section: in place."');
    expect(lines[3]).toBe("user-invocable: false");
  });

  it("leaves the original alone when overriding", () => {
    const skill = Skill.parse(source(), "draft-section");
    const copy = skill.withUserInvocable(false);
    expect(copy.userInvocable).toBe(false);
    expect(skill.userInvocable).toBe(true);
    expect(skill.toMarkdown()).not.toContain("user-invocable");
  });

  it("refuses to set an owned field through the passthrough door", () => {
    const skill = Skill.parse(source(), "draft-section");
    expect(() => skill.setField("user-invocable", false)).toThrow(/Set skill.userInvocable/);
    expect(() => skill.setField("description", "x")).toThrow(/Skill models directly/);
    // A field it does not own is fine, and survives as the type it was set as:
    // the brackets get quoted, or reading it back would yield a list.
    skill.setField("argument-hint", "[--flag]");
    expect(Skill.parse(skill.toMarkdown(), "draft-section").field("argument-hint")).toBe(
      "[--flag]",
    );
  });
});

describe("a skill on disk", () => {
  it("brings its bundled resources with it", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "minflow-skill-"));
    try {
      const dir = path.join(root, "draft-section");
      await fs.mkdir(path.join(dir, "references"), { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), source(), "utf8");
      await fs.writeFile(path.join(dir, "references", "rules.md"), "# Rules\n", "utf8");
      await fs.writeFile(path.join(dir, "scripts", "..", "run.sh"), "echo hi\n", "utf8");

      const skill = new Skill(dir);
      expect(skill.name).toBe("draft-section");
      // A body that says "see references/rules.md" is broken by a copy that
      // brings only the body, and broken silently.
      expect(skill.files["references/rules.md"]).toBe("# Rules\n");
      expect(skill.files["run.sh"]).toBe("echo hi\n");
      expect(skill.source).toBe(path.join(dir, "SKILL.md"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
