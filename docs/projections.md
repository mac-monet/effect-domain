# One domain, many projections

effect-domain started as an answer to a narrow question — what would GraphQL
look like if it were built _inside_ Effect instead of beside it — and ended up
somewhere more general: a way to model an entire application once, and derive
every surface of it as a projection.

## The premise

GraphQL's core insight was right: clients should declare the shape of the data
they need, and the server should own a typed graph that can answer any such
declaration. What made GraphQL heavy was everything around that insight — a
separate schema language, codegen pipelines to recover types the server already
knew, resolvers as an untyped calling convention, and a parallel universe of
tooling (clients, caches, federation) to compensate.

effect-domain keeps the insight and deletes the apparatus. The graph is built
from plain Effect values — `node()`, `operation()`, `field()` — so there is no
schema language to parse, no codegen to run, and no gap between declared types
and runtime behavior. Field resolvers are Effects; their dependencies are
tracked in the type system; their errors are declared, typed, and travel to
callers as class instances. A _selection_ — the client's statement of what it
wants — is a plain object literal, checked against the graph at compile time.

Because the whole thing is ordinary Effect, the usual Effect economics apply:
services and layers for dependency injection, schemas as first-class runtime
values, structured concurrency in resolution, and errors as data. The type
system does the work GraphQL outsources to build tooling.

## What "projection" means here

A domain value can be projected onto surfaces without restating anything:

- **In-process API** — `domain.execute(name, { args, select })` runs an
  operation directly and returns exactly the selected tree, fully typed. The
  array form — `execute([{ name, args, select }, ...])` — runs several
  operations as one call, tuple-typed per entry, with batched fields
  coalescing across entries. This is the whole backend-internal calling
  convention; workers, CLIs, and tests use nothing else.
- **Wire protocol** — `domain.handleDispatch` is a complete server boundary in
  one function: it validates a request envelope, executes, and encodes the
  result — declared errors inside the envelope, so the handler's error channel
  is `never`. Any transport that can move JSON can host it: HTTP, WebSocket,
  an MCP tool, a message queue.
- **Typed client** — `Domain.client(domain, transport)` recovers the full
  `execute` typing on the other side of any transport: operation names, arg
  types, selection-dependent result types, and declared errors decoded back
  into class instances. No generated client, no shared DTO package — the
  domain value itself is the contract.
- **Schemas on demand** — `domain.responseSchema(name, selection)` returns the
  runtime Schema for the exact response a selection produces — the same cached
  codec object the client decodes with. Selections are your DTO schemas. Any
  consumer that needs a schema value rather than just a type (UI state
  containers, persistence, fixtures, hydration payloads) derives it from the
  selection it already wrote.

The claim behind the design: everything outside the graph is delivery
mechanics, and delivery mechanics should be derivable.

## The frontend is a projection too

The [Foldkit examples](../examples) test that claim from both ends of the
delivery spectrum, using one shared [domain](../examples/domain.ts):

[`foldkit-app`](../examples/foldkit-app) is a client-side Foldkit SPA. Each
screen writes one selection; from that single value flow the fetch
(`client.execute` over a one-endpoint `/rpc` gateway), the result types, and —
via `responseSchema` — the runtime Schemas Foldkit's Model and Messages are
built from. A declared operation error (`UserNotFound`) surfaces inside a
browser `update` function as a typed class instance. There is no hand-written
API layer: the server is ~40 lines around `handleDispatch`, the client's data
layer is selections plus derived Effects.

[`foldkit-server-app`](../examples/foldkit-server-app) is the same application
fully server-generated: no client runtime, no `/rpc`, no JavaScript shipped at
all. Routes render through Foldkit's server renderer
([foldkit#863](https://github.com/foldkit/foldkit/pull/863)); the create form
is a native HTML POST answered with a redirect. With the wire gone, the data
layer collapses to its minimum — the selections and in-process `execute` —
and the page you receive is literally the projection, serialized as HTML
instead of JSON. The server entry is `Request → Response` with no runtime
APIs in it; it would sit unchanged behind a Cloudflare Worker's fetch handler
— an entire application, domain included, served from a single worker.

Moving between these two architectures — and the hybrid in the middle
(server-rendered first paint, hydrated SPA afterward, where `responseSchema`
becomes the hydration codec) — touches _none_ of the data layer. Same graph,
same selections, same schemas; only the delivery schedule changes. That is the
property the project was after: the API surface, the wire, and now the
frontend's state are all projections of one declared domain.

## Why Effect makes this cheap

None of the individual ideas are new — typed RPC, schema derivation, and
isomorphic rendering all exist elsewhere. What Effect changes is the cost of
composing them: schemas are values, so a projection's codec can be derived
and cached rather than generated; errors are typed values, so "declared
errors travel the wire as class instances" is a codec concern, not a
convention; services are tracked in types, so `execute` knows exactly what a
given operation needs and a server entry can provide it once. The result is
that the entire mechanism — graph, execution, dispatch boundary, wire client,
response schemas — is a small library with no build step, rather than an
ecosystem.
