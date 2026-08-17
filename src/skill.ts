/**
 * A skill, as a domain object.
 *
 * Agent Skills is an open standard and this is a partial implementation of it,
 * knowingly duplicated because no library does the half a compiler needs. Every
 * reader in the ecosystem parses metadata for *listing* skills; none of them
 * writes one back. See minlayer/minflow#4.
 *
 * **Why a class rather than a record.** A compiled workflow has to override
 * frontmatter on the copies it ships: a step's skill must be
 * `user-invocable: false`, so that the one public surface of a compiled
 * workflow is its entry command and not every internal step. Override means
 * read, change, and write back, which is a lifecycle rather than a shape. The
 * fields minflow reasons about are typed properties; everything else is carried
 * through untouched, because a field this compiler does not understand still
 * belongs to the author and still has to survive the round trip.
 *
 * The YAML itself is `yaml`'s problem, not ours. What is written here is the
 * frontmatter split, the fields we take responsibility for, and the bundled
 * resources, which are the parts the standard leaves to the reader.
 *
 * **This module reads the filesystem at module scope**, unlike the rest of the
 * package, which defers its imports so that a pure half can be imported without
 * pulling in Node. A constructor cannot await, and a domain object you build
 * from a path is worth more than the deferral. Everything downstream that has
 * to stay pure, the evaluator and every emitter, takes a `Skill` as a type and
 * never constructs one.
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** The file that makes a directory a skill. */
export const SKILL_FILE = "SKILL.md";

/** Upper bound on a skill name, from the Agent Skills specification. */
export const MAX_NAME_LENGTH = 64;

/** Upper bound on a description, from the Agent Skills specification. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * The portable skill name: lowercase letters, digits, and interior hyphens.
 *
 * Written as groups separated by single hyphens, so a leading, trailing, or
 * doubled hyphen fails to match without needing a rule of its own.
 */
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Opening and closing fence of a frontmatter block, with the block between. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * Frontmatter keys this compiler takes responsibility for.
 *
 * Everything else is passthrough. Listed rather than inferred so that adding a
 * typed property is a deliberate act: a key that quietly moves from passthrough
 * to owned changes what a round trip produces.
 */
const OWNED_KEYS = new Set(["name", "description", "user-invocable"]);

/** What {@link Skill.problems} reports, and what a caller may repair. */
export interface SkillProblem {
  /** The field at fault, or `"frontmatter"` when the block itself is. */
  field: string;
  /** What is wrong, in a sentence a reader can act on. */
  detail: string;
}

/** Everything a skill is, once read. Plain data, for a caller that wants it. */
export interface SkillData {
  name: string;
  description: string;
  userInvocable: boolean;
  /** Frontmatter keys this compiler does not own, exactly as written. */
  fields: Record<string, unknown>;
  /** Everything after the frontmatter block. */
  body: string;
  /** Bundled resources, as paths relative to the skill directory. */
  files: Record<string, string>;
  /** Where it was read from, so a problem carries an address a reader can open. */
  source?: string;
}

export class Skill {
  #name: string;
  #description: string;
  #userInvocable: boolean;
  #fields: Record<string, unknown>;
  #body: string;
  #files: Record<string, string>;
  #source: string | undefined;
  /** Frontmatter faults found while reading, kept rather than thrown. */
  #problems: SkillProblem[];

