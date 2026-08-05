# effect-domain

A computation graph library for Effect. Schemas define data. Annotations graft computations onto them. The engine walks the graph on demand. Transports, sync engines, workflow orchestrators, and protocol adapters are consumers of this primitive — they live above the graph, not inside it.

Depends only on `effect` (as a peer dependency). No runtime-specific APIs — the library runs on Node, browsers, and edge runtimes; invocation-key hashing uses a local SHA-256 implementation rather than `node:crypto`.

## Quality Standards

This library aims to be a reference-quality Effect library — immaculate code quality, excellent developer experience, and idiomatic Effect patterns throughout. These principles guide all development:

**Immaculate code quality.** Every line should be intentional. No dead code, no half-finished abstractions, no "good enough for now" shortcuts. The library is small enough that every corner can be polished. When in doubt, simplify.

**Idiomatic Effect patterns.** Follow Effect's conventions for API design: interface + namespace declaration merging (`Domain.make`, `Domain.SelectedOf`), `Option` over `null`, `Result` over try/catch, `Schema` over runtime checks, `never` for erased type channels, `NoInfer` to control inference direction. When there's a choice between a JavaScript idiom and an Effect equivalent, choose Effect.

**Developer experience as a feature.** The public API should require zero type assertions from consumers. Type inference should work naturally — selections constrain to valid fields, results reflect exactly what was selected, errors compose with Effect's error channel. If a consumer needs `as any` to use this library, that's a bug.

**Minimal, documented type escape hatches.** Avoid `any`, `as`, `@ts-expect-error`, and `@ts-ignore`. Where TypeScript fundamentally cannot express a constraint (Schema invariance, generic instantiation, erased implementations), use the narrowest possible cast at the boundary, isolated in a helper function when practical. Each cast should follow a recognized TypeScript/Effect pattern. See the "Strong typing" design decision for the complete cast inventory and rationale.

**No premature abstraction.** Don't build infrastructure for hypothetical future requirements. The library is a graph walker with typed selections — keep it focused. Adapters, middleware, and lifecycle hooks are Effect patterns, not library features.

## What It Is

Effect Schema describes data models — structs, arrays, unions, scalars. This library adds one thing: **computed fields**. A computed field is an Effect attached to a Schema that derives a value from its parent.

```ts
import { Domain, node, field, operation, subscription } from "effect-domain";

const User = node(
  "User",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
  }),
  {
    fullName: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
    posts: field({
      type: Schema.Array(Post),
      key: (parent) => parent.id,
      resolve: (ids) => PostRepo.findByAuthors(ids),
    }),
  },
);
```

`node()` also accepts a factory callback that pre-types the parent, avoiding manual annotation:

```ts
const User = node("User", Schema.Struct({...}), (f) => ({
  fullName: f.field({ type: Schema.String, resolve: ({ parent }) => ... }),
}))
```

