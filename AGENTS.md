# Working in this repository

minflow compiles a declarative workflow graph into a plugin for a coding agent.
Read [`SPEC.md`](./SPEC.md) before changing behaviour;
[`docs/DECISIONS.md`](./docs/DECISIONS.md) says why the design is shaped this way,
and [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) records which platform claims
were established by running them.

## Layering

```
src/ir.ts          the intermediate representation: types and nothing else
src/hash.ts        canonical serialization and the graph hash
src/evaluate.ts    the transition evaluator, pure
src/builder.ts     the authoring surface, plus lintGraph
src/mermaid.ts     the graph as a diagram, pure
src/skills.ts      skill validation: a pure check plus a thin filesystem shell
src/emit/          one directory per backend
src/index.ts       the public surface
```

Dependencies point one way: `ir` knows about nothing, `evaluate` and `builder`
know about `ir`, and a backend knows about all of them. A backend must never be
imported by anything above it.

## Invariants

Break one of these and the design stops working, so change them deliberately or
not at all.

- **The IR is internal.** Types may be exported for annotation, but the builder
  is the authoring surface and the IR carries no compatibility promise (D6).
- **Guards are data, never closures.** A compiled graph ships as a file and is
  read back by a separate process, so anything that cannot survive a JSON round
  trip cannot be in the IR.
- **The evaluator is pure and knows nothing about delivery.** It takes resolved
  observations and returns a transition. No filesystem, no shell, no model, no
  clock, no randomness, no mutation of its arguments. This is what lets the whole
  transition table be tested with no model in the loop.
- **A violated contract is an error, never a false guard.** An unreadable file or
  an unparseable payload must not route down an `otherwise` branch wearing the
  same clothes as a test that legitimately failed.
- **Emitters are pure functions returning a path to contents map.** I/O lives in
  one trivial function per backend.
- **Zero idle footprint.** An emitted plugin must not run anything when no
  workflow is running. Every hook registration is matcher-scoped (D9).

## The evaluator exists twice

A shipped plugin has no `node_modules` to resolve `minflow` from, so the Claude
Code backend vendors `observationsFor` and `evaluate` into the plugin as a
CommonJS copy. That copy is a string literal, `RUNTIME_SOURCE`, inside
`src/emit/claude-code.ts`.

**A semantic change to `src/evaluate.ts` needs the matching edit in
`RUNTIME_SOURCE`.** A differential test runs both implementations over many
graphs, nodes and resolution modes and requires identical output, so divergence
fails the suite rather than shipping. Fix both sides in one change.

Two mechanical traps in that file. `RUNTIME_SOURCE` and the dispatcher body are
`String.raw` templates, so **no backtick and no dollar-brace may appear anywhere
inside them, comments included**: one backtick ends the template and the file
stops compiling. And the emitted dispatcher is CommonJS with no bundler, so it
can require only what ships beside it.

## Commands

```bash
npm run check   # biome, tsc --noEmit, vitest
npm run build   # tsc to dist/
```

`npm run check` must be green before a commit.

## Conventions

- NodeNext ESM: relative imports carry a `.js` extension.
- `verbatimModuleSyntax`: type-only imports use `import type`.
- `exactOptionalPropertyTypes`: never assign `undefined` to an optional property,
  build the object conditionally instead.
- `noUncheckedIndexedAccess`: indexed access is `T | undefined`, so narrow it.
- No `any`, no non-null assertions.
- Biome formats: 2-space indent, double quotes, semicolons, trailing commas,
  100 columns.
- **Never use an em-dash, a double hyphen, or a hyphen as punctuation between
  clauses**, in prose, comments, or commit messages. Use a comma, a colon, or a
  second sentence. Hyphens inside compound words are fine.

## Tests

A test that cannot fail is worse than no test, because it reports coverage that
does not exist. When adding one, break the line it defends and confirm it fails,
then restore. Assert on error messages rather than only that something threw.

Tests must not need a model or a network. The evaluator and builder are testable
directly; a backend is testable by asserting on the strings it emits, and the
emitted dispatcher can be driven by writing it to a temp directory and firing
hook payloads at it over stdin.

## Claims about the platform

Anything asserted about how Claude Code behaves must be established by running it,
not by reading the documentation and not by reasoning from a related behaviour.
Several claims in this design were confirmed wrong that way: matcher semantics
differ per hook event, and a `block` decision means opposite things on two
events. When a claim is established, record it in `docs/VERIFICATION.md` with the
version it was measured against, because these behaviours change across patch
releases.

`spike/` holds a local harness for those measurements. It is gitignored on
purpose and is not part of the package.

## Documentation

Documents state what is true and why. They do not narrate their own production:
no records of reviews or sweeps, no "an earlier revision said", no dated notes
about what changed. Version control holds that already. The same applies to code
comments, which explain the constraint a reader is facing, not the history of the
file they are in.