  /**
   * Reads the skill in `directory`, or takes one already in hand.
   *
   * The path form is the headline: `new Skill("skills/draft")`. Synchronous on
   * purpose, because this is a build-time compiler, the files are small, and a
   * constructor cannot await.
   *
   * The data form exists because private fields are installed by a constructor
   * and by nothing else, so a static factory that built an object some other way
   * would produce something that is not a Skill. Every construction path
   * therefore ends here.
   *
   * Bundled resources come too. A skill is a directory, not a file: a body that
   * says "see `references/rules.md`" is broken by a copy that brings only the
   * body, and broken silently, because the body still loads.
   */
  constructor(directory: string);
  constructor(data: SkillData & { problems?: SkillProblem[] });
  constructor(from: string | (SkillData & { problems?: SkillProblem[] })) {
    if (typeof from !== "string") {
      this.#name = from.name;
      this.#description = from.description;
      this.#userInvocable = from.userInvocable;
      this.#fields = { ...from.fields };
      this.#body = from.body;
      this.#files = { ...from.files };
      this.#source = from.source;
      this.#problems = [...(from.problems ?? [])];
      return;
    }

    const source = join(from, SKILL_FILE);
    const parsed = Skill.#read(readFileSync(source, "utf8"), basename(from));

    this.#name = parsed.name;
    this.#description = parsed.description;
    this.#userInvocable = parsed.userInvocable;
    this.#fields = parsed.fields;
    this.#body = parsed.body;
    this.#problems = parsed.problems;
    this.#source = source;
    this.#files = {};

    for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || entry.name === SKILL_FILE || entry.name.startsWith(".")) continue;
      const absolute = join(entry.parentPath, entry.name);
      const key = relative(from, absolute).split(sep).join("/");
      this.#files[key] = readFileSync(absolute, "utf8");
    }
  }

  /**
   * Reads a skill from text instead of from disk.
   *
   * The pure half, so the interesting behaviour is testable with no filesystem
   * and a caller holding text from somewhere else is not forced to write it out
   * first.
   */
  static parse(text: string, directoryName: string, source?: string): Skill {
    const parsed = Skill.#read(text, directoryName);
    const data: SkillData & { problems: SkillProblem[] } = {
      name: parsed.name,
      description: parsed.description,
      userInvocable: parsed.userInvocable,
      fields: parsed.fields,
      body: parsed.body,
      files: {},
      problems: parsed.problems,
    };
    if (source !== undefined) data.source = source;
    return new Skill(data);
  }

  /** Builds one from data, for a test or a caller synthesising a skill. */
  static from(data: Partial<SkillData> & { name: string; description: string }): Skill {
    const full: SkillData = {
      name: data.name,
      description: data.description,
      userInvocable: data.userInvocable ?? true,
      fields: data.fields ?? {},
      body: data.body ?? "",
      files: data.files ?? {},
    };
    if (data.source !== undefined) full.source = data.source;
    return new Skill(full);
  }

  // -------------------------------------------------------------------------
  // The fields we own
  // -------------------------------------------------------------------------

  get name(): string {
    return this.#name;
  }

  get description(): string {
    return this.#description;
  }

  /**
   * Whether the user may invoke this skill directly.
   *
   * The one field minflow exists to override. A compiled workflow's steps are
   * implementation, and a plugin that exposes nine invocable skills alongside
   * its entry command has nine public surfaces that mean nothing on their own.
   *
   * Absent in the source means true, which is the platform's default, so
   * writing `false` is always a change rather than sometimes a no-op.
   */
  get userInvocable(): boolean {
    return this.#userInvocable;
  }

  set userInvocable(value: boolean) {
    this.#userInvocable = value;
  }

  /** Everything after the frontmatter block. */
  get body(): string {
    return this.#body;
  }

  /** Bundled resources, keyed by path relative to the skill directory. */
  get files(): Readonly<Record<string, string>> {
    return this.#files;
  }

  /** Where it was read from, when it was read from anywhere. */
  get source(): string | undefined {
    return this.#source;
  }

  // -------------------------------------------------------------------------
  // The fields we do not
  // -------------------------------------------------------------------------

  /**
   * A frontmatter field this compiler does not model.
   *
   * `allowed-tools`, `argument-hint`, `license`, `metadata`, and whatever a
   * future revision of the standard adds. Readable and writable, and carried
   * through the round trip untouched when neither.
   */
  field(key: string): unknown {
    return this.#fields[key];
  }

  setField(key: string, value: unknown): void {
    if (OWNED_KEYS.has(key)) {
      throw new Error(
        `minflow: "${key}" is a field Skill models directly. Set skill.${
          key === "user-invocable" ? "userInvocable" : key
        } instead, so the typed value and the written one cannot disagree.`,
      );
    }
    this.#fields[key] = value;
  }

  /** Every passthrough key, for a caller that wants to inspect them. */
  get fields(): Readonly<Record<string, unknown>> {
    return this.#fields;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Everything wrong with this skill, as the specification defines wrong.
   *
   * Collected rather than thrown, because a compiler reporting every fault at
   * once beats one that stops at the first. `directoryName` is compared against
   * `name` by the caller that knows both.
   */
  problems(): SkillProblem[] {
    const found = [...this.#problems];

    if (this.#name === "") {
      found.push({ field: "name", detail: "is missing. Every skill needs one." });
    } else if (this.#name.length > MAX_NAME_LENGTH) {
      found.push({
        field: "name",
        detail: `is ${this.#name.length} characters. The specification allows ${MAX_NAME_LENGTH}.`,
      });
    } else if (!PORTABLE_NAME.test(this.#name)) {
      found.push({
        field: "name",
        detail:
          `is "${this.#name}". A portable name is lowercase letters, digits and interior ` +
          "hyphens, so this may resolve on one platform and not another.",
      });
    }

    if (this.#description === "") {
      found.push({
        field: "description",
        detail:
          "is missing. It is what the platform matches on to decide whether the skill " +
          "applies, so a skill without one is never selected.",
      });
    } else if (this.#description.length > MAX_DESCRIPTION_LENGTH) {
      found.push({
        field: "description",
        detail: `is ${this.#description.length} characters. The specification allows ${MAX_DESCRIPTION_LENGTH}.`,
      });
    }

    return found;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * The skill as a `SKILL.md`, ready to be written.
   *
   * The owned fields are emitted first and in a fixed order so that two skills
   * differing only in what a compiler changed produce a readable diff. Passthrough
   * fields follow in the order they were read.
   *
   * `user-invocable` is written only when false. Absent means true on the
   * platform, so emitting `true` would add a line that says nothing, and the
   * whole point of this method is that the line which *does* say something is
   * visible.
   */
  toMarkdown(): string {
    const front: Record<string, unknown> = {
      name: this.#name,
      description: this.#description,
    };
    if (!this.#userInvocable) front["user-invocable"] = false;
    for (const [key, value] of Object.entries(this.#fields)) front[key] = value;

    const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
    const body = this.#body.replace(/^\n+/, "");
    return `---\n${yaml}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
  }

  /**
   * A copy with `user-invocable` set, leaving this one untouched.
   *
   * An emitter is a pure function of its arguments, so it cannot reach in and
   * flip the flag on a skill its caller still holds. Exposed as a method rather
   * than done by cloning at the call site so that a backend needs the `Skill`
   * *type* and never the class, which is what keeps the emitters free of the
   * filesystem this module imports.
   */
  withUserInvocable(value: boolean): Skill {
    const copy = new Skill(this.toData());
    copy.userInvocable = value;
    return copy;
  }

  /** The whole skill as plain data, for a caller that would rather have a record. */
  toData(): SkillData {
    const data: SkillData = {
      name: this.#name,
      description: this.#description,
      userInvocable: this.#userInvocable,
      fields: { ...this.#fields },
      body: this.#body,
      files: { ...this.#files },
    };
    if (this.#source !== undefined) data.source = this.#source;
    return data;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * The frontmatter split, and the only part of parsing that is ours.
   *
   * A file with no frontmatter is not an error here: it parses to a skill with
   * no name and no description, and {@link problems} reports both. Throwing
   * would mean a malformed skill stops the compiler before it can tell the
   * author what else is wrong.
   */
  static #read(
    text: string,
    directoryName: string,
  ): {
    name: string;
    description: string;
    userInvocable: boolean;
    fields: Record<string, unknown>;
    body: string;
    problems: SkillProblem[];
  } {
    const problems: SkillProblem[] = [];
    const match = FRONTMATTER.exec(text);

    if (match === null) {
      problems.push({
        field: "frontmatter",
        detail:
          "is missing or never closed. A skill opens with a --- fenced YAML block holding at " +
          "least a name and a description.",
      });
      // The directory still names it, which is what a reference resolves by, so
      // the fallback applies here as much as when the block parsed. Reporting
      // "no frontmatter" and "no name" as two faults would be one fault twice.
      return {
        name: directoryName,
        description: "",
        userInvocable: true,
        fields: {},
        body: text,
        problems,
      };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? "");
    } catch (error) {
      problems.push({
        field: "frontmatter",
        detail: `is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
      parsed = null;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (problems.length === 0) {
        problems.push({
          field: "frontmatter",
          detail: "is not a mapping of fields.",
        });
      }
      return {
        name: directoryName,
        description: "",
        userInvocable: true,
        fields: {},
        body: text.slice(match[0].length),
        problems,
      };
    }

    const front = parsed as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(front)) {
      if (!OWNED_KEYS.has(key)) fields[key] = value;
    }

    // A name is compared against its directory by the caller, but a name that is
    // not a string at all is a fault this layer can see on its own.
    const name = typeof front.name === "string" ? front.name.trim() : "";
    if (front.name !== undefined && typeof front.name !== "string") {
      problems.push({ field: "name", detail: "is not a string." });
    }
    const description = typeof front.description === "string" ? front.description.trim() : "";
    if (front.description !== undefined && typeof front.description !== "string") {
      problems.push({ field: "description", detail: "is not a string." });
    }

    const declared = front["user-invocable"];
    if (declared !== undefined && typeof declared !== "boolean") {
      problems.push({
        field: "user-invocable",
        detail: `is ${JSON.stringify(declared)}, which is not a boolean. Read as false.`,
      });
    }

    return {
      name: name === "" ? directoryName : name,
      description,
      userInvocable: declared === undefined ? true : declared === true,
      fields,
      body: text.slice(match[0].length),
      problems,
    };
  }
}
