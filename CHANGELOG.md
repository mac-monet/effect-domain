# Changelog

## Unreleased

### Added

- **Envelope single form of `execute` / `subscribe` — the invocation surface
  is now one shape.** `domain.execute({ name, args, select }, options?)` and
  `domain.subscribe({ name, args, select })` take the same dispatch-envelope
  object as the array form and `dispatch`, with full selection-dependent
  inference. Execution policy stays in `options`
  (`{ reads?: true, concurrency? }`) — the envelope carries only client
  data, matching the dispatch philosophy. `Domain.client` mirrors both
  (`client.execute({ name, args, select })`,
  `client.subscribe({ name, args, select })`), and `Domain.Erased` gains the
  untyped envelope forms.

- **Automatic batch coalescing across fields, with key dedup.** Batched
  fields now share one request family when they share a resolve function:
  `Post.author` and `Comment.author` both passing the same `batchUsers`
  coalesce into a single batch call per walk, and each batch call receives
  distinct keys (many parents wanting the same entity become one key).
  Dataloader semantics as a runtime property — no loader objects. Inline
  closures are distinct functions and batch separately, as before.

### Fixed

- **Concurrent executions could leak one run's services into another's
  batch.** Effect coalesces requests globally by resolver instance, and
  resolvers were created per field definition — so a node shared between
  domains, or one domain executed concurrently with different
  request-scoped layers, could merge concurrent runs into one batch that
  executed with the first run's services (one tenant's repo answering
  another tenant's keys). Batch resolvers are now selected per execution
  context: fibers sharing the same built services (one walk, or array-form
  entries under one layer application) coalesce as before; runs with
  different contexts never share a batch.

- **Array form of `execute`.** `domain.execute([{ name: "getUser", args, select },
{ name: "getStats", select }])` — each entry the same shape as a dispatch
  envelope — runs several operations as one call and returns
  a tuple typed per entry — selection-dependent result types, error and
  requirement channels the union of the listed operations'. Entries run
  concurrently (`options.concurrency`, default unbounded) and share the
  fiber's request-batching window, so batched fields coalesce across entries;
  the batch fails fast on the first failing entry. `client.execute` mirrors
  the overload: each entry dispatches through the transport concurrently and
  decodes with its own `(name, select)` codec — no transport or wire-format
  changes. Entries carry only `args`/`select`; subscriptions are excluded.

- **Array forms of `dispatch` and `handleDispatch`.** `domain.dispatch([env1,
env2])` returns the per-envelope `Result`s in entry order — one entry's
  failure sits in its own `Result` while siblings succeed (no fail-fast).
  `domain.handleDispatch([env1, env2])` returns the encoded dispatch-Result
  envelopes in entry order, with failures encoded inside their own envelope
  and the error channel unchanged. Entries run concurrently (unbounded) in
  one fiber tree, sharing the request-batching window; the options parameter
  is the same per-envelope `DispatchOptions`/`WireDispatchOptions`, applied
  to every entry. An empty array succeeds with `[]`.

### Breaking

- **Name-first `execute` / `subscribe` calls removed.**
  `execute("getUser", { args, select })` and its `subscribe` / client /
  `Erased` mirrors are gone; the envelope form
  `execute({ name: "getUser", args, select }, options?)` is the only
  invocation shape. `reads: true` and walker `concurrency` move to the
  options argument: `execute({ name, args, select }, { reads: true })`.

- **Omitted `select` on node roots is now an error.** Previously an omitted
  selection on an object- or array-of-nodes root executed as the empty
  projection and returned `{}`. Dispatch boundaries now reject it with
  `SelectionParseError`, and the in-process walker treats it as a defect.
  Selections are always explicit: there is no implicit full selection, so a
  response can never grow or leak fields a consumer did not ask for. Scalar
  roots are unchanged — they take no selection and return the value directly.

## 0.4.0

The client becomes swappable end to end: one typed surface, three ways to
fill it — HTTP, any custom transport, or no wire at all.

### Added

- **`Domain.client(domain)` — the in-process client.** The one-argument form
  glues the transport to `handleDispatch` / `handleSubscription` on the same
  instance: every call still round-trips the wire codec (encode → decode in
  memory) and is typed identically to the remote client, so a server entry
  (SSR, tests, background jobs) runs the exact calls the browser runs. Its
  error channel carries the domain's `ProvidedE`; its `R` the domain's
  unprovided services.