`User` is still an Effect Schema. But it now has a computation graph attached — some fields are data, some are computations, and computations can return types that have their own computations. The graph can be cyclic in definition (User -> Post -> User) but is always finite in traversal (bounded by the caller's selection).

Operations are entry points into the domain. `operation()` returns a single value, `subscription()` returns a stream. The graph itself is a flat map — no query/mutation/subscription categories.

```ts
const ops = {
  getUser:       operation({ type: User, args: { id: Schema.String }, resolve: ... }),
  createUser:    operation({ type: User, args: { input: CreateUserInput }, resolve: ... }),
  onUserCreated: subscription({ type: User, resolve: () => UserEvents.stream }),
}

const domain = Domain.make(ops)
```

The engine traverses this graph given an operation name, optional args, and a selection when the operation root is projectable:

```ts
// Single-value operations
domain.execute("getUser", {
  args: { id: "123" },
  select: { id: true, fullName: true, posts: { select: { title: true } } },
  concurrency: "unbounded",
});

// Stream operations
domain.subscribe("onUserCreated", {
  select: { id: true, fullName: true },
});

// Array roots apply the root selection to each element
domain.execute("listUsers", {
  select: { id: true, fullName: true },
});

// Opaque scalar roots take no selection
domain.execute("countUsers", {});
```

Unselected computed fields are not executed. Plain data fields are property access. Fields defined with `key` are automatically batched via `Effect.request` — the walker's concurrent execution and Effect's tick-based batching coalesce same-resolver requests at each depth level.

## Why A Domain?

The graph is a primitive several different systems can build on. Each one needs the same underlying capability — _describe an operation, validate inputs, dispatch by name, walk the result on demand_ — and traditionally each one reinvents that loop:

- **Protocol adapters** (HTTP, RPC, GraphQL): parse a request → validate → dispatch → serialize a response.
- **Sync engines**: persist a subscription as data, replay it after reconnect, diff selections to compute incremental updates.
- **Workflow orchestrators**: each step is an operation invocation; persist `{ name, args, select }` records, replay after crash, sequence dependent steps.
- **Direct in-process callers**: the simplest case — typed `execute()` calls with full type inference.

What unifies these is the **operation-as-named-invocation** model. effect-domain aims to be the smallest primitive that supports all of them: a definition language for operations + nodes, a walker that executes selections, and an introspectable boundary that lets untyped consumers validate and dispatch without re-implementing the loop.

What each consumer adds on top is its own concern — change detection for sync, dependency tracking for workflows, transport encoding for HTTP/RPC. Those don't belong in the domain.

## What The Engine Does

The engine is a graph walker:

1. Look up an operation by name
2. Decode args via Schema at untyped gateway boundaries
3. Run the operation's resolver
4. Walk the result, resolving selected computed fields recursively
5. Return the plain projected tree (or fail with the first field failure)

Step 4 is the core — a recursive traversal that reads plain fields via property access, calls computed field resolvers as Effects, iterates lists (Schema AST tells it what's a list), discriminates unions via sentinel extraction from the AST, with field resolutions running concurrently; a field's typed failure fails the operation, a defect dies.

## What The Engine Does NOT Do

The engine has no knowledge of any protocol or consumer system. These are consumer concerns:

- **Protocol-specific shape:** null bubbling (GraphQL), fragment spreading, `@skip`/`@include`, `DocumentNode` traversal
- **Wire format serialization:** GraphQL JSON, RPC binary, REST, msgpack, etc.
- **Transport:** HTTP, WebSocket, SSE, queues
- **Sync semantics:** change detection, observed-read tracking, write fanout, conflict resolution
- **Workflow semantics:** step dependency graphs, durable persistence, replay sequencing, retries
- **Middleware, auth, lifecycle hooks** — these are just Effect patterns (`Effect.tap`, services via Layer, `Effect.acquireRelease`). The library doesn't wrap them.

The gateway contract (`dispatch`, `dispatchSubscription`, and the three schemas) is the maximum the graph offers consumers — a validated dispatch primitive. Everything stateful or protocol-shaped sits above it.

## File Structure

```
src/
├── define.ts            # node, field, operation, subscription, identity + field annotations
├── registry.ts          # node registry: single reification pass at Domain.make
├── walk.ts              # recursive selection execution (the walker) + read-set collection
├── inspect.ts           # structured introspection, projected from the registry
├── invocation-key.ts    # canonical invocation hashing + selection equality
├── gateway.ts           # dispatch boundary: request decode, gateway errors, Result lifting
├── index.ts             # public exports
├── domain/
│   ├── index.ts         # public Domain namespace facade (Domain.make, type helpers)
│   ├── interface.ts     # public DomainInstance contract
│   ├── runtime.ts       # runtime construction: execute, bind, dispatch, caches, layers
│   ├── topology.ts      # effect/Graph topology view + Mermaid/GraphViz export
│   └── type-level.ts    # result-tree, selection, and bind type machinery
├── selection/
│   ├── index.ts         # selection re-exports
│   ├── syntax.ts        # selection entry syntax + normalization
│   ├── projection.ts    # cached RootPlan classification + field projectability policy
│   ├── plan.ts          # selected-field lookup + runtime field planning
│   ├── analyze.ts       # selection analysis (depth / field counts)
│   └── schema.ts        # runtime selection codec derivation
├── response/
│   └── codec.ts         # response codec derivation
└── schema/
    ├── ast.ts           # shared Schema AST helpers (incl. canonicalizing unwrapType)
    ├── sentinels.ts     # union-member sentinel extraction + candidate index
    ├── codec.ts         # isolated unsafe codec-widening helpers
    └── result.ts        # Result codec construction
```

## The Node Registry

`Domain.make` traverses the Schema AST exactly once, reifying the domain model into a **node registry**: every `node()` reachable from the operation return types, with its identifier, entity identity, data fields, field defs, encoded-side sentinels, and reference edges to other nodes. Every other subsystem — selection plans, selection schemas, response codecs, inspection, topology — consults the registry (`lookup`, `fieldDefsFor`, `rootPlanFor`) instead of re-walking raw AST, degrading gracefully to raw-AST handling for anonymous or synthesized shapes. The registry is built once per `Domain.make` and shared across `provide()` derivatives.

Three consumer-facing capabilities are built on it:

**Introspection — `domain.inspect()`.** A plain-data snapshot of operations and nodes, projected directly from the registry. Only operation _return_ types seed node discovery; operation args do not appear as nodes.

**Topology — `domain.topology()`.** The domain model as a core `effect/Graph` value: `DirectedGraph<NodeInfo, FieldEdge>`, one node per registered `node()`, one edge per field reference (with `viaArray`/`viaUnion`/`optional` wrapper flags). Because it is a standard `effect/Graph`, consumers get traversal algorithms (`dfs`, `topo`, `isAcyclic`), structural equality, and `toMermaid()`/`toGraphViz()` diagram export without this library providing any of them. This is the interchange surface for adapters — the same move `selectionSchema` makes for the Schema ecosystem, applied to structure.

**Entity identity.** `node()` accepts an `identity` option — a data field name or a `(value) => string` function — declaring the node's canonical entity key:

```ts
const User = node("User", UserSchema, fields, { identity: "id" });
const Feed = node("Feed", FeedSchema, {}, { identity: (feed) => `feed:${feed.id}` });
```

Identity is the keyspace primitive for everything entity-addressed: read sets, caches, sync-engine invalidation. The field form is strict — a nullish or non-primitive key value is a defect, because silently colliding keys (`"undefined"`) poison idempotency stores.

### Read Sets

`execute(name, { ..., reads: true })` returns an `Execution` envelope `{ result, reads }` where `reads` is the deduplicated list of `(node, key)` pairs of every identified entity the walk touched. The same flag exists on `DispatchOptions` for `dispatch` and `prepared.execute`. Collection is opt-in via an optional collector on `WalkContext`; the plain paths pay one undefined-check per node.

Read sets answer "which entities did this request depend on" exactly — only entities the selection actually walked are recorded. Uses: sync-engine invalidation (a live query's read set is its dependency set), cache tagging (surrogate keys), access auditing, and mutation write-sets (a mutation run with `reads: true` reports the entities in its response — mutations should return what they changed). `examples/live-queries.ts` shows the full invalidation loop.

Streams (`subscribe`/`dispatchSubscription`) deliberately do not accept the flag yet — per-item vs. cumulative semantics is an open question (see Open Questions).

## Design Decisions

**Effect-native over JavaScript idioms.** Favor Effect's type-safe primitives over raw JavaScript patterns. Use `Option` instead of `null`/`undefined` for absence, `Result` instead of try/catch for partial success, `Effect.all` instead of `Promise.all`, `Schema` instead of runtime type checks. When there's a choice between a JavaScript convention and an Effect equivalent, choose Effect — it composes better and makes the type-level guarantees real.

**Strong typing with minimal, documented casts.** The library minimizes `any` and `as` type assertions. The public API is zero-cast — consumers never need `as`, `any`, or `@ts-expect-error`. Internal casts exist only at type boundaries where TypeScript fundamentally cannot express the constraint, and each one follows a recognized pattern:

- **`never` for erased type channels.** When a type parameter is not preserved in a stored type, erase it to `never` in the stored type's function signatures. For example, `ComputedFieldDef.resolve` uses `args: never` because the `Args` type from `FieldConfig` is not carried through to the stored definition. Since `never` extends all types, a function taking `args: Args` is assignable to one taking `args: never` via contravariance — no cast needed. This mirrors how Effect uses `never` for unused error and requirement channels. One `as never` exists at the call site where a value passes through an erased channel.

- **`as unknown as T` for Schema invariance widening.** `node()` annotates a struct and widens its type to include computed fields. Schema is invariant (encodes + decodes), so TypeScript cannot verify the widening. One explicit `as unknown as Schema.Schema<NodeType<...>>` cast in `node()` handles this. The return type annotation is still checked at every call site.

- **`as DomainInstance<Ops>` for erased implementation → typed interface.** The internal implementation uses broad types (`string` keys, `Selection`); the public interface provides `K extends keyof Ops` and `SelectionFor<T>`. This is the standard Effect pattern for typed interface construction.

- **`as FieldFactory<Parent>` for generic → specific binding.** A generic function placed behind an interface that fixes a type parameter. TypeScript cannot instantiate generics without a cast.

- **R erasure in `makeBatchedField`.** The batched field's resolve function has `R = unknown` in the erased implementation; the `RequestResolver` requires `R = never`. One cast narrows R at the resolver creation boundary.

- **`Schema.Decoder` for service-free decode boundaries.** `Schema.Schema<T>` erases `DecodingServices` to `unknown` (via `Top`), which poisons any `Effect.flatMap` chain with `R = unknown`. Use `Schema.Decoder<T>` instead — it defaults `DecodingServices` to `never`, keeping R clean through `decodeUnknownEffect`. Store args schemas as `Decoder<unknown>`, not `Schema<unknown>`.

- **Return type annotations over `as` assertions.** Where TypeScript inference fails through complex generic chains, annotate callback return types rather than casting the result. The compiler checks annotations; it trusts assertions.

- **No `@ts-expect-error` or `@ts-ignore`.** These suppress all errors on a line, masking unrelated bugs. Use explicit `as` casts that scope the type escape to exactly the expression that needs it.

- **`Record<string, any>` only in conditional type positions.** `[T] extends [Record<string, any>]` is the standard TypeScript idiom for structural object matching. `Record<string, unknown>` is too restrictive in this position. `any` here is a type-level pattern, not a value-level escape.

**Stream-first internals.** Internally, all operations are normalized to streams. `operation()` wraps the resolver's Effect in `Stream.fromEffect`; `subscription()` stores the Stream as-is. The walker always does `Stream.mapEffect(stream, item => walk(...))`. Then `execute()` is a thin `Stream.runHead` wrapper and `subscribe()` passes through. This gives `Domain.make` a single code path. The stream normalization only applies at the operation root — field resolvers remain Effects, walked with `Effect.all`.

**AST-first walker.** The walker operates on `SchemaAST.AST`, not `Schema.Schema`. Schemas are unwrapped to AST at the boundary. This is more natural for the structural inspection the walker performs (checking for arrays, unions, object fields).

**`node()` is a finalizer.** Schema composition (extend, pick, field spreading) creates new AST nodes and drops annotations. Call `node()` last, after all composition is done. This is by design — a graph node is a finalized definition with its own computed fields, not a base for further structural extension.

**Sentinel-based union discrimination.** Rather than hardcoding `_tag`, the walker extracts the discriminator key from the union AST by finding the common sentinel across all members. Results are cached per union AST node. This correctly handles unions discriminated by any key. The sentinel extraction and candidate matching live in `src/schema/sentinels.ts` — a faithful port of Effect's own union-candidate index, owned locally because upstream made that machinery `@internal` in 4.0.0-beta.97. The library depends only on public `effect` APIs.

**Absence is `null`.** `walkNode` expects a non-null value — its contract is "traverse this object and resolve its fields." Null checks happen at the boundary in `resolveValue`, which short-circuits to `null` before recursing. This avoids fabricating result trees for fields that were never resolved — if a parent is null, the caller gets `null` for the parent key, not an object of null children. Plain `null` is JSON-native, matches GraphQL's data-tree representation, and keeps the wire payload free of wrapper objects; a projection is data, not a value-level API.

**No path tracking in the walker.** The walker doesn't track traversal paths — `WalkContext` carries only `concurrency`, the registry, and an optional read-set collector. Under strict failure semantics a walk produces either the whole plain tree or one failure, so there is no per-field error array to annotate with paths; paths remain inferable from the nested structure for consumers that need them.

**Output aliasing via `alias`; multi-alias via array form.** Selection keys are strict — they must name an actual field on the parent AST. To rename the output key, set `alias`: `{ greeting: { alias: "hi" } }` produces `{ hi: ... }` in the result tree. To select the same field multiple times (e.g., once with each role), use the array form: `{ users: [{ args: { role: "user" } }, { args: { role: "admin" }, alias: "admins" }] }`. The walker dispatches each entry independently and writes each to its own output key. Multi-alias is rejected at decode-time when array entries would collide on output (more than one missing `alias`, or duplicate `alias` values).

**Resolver selection lookahead.** Both field and operation resolvers receive `selections: ReadonlySet<string>` — the immediate child field names the caller selected. This enables data-fetch optimization in resolvers (e.g., skip a JOIN if a relation wasn't requested). The walker already avoids resolving unselected computed fields, so this is purely for optimizing the resolver's own data fetching. Cheap to provide — already computed from the selection tree.

**Automatic batching via `key`.** `field()` has two modes, discriminated by the presence of `key`:

```ts
// Pure computation — resolve takes parent context
field({ type: Schema.String, resolve: ({ parent }) => Effect.succeed(...) })

// Data fetch — key extracts a batch key, resolve takes an array of keys
field({ type: Schema.Array(Post), key: (p) => p.id, resolve: (ids) => PostRepo.findByAuthors(ids) })
```

When `key` is present, the library wraps the resolver in `Effect.request` + `RequestResolver` so the walker automatically batches concurrent fetches at each depth level — 50 Users needing Posts becomes 1 batched query, not 50. The `resolve` function receives the requested keys and returns a `ReadonlyMap<K, Type>`. A resolver failure fails the whole batch; a missing key becomes an individual field failure. Batching is effect-only; stream fields don't batch (different primitive).

Implementation notes: `type` in batched fields is the returned field schema. Use `Schema.Array(Post)` for a field that returns many posts. Internally, batched and computed fields are two distinct types (`ComputedFieldDef` / `BatchedFieldDef`) with a `_kind` discriminator for clean narrowing in the walker. The `node()` factory callback (`f.field()`) is the recommended API — it pre-binds the parent type so TypeScript inference works for both modes without explicit type annotations.

**No query planner.** The walker's recursive structure plus `Effect.all({ concurrency: "unbounded" })` creates natural depth phases. Effect's tick-based request batching coalesces all same-resolver requests within each phase into one batch call. This gives plan-and-execute behavior without planning infrastructure.

**No declared error schemas.** Error types are inferred from resolver return types rather than declared separately via an `errors` field. Declared error schemas may come back when adapters need to generate protocol-level error type information.

**No resolver output validation.** The library does not decode resolver output against the schema at runtime. Resolvers are trusted internal code — TypeScript catches type mismatches at compile time. This matches Effect's convention of validating at system boundaries only.

**Operation names inferred from record keys.** `Domain.make({ getUser: operation({ type: User, ... }) })` — the operation name is the record key, not a field on the config. Eliminates duplication and typo bugs.

**Domain invariant violations are defects.** `execute()`'s error channel is exactly the operation's `E` (plus anything a provided layer can fail with) — the walker never adds untyped `Error`s to it. Contract violations — a resolver returning a shape that contradicts its declared type (nullish for non-nullable, non-array for array roots), an empty stream from a single-value operation (`execute()` uses `Stream.runHead`; a well-behaved operation emits exactly one item), or a selection forced onto an opaque root past the type system — are `Effect.die` defects. Each is either a resolver bug or unreachable through the typed API, which is the definition of a defect in Effect's convention. `dispatch` is unaffected: its boundary errors are typed `GatewayError`s, and defects still die through it.

**Introspection via `domain.inspect()`.** Returns a structured description of the graph's operations and nodes — names, types, args, computed fields, whether an operation is a stream. This is a read-only traversal of Schema AST and annotations. Useful for adapter schema generation (GraphQL types, OpenAPI specs), documentation, dev tools, and validation.

**Concurrency defaults to `"unbounded"`.** Effect fibers are lightweight and the batching via `Effect.request` coalesces them at the scheduler tick. Callers who need to limit concurrency pass `concurrency: N` per call. No graph-level default — the right concurrency depends on the call site, not the graph definition.

**No input types or custom scalars.** These are GraphQL concepts. In Effect Schema, any schema can decode input. Custom scalars are just `SchemaTransformation`. The GraphQL adapter handles input/output type classification at its layer.

**Single reification pass; caches stay pure.** All Schema AST traversal happens once, in `buildRegistry` at `Domain.make` time. Suspend/sentinel/union hazards are concentrated there and in `schema/ast.ts`. The AST-keyed memo caches (plans, selection/response codecs, root plans) remain module-global WeakMaps — they memoize _pure functions of the AST_ and are shared across graphs that reference the same node ASTs (spread-merged graphs). The invariant that keeps this sound: every registry-derived answer consumed inside a cached builder (`fieldDefsFor`, sentinels, `rootPlanFor`) must itself be a pure function of the AST.

**`unwrapType` canonicalizes (toType is not idempotent).** Effect's `SchemaAST.toType` is memoized per input but rebuilds a fresh AST when applied to its own output. Identity-keyed traversals of recursive schemas would therefore never converge. `unwrapType` maintains a canonicalizing WeakMap: raw-side suspend unwrapping consults the cache at each step, canonical ASTs map to themselves, and the one-step link `toType(canonical) → canonical` snaps rebuilt suspend wrappers back. All structural traversal must go through `unwrapType`; never re-apply `toType` to unwrapped results.

**Raw-AST discovery preserves encodings.** Registry discovery recurses along the _raw_ AST wherever its shape matches the type-side classification, because `toType` strips encodings irrecoverably and sentinels must be extracted from the encoded side (that is what runtime union matching discriminates against). The unwrapped type-side AST serves only as the canonical map key.

## Typed Selections and Plain Projections

Selections and results are fully typed. Projection output is **plain data**: the walker emits exactly the selected tree with raw values — no per-field wrappers. Root outputs are generic: object roots project to narrowed trees, array-of-object roots project each element, nullable object roots resolve to `null` when absent, and scalar/scalar-array roots are returned directly with no selection.

**`NodeType<S, Computed>`** merges a struct's data fields with computed field output types. `node()` returns a schema whose `Type` includes both, so consumers see all selectable fields — data and computed — as a single type. A symbol-keyed phantom (`NodeMeta`) additionally carries the field-def record so each field's error and requirement types survive to the type level (`NodeE` / `NodeR`).

**`SelectionFor<T>`** constrains selections to valid field names on `T`. Scalar fields accept `true`. Object and array-of-object fields accept `true | { select?: SelectionFor<Element> }`. Invalid keys are type errors.

**`RootSelectionFor<T>`** constrains operation-root selections. It differs from `SelectionFor<T>` for arrays: `RootSelectionFor<User[]>` selects `User` fields, not array properties. Scalars have `RootSelectionFor<T> = never`, so typed callers cannot pass `select`.

**`SelectedOf<T, Sel>`** picks only the fields present in `Sel` from `T`. When a field uses `{ select: Sub }`, the value type is recursively narrowed; nullish values in sub-selected positions are `null`. Unselected fields are excluded from the result type. **`RootSelectedOf<T, Sel>`** generalizes it across root shapes (arrays, nullables, opaque roots).

The result shape per field:

- **Scalar**: the raw value (`string`, `number`, `string | null`, …)
- **Object with sub-selection**: `SelectedOf<Element, Sub>` (nests recursively; `null` when the value is nullish)
- **Array with sub-selection**: `Array<SelectedOf<Element, Sub>>`
- **Array without sub-selection**: the raw array, preserved as-is

**Failure semantics are strict**: a computed field's typed failure fails the whole operation through the Effect error channel — `execute`'s `E` is the resolver's declared failures plus the `E` of every reachable computed field (`OperationE`). There is no partially-succeeded data tree; a failure means no result. Field defects die, exactly like resolver defects.

## The Gateway Contract

> **Status:** Implemented. Design rationale for each gateway primitive is inline in this section.

`execute()` and `subscribe()` are the **in-process contract**: callers hold the operation type, TypeScript ensures `select` matches `RootSelectionFor<Op["type"]>` when the root is projectable, and opaque roots do not accept `select`.

The moment a consumer crosses an untyped boundary — JSON over HTTP, a serialized RPC payload, a persisted workflow record, a subscription replayed from disk — the type-system guarantee evaporates. Each consumer ends up reimplementing the same loop: parse `{ name, args, select }` from wire → validate → dispatch → serialize the result.

The **gateway contract** surfaces runtime Schemas, dispatch methods, and a canonical invocation hash, so consumers can stop reinventing parse/validate/dispatch:

```ts
domain.argsSchema(name):                       Schema<ArgsOf<Op>>
domain.selectionSchema(name):                  Schema<RootSelectionFor<Op["type"]>>
domain.responseSchema(name, validatedSelect):  Schema<ResponseOf<Op>>
domain.invocationKey({ name, args, select }, { bytes }):  string  // canonical, normalized
```

These primitives let any consumer — HTTP, RPC, GraphQL, queue worker, sync engine, workflow orchestrator — decode untyped wire input, prepare and inspect invocations before execution, dispatch, and produce idempotency / cache keys without casts and without reinventing the loop.

A third Schema, `domain.responseSchema(name, validatedSelection)`, is opt-in for typed clients that want to validate/decode the plain projected tree from the wire as a single Schema. Most consumers don't need it: the payload is plain JSON-shaped data. Response schemas are memoized by operation AST and canonicalized selection, so adapters should build them for fixed or already-validated selections; dynamic gateways should not synthesize them for unbounded user-controlled selections without their own cache/lifecycle policy.

The dispatch methods wrap the canonical request shape and keep all expected outcomes as `Result` values:

```ts
domain.dispatch({ name, args, select }):
  Effect<Result<SelectedOf<…>, GatewayError | OperationError<E_of_op>>, never, R_of_op>

domain.prepareDispatch({ name, args, select }):
  Effect<PreparedDispatch, GatewayError, R_of_op>

domain.dispatchSubscription({ name, args, select }):
  Stream<Result<SelectedOf<…>, GatewayError | OperationError<E_of_op>>, never, R_of_op>
```

`prepareDispatch` is the production gateway path when a transport needs to validate and inspect a request before running resolvers. It decodes args/select, computes `invocationKey`, and exposes selection analysis so adapters can enforce auth, allowlists, depth/field limits, caching, rate limits, or audit policy before calling `prepared.execute(...)`. Invocation keys default to 8 bytes / 16 hex chars; pass `{ bytes: 16 }` or `{ bytes: 32 }` to `prepareDispatch` or `domain.invocationKey` for durable/global idempotency stores.

`dispatch` puts both boundary errors and operation E into the `Result` value channel — the right default for simple dynamic calls, queues, sync engines, and workflow orchestrators where E is a recordable domain outcome. Pipe through `Domain.orFail` or `Domain.orFailStream` when a transport wants operation E back in the Effect/Stream failure channel. Defects still die.

| Error                 | `dispatch` channel | after `Domain.orFail` | HTTP analogue |
| --------------------- | ------------------ | --------------------- | ------------- |
| `UnknownOperation`    | `Result.failure`   | `Result.failure`      | 4xx           |
| `ArgsParseError`      | `Result.failure`   | `Result.failure`      | 4xx           |
| `SelectionParseError` | `Result.failure`   | `Result.failure`      | 4xx           |
| `OperationError<E>`   | `Result.failure`   | `Effect` failure      | 5xx (default) |
| Defect                | `Effect.die`       | `Effect.die`          | 500           |

Consumers with non-canonical wire shapes (queues that read `select` from a header, GraphQL parsers, etc.) ignore both and compose the schemas directly. Such adapters consume the graph through `Domain.erase(graph)` — the type-erased `Domain.Erased` surface (`inspect` / `argsSchema` / `execute` / `subscribe`), which requires all services provided at compile time. Note `argsSchema` decodes the **encoded** side; an adapter whose wire carries already-parsed, type-side values (GraphQL after graphql-js coercion, RPC with its own serializer) should decode through `SchemaAST.toType(argsSchema(name).ast)` instead — refinements and brands survive, encodings drop out.

The **load-bearing piece** is `selectionSchema` — a recursive function that walks a node's AST and emits a runtime Schema mirroring `SelectionFor<T>`. Mechanics already exist in the walker: AST dispatch, `Schema.suspend` for recursion, sentinel-discriminator extraction for unions. `argsSchema` trivially exposes existing data; `invocationKey` is canonical normalization plus hashing; `responseSchema` (opt-in) walks a _validated_ selection together with the AST.

The two contracts coexist. In-process callers continue to use `execute()`/`subscribe()` with full type inference. Gateway consumers use the schemas and `dispatch` / `dispatchSubscription`. They share one walker and one definition language.

**The gateway is the invocation primitive.** Sync engines and workflow orchestrators get three things from it: a validated, replayable call (`dispatch`); a canonical identity for that call (`invocationKey`); and a vocabulary of legal calls (the schemas). Change observability, dependency tracking, and durable persistence remain separate primitives those systems layer on top. The graph stays narrow; consumers extend.

## Error Handling

The walker has no error handling logic of its own: field resolver effects run inside `Effect.all`, so a field's typed failure propagates through the Effect error channel and fails the whole operation (strict semantics — first failure wins, no partial tree). Defects die.

At the wire boundary, `liftBoundaryToResult` wraps that failure into `OperationError<E>` inside the dispatch `Result`, and the failure codec is the operation's declared `error` schema unioned with every reachable field's declared `error` schema (`field({ error })`). A fallible field without a declared schema cannot round-trip its failures; `Domain.MissingErrorSchemas` turns that omission into a compile error at wire boundaries, exactly as for operations.

Adapters therefore see exactly two outcomes per dispatch: plain data, or one typed failure with its operation context — the same model GraphQL's `data`/`errors` split and RPC error channels expect.

## Subscriptions

When an operation returns a Stream, the engine walks each emitted item. The walker itself doesn't change — it's applied per-item via `Stream.mapEffect`. The adapter converts the result stream to its protocol's streaming format.

## Integration

`execute()` returns an `Effect`, `subscribe()` returns a `Stream`, and `dispatch({ name, args, select })` accepts unknown wire-shaped input — together they cover both the typed in-process contract and the validated gateway contract. Most integrations are a few lines of glue at the routing boundary, not adapter packages.

**Effect HTTP**: iterate `domain.operations` and mount `POST /${name}` with `domain.dispatch({ name, ...body })`. No per-route factory, no `as never` casts. New operations auto-mount.

**SSE / WebSocket**: pipe `domain.subscribe()` or `domain.dispatchSubscription()` into a streaming response. Effect platform already supports this.

**Effect RPC**: auto-derive an `RpcGroup` where each call's payload schema is `{ args: domain.argsSchema(name), select: domain.selectionSchema(name) }` and the handler layer dispatches uniformly to `domain.dispatch`.

**Sync engines** (consumer extends): a subscription is a persistable `{ name, args, select }` record validated against the gateway schemas, with `invocationKey` as its stable identity (deduplication, change-detection cursor, replay key) and `dispatchSubscription` as the replay primitive. The graph does not provide change observability, dependency tracking, or write fanout — the sync engine layers those on top. The selection Schema is what makes selections representable as data rather than as a typed call-site argument, and `invocationKey` is what makes equivalent selections collapse to one subscription rather than many.

**Workflow orchestrators** (consumer extends): each step is a persisted invocation record validated against the gateway schemas, identified by `invocationKey` for idempotency and resume-after-crash deduplication. Resume = decode + `dispatch`. The graph does not provide step DAGs or durable persistence — the orchestrator owns those. The graph contributes the dispatch primitive (`dispatch`), the identity primitive (`invocationKey`), and the vocabulary of legal steps (the schemas).

**Direct callers**: `yield* domain.execute(...)` — no adapter at all, full type inference at the call site.

**Composition patterns**:

- `provide(layer)` — pre-apply a Layer to narrow `R`, making the graph self-contained. Useful for HTTP handlers and RPC service definitions that shouldn't need to know about graph dependencies. One-liner: wrap `execute`/`subscribe` with `Effect.provide`/`Stream.provide`. **Services are constructed per call** — each `execute`/`dispatch` builds the layer and runs its finalizers, which is correct for request-scoped layers and expensive for shared resources. For pools and caches, build once at the app boundary: `const ctx = yield* Layer.build(AppLayer)` inside a scope, then `domain.provide(Layer.succeedContext(ctx))` — every call reuses the same services and finalizers run when the scope closes. The prebuilt context is only valid inside that scope; don't let the provided graph escape it.
- `merge` — combine graphs via `Domain.make({ ...graphA.operations, ...graphB.operations })`. Useful for modular apps composing domain-specific subgraphs.

**GraphQL** is the exception — it has its own query language, fragment system, introspection, null bubbling, and validation. This requires a real adapter package (`effect-gql`):

```
effect-domain   -> effect (only dependency)
effect-gql     -> effect-domain + graphql
```

effect-gql handles:

1. Parse query string -> DocumentNode (graphql-js, cached)
2. Validate against a GraphQLSchema built from graph annotations (graphql-js)
3. Translate DocumentNode -> Selection tree (fragments, @skip/@include, variables)
4. Call `domain.execute(operationName, { args, select })`
5. Post-process: null bubbling on the result tree
6. Format as GraphQL JSON response
7. Handle introspection (delegate to graphql-js)

## Cross-Cutting Concerns

Middleware, auth, lifecycle hooks, tracing — these don't need library support. They're Effect patterns:

- **Auth**: a service in `R`, provided via Layer. Resolvers call it. The graph doesn't know about it.
- **Middleware**: `Effect.tap` or `pipe` wrapping a resolver.
- **Tracing**: `Effect.withSpan` or an OpenTelemetry layer. Resolver-level spans work naturally — `mode: "result"` wrapping happens after each Effect completes, so OTel captures individual resolver success/failure. Operation-level spans wrap `execute()`. The walker doesn't need tracing awareness.
- **Lifecycle hooks**: `Effect.acquireRelease`, `Effect.ensuring`.

The graph library stays focused: define schemas, attach computations, walk the domain. Everything else is Effect being Effect.

## Effect v4

Built for Effect v4 from day one — no v3 migration path, and v3 patterns do not carry over. The library depends on `effect@^4.0.0-beta.99` from npm (nothing is vendored). When an API looks unfamiliar, consult the v4 docs rather than assuming the v3 shape.

## API Summary

**Definition:**

- `node(identifier, struct, computed | factory, options?)` — define a graph node with computed fields; `options.identity` declares the canonical entity key (field name or function)
- `field({ type, resolve })` — pure computed field
- `field({ type, key, resolve })` — batched data-fetching field
- `operation({ type, args?, resolve })` — single-value operation (entry point)
- `subscription({ type, args?, resolve })` — stream operation (entry point)
- `Domain.make(ops)` — create a graph from a record of operations

**Execution (typed in-process contract):**

- `domain.execute(name, { args, select?, concurrency? })` — run an operation, returning a projected result tree for object roots, an array of projected result trees for array object roots, or the raw value for opaque scalar roots
- `domain.subscribe(name, { args, select?, concurrency? })` — run a subscription as a stream with the same root result contract per emitted item
- `domain.inspect()` — return structured description of operations and nodes (registry projection)
- `domain.topology()` — the domain model as `effect/Graph` `DirectedGraph<NodeInfo, FieldEdge>`, with `toMermaid()` / `toGraphViz()` export and identifier lookup
- `domain.execute(name, { ..., reads: true })` — same execution, returning an `Execution` envelope `{ result, reads }` with the walk's read set

**Gateway (untyped boundary contract):**

- `domain.argsSchema(name)` — runtime Schema for an operation's args (load-bearing). **Implemented.**
- `domain.selectionSchema(name)` — runtime Schema for an operation's selection (load-bearing). **Implemented.**
- `domain.invocationKey({ name, args, select }, { bytes })` — canonical hash for idempotency / cache keys / sync-engine subscription identity. Defaults to 8 bytes; use 16 or 32 bytes for durable/global identities. The "single invocation primitive" any consumer can build on.
- `Domain.decodeDispatchRequest(input)` — validate a full untrusted invocation envelope (`{ name, args?, select? }`). The envelope carries only client data; walker concurrency is server policy, passed as `options` to `dispatch`/`dispatchSubscription`/`prepared.execute`.
- `domain.prepareDispatch({ name, args, select })` — validate and analyze a dynamic invocation without running resolvers; use this for production gateway policy checks before execution.
- `domain.dispatch({ name, args, select }, options?)` — validate args/select and dispatch immediately with boundary errors and operation E in the `Result` value channel; `options.reads` wraps successes in the `{ result, reads }` envelope.
- `Domain.orFail(domain.dispatch(...))` — move `OperationError<E>` into the Effect failure channel while leaving boundary errors as `Result.failure`.
- `domain.dispatchSubscription(...)` / `Domain.orFailStream(...)` — streaming siblings for subscription operations.
- `domain.responseSchema(name, validatedSelection)` — opt-in: runtime Schema for the plain projected tree. Only needed for fixed/validated selections and typed clients wanting whole-tree validation.
- `domain.dispatchResultSchema(name, validatedSelection, operationErrorSchema)` — opt-in: runtime Schema for the full `dispatch` Result wire shape.

**Composition:**

- `provide(layer)` — pre-apply a Layer to narrow `R`
- `merge` — `Domain.make({ ...a.operations, ...b.operations })`

**Utilities:**

- `buildRegistry(ops)` — construct a `NodeRegistry` standalone (adapters that need the reified model without a `Domain` instance)

**Types (under `Domain` namespace):**

- `Domain.SelectedOf<T, S>` — plain projected tree type for a given type and selection
- `Domain.RootSelectedOf<T, S>` — operation-root projection type for generic root outputs
- `Domain.NarrowBySelection<T, Sel>` — narrow result type by selection
- `DomainInstance<Ops>` — typed graph instance
- `NodeType<S, Computed>` — merged data + computed field types
- `SelectionFor<T>` — constrain selections to valid fields
- `RootSelectionFor<T>` — constrain operation-root selections
- `Domain.Execution<A>` — the `{ result, reads }` envelope
- `NodeRegistry`, `RegisteredNode`, `NodeReference` — the reified model
- `DomainTopology`, `FieldEdge`, `ReadSet`, `ReadSetEntry`
- `OperationDef`, `Selection`, `FieldSelection`

## Open Questions

**Request-scoped caching for computed fields.** If the same User appears in multiple places in the traversal, do we recompute `fullName` each time? Loaders handle caching for data fetches, but pure computations have no deduplication. Probably fine for v1.

**Differential / incremental computation.** The current model is stateless — compute from scratch each request. Read sets now provide the dependency half of the story (which entities a computation depended on); cross-request caching with invalidation would layer a version map on top. `examples/live-queries.ts` demonstrates the shape at whole-query granularity. Field-granular incremental computation remains out of scope until a consumer forces it.

**Read sets for streams.** `subscribe`/`dispatchSubscription` do not accept `reads: true` yet. Per-item read sets (each emitted item reports its own dependencies) and cumulative read sets (the subscription's dependency set grows over time) serve different consumers; the sync engine's real consumption pattern should decide before the API is fixed.

**Early arg validation.** Field args are currently validated per-field during resolution; a failed decode fails the operation. Adapters like GraphQL already validate args at the protocol level. If a future adapter needs early validation without protocol-level support, the path is: extract the "find field definition for this selection key" logic into a shared function used by both the walker and a `validateSelection` utility. This avoids duplicating the walker's traversal logic. Wait for a real consumer before building it.

**Union variant selection.** Resolved: there is no `variants` selection syntax — the Effect-first alternative was chosen. The caller selects fields flat; the walker determines the concrete variant AST at runtime, resolves the selected fields that exist on the matched variant, and reports fields absent from it as `MissingOnVariant`. A GraphQL adapter handles `... on Type` → flat selection conversion itself, keeping inline-fragment shape out of the core selection model.

**`MissingOnVariant` wire shape — deliberately open.** The walker currently writes plain `undefined` for a selected field absent from the matched variant, which conflates "absent on this variant" with "resolved to undefined" in the projected tree. Whether that distinction needs a wire-visible marker (a tagged value, key omission, or a per-field annotation) is an adapter-shaped decision: GraphQL null-vs-omit semantics are the first real consumer with an opinion. Deferred until the first adapter forces it — deciding a wire format speculatively is how formats end up wrong and frozen.

**Gateway contract evolution.** `selectionSchema`, `argsSchema`, `dispatch`, `dispatchSubscription`, `invocationKey`, `selectionsEqual`, and `responseSchema` are implemented; the rationale behind each placement is in [The Gateway Contract](#the-gateway-contract) above. Remaining open sub-questions:

- _Stream operations_ — `dispatchSubscription` is the streaming gateway sibling. If the operation/subscription split changes later, the two gateway paths may collapse into one.
- _Package layout_ — keep schemas + dispatch in `src/`; transport-specific helpers (`toHttpRouter`, `toRpcGroup`) likewise stay in `src/` if they only depend on existing peer deps. No new packages expected.
