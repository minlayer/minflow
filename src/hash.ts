/**
 * Canonical serialization and the graph hash.
 *
 * The hash is stamped into the compiled graph and into run state, and a resume
 * compares the two (see `RunState.graphHash` in {@link ./ir.ts}). That job only
 * works if the same graph hashes to the same string in a different process, on a
 * different day, built by code that happened to assign its properties in a
 * different order. `JSON.stringify` does not give that: it preserves insertion
 * order, so two structurally identical graphs can serialize differently. Hence a
 * canonical form of our own.
 *
 * Two rules, and the asymmetry is deliberate:
 *
 * - **Object keys are sorted**, recursively. Key order carries no meaning in the
 *   IR, so it must not reach the digest.
 * - **Array order is preserved.** In this IR array order *is* semantics: when
 *   several edges out of a node could fire, the first one wins. Sorting edges
 *   would make two genuinely different graphs hash alike.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

import type { WorkflowIr } from "./ir.js";

/**
 * Hex characters kept from the digest.
 *
 * 16 hex characters is 64 bits, which is short enough to read in a manifest or a
 * commit message and long enough that an accidental collision between two
 * workflow graphs is not a thing that happens. It is not a security boundary:
 * the hash detects *edits*, not tampering.
 */
export const GRAPH_HASH_LENGTH = 16;

/** A graph to hash, with or without a `hash` field already stamped on it. */
export type HashableGraph = WorkflowIr | Omit<WorkflowIr, "hash">;

/**
 * Deterministic JSON serialization.
 *
 * Intended for {@link JsonValue}-shaped data; anything else is coerced the way
 * `JSON.stringify` coerces it, so the two agree on every input both accept:
 *
 * - object keys are emitted in sorted order, recursively;
 * - array order is left exactly as given;
 * - `undefined`, functions and symbols are dropped from objects and become
 *   `null` inside arrays;
 * - non-finite numbers become `null`;
 * - a `toJSON()` method is honoured before serializing;
 * - a top-level value with no JSON representation serializes as `null` rather
 *   than the `undefined` `JSON.stringify` returns.
 *
 * Unlike `JSON.stringify` it refuses a circular structure with a message that
 * names the problem instead of overflowing the stack.
 */
export function canonicalize(value: unknown): string {
  return encode(value, new Set<object>()) ?? "null";
}

/**
 * Digest of a graph's canonical form, minus its own `hash` field.
 *
 * Excluding `hash` is what makes the value self-consistent: the hash of a
 * compiled graph can be recomputed from that same compiled graph and compared,
 * which is exactly what a resume does.
 *
 * Every other property is included generically rather than field by field, so a
 * field added to the IR later is covered without anyone remembering to add it
 * here.
 */
export function graphHash(graph: HashableGraph): string {
  const withoutHash: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(graph)) {
    if (key === "hash") continue;
    withoutHash[key] = value;
  }
  return createHash("sha256")
    .update(canonicalize(withoutHash), "utf8")
    .digest("hex")
    .slice(0, GRAPH_HASH_LENGTH);
}

/**
 * Returns the canonical encoding of `value`, or `undefined` when the value has
 * no JSON representation at all (which the caller renders as an omitted key or
 * a `null` array slot, matching `JSON.stringify`).
 */
function encode(value: unknown, seen: Set<object>): string | undefined {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "bigint") {
    throw new TypeError("canonicalize: a bigint has no JSON representation");
  }
  if (type !== "object") return undefined;

  const asObject = value as object;
  const custom = (asObject as { toJSON?: unknown }).toJSON;
  if (typeof custom === "function") {
    return encode((custom as () => unknown).call(asObject), seen);
  }

  if (seen.has(asObject)) {
    throw new TypeError("canonicalize: circular reference. The IR must be a plain JSON tree");
  }
  seen.add(asObject);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (const item of value as unknown[]) {
        items.push(encode(item, seen) ?? "null");
      }
      return `[${items.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = encode(record[key], seen);
      if (encoded === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(asObject);
  }
}