- **`Domain.transportHttp(url, options?)`** — the canonical HTTP transport:
  POST each dispatch envelope as JSON to one endpoint. Backed by effect's
  `HttpClient`, self-provided from `FetchHttpClient.layer` by default
  (browser, Bun, Node 18+, edge runtimes); pass `httpClient` to supply your
  own layer for middleware or tests, `headers` for static headers.
  Subscriptions are not supported by this transport and fail with a clear
  error.
- **`Domain.TransportError`** — the wire itself failed (network error,
  non-JSON body, non-2xx status; `status` is set when a response arrived).
  Domain and gateway errors never surface here — they travel inside the
  envelope as their own types.
- **`Domain.Client<D, TE?, R?>`** — the client type for a domain instance;
  what an app-level `Context` tag holds so entries can swap client layers
  (in-process vs wire) without touching call sites.
- **`WireClient` gained an `R` type parameter** (default `never`; existing
  code unaffected) so the in-process client's service requirements are
  visible in its effect types.

### Changed

- `src/domain/wire-client.ts` is now `src/domain/client.ts`; transports live
  in `src/domain/transport.ts`. Public API paths are unchanged (everything
  is re-exported through `Domain`).
- The foldkit examples now put the client behind an `AppClient` service tag
  (filled via foldkit's `resources` Layer in the browser, the in-process
  client on the server) and build the wire with `Domain.transportHttp`. The
  `foldkit-ssr-app` example is back: server-rendered and hydrated, with the
  hydration payload as a domain projection and both entries filling the same
  client seam.

## 0.3.0

### Breaking

- `Domain.wireClient` is now `Domain.client`. Rename only — same signature,
  same transport contract. The old name read as a verb phrase ("wire a
  client"); the `transport` argument already says it crosses a wire.

## 0.2.0

Fundamental representation change: **projections are plain data**.

### Breaking

- **Per-field `Result` wrapping is gone.** `execute`/`subscribe`/`dispatch`
  successes and the wire success payload are the plain selected tree
  (`{ id: "1", fullName: "Ada" }`), JSON-native. `responseSchema` /
  `dispatchResultSchema` describe the plain shapes. The operation-level
  dispatch envelope (`Result` with `GatewayError | OperationError`) is
  unchanged.
- **Strict failure semantics.** A computed/batched field's typed failure now
  fails the whole operation: in-process it surfaces in the Effect error
  channel as the raw field error; over the wire as `OperationError` with that
  cause. Field defects still die. There is no partially-failed data tree.
- **Nullish is `null`.** Nullable roots and nullish sub-selected values are
  plain `null` (previously `Option.none()` / `{"_tag":"None"}` on the wire).
- **Selection `args` on a field that accepts none** is now a defect
  in-process (the wire boundary already rejects it as `SelectionParseError`).
- **Type family replaced.** `Domain.ResultOf` / `RootResultOf` /
  `NarrowBySelection` / `ResultTree` are removed; use `Domain.SelectedOf` /
  `Domain.RootSelectedOf` (plain narrowed trees). `annotatePaths` and its
  `Path`/`PathEntry` types are removed — there is no per-field error array to
  annotate.
- **`execute`'s error and requirement channels are now complete.** `E`
  includes every reachable computed field's declared failures (`OperationE`),
  and `R` includes field requirements (`OperationR`) — previously field `R`
  was silently dropped, so a domain could typecheck as fully provided yet die
  at runtime.

### Added

- `field({ error })` — declared error schema for fallible fields, the mirror
  of `operation({ error })`. Wire handlers union every reachable field error
  schema into the operation's failure codec; `Domain.MissingErrorSchemas`
  (and therefore `wireClient`/`handleDispatch`) rejects fallible fields
  without one at compile time.
- `reachableFieldErrorSchemas(registry, rootAst)` — the field error schemas
  the wire handlers union into an operation's failure codec, exported for
  adapters composing their own failure codecs (`errorSchema(name)` alone
  returns only the operation-declared schema). The `NodeMeta` phantom
  carrying field defs to the type level (`NodeE`/`NodeR`) is internal
  mechanism, not public API.

### Migration notes

- Delete client-side unwrapping of `{_tag:"Success"}` field wrappers — the
  data is already plain.
- Consumers fingerprinting results by `JSON.stringify` (e.g. the
  live-queries example's change detection) will emit one spurious change
  event per query on upgrade, since the serialized shape changed. Durable
  stores of encoded responses (sync-engine events) do not decode across this
  boundary.
