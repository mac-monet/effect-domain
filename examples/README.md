# Examples

These examples show one domain graph used through several interfaces.

Start with `domain.ts`. It defines the shared model:

- `Profile` and `User` nodes backed by Effect Schema
- computed fields like `fullName` and `greeting`
- batched relation-like fields via `field({ key, resolve })`
- actions like `getUser`, `listUsers`, and `createUser`
- a subscription action, `watchUsers`
- service requirements via `UserRepo`

The other files expose or consume that graph without redefining the domain model.

- `http-api.ts` — fixed HTTP routes with Effect HttpApi. Each route chooses a
  stable graph selection and derives its response schema from that selection.
- `http-dispatch.ts` — GraphQL-like dynamic HTTP gateway over plain JSON. The
  client sends runtime `args` and `select`; the server pipes the envelope
  through `domain.handleDispatch(...)`, which validates, executes, and encodes
  the response with the domain's own wire codec, so declared errors (and
  gateway errors) round-trip the same envelope the RPC adapter uses. This is
  useful when you want selectable responses over ordinary HTTP without
  GraphQL's parser, schema language, introspection, or execution semantics.
- `http-dispatch-production.ts` — a production-style dynamic gateway wrapper
  with an operation allowlist, bearer auth, JSON/body checks, selection depth
  and field-count limits, cache headers, canonical invocation caching, bounded
  graph concurrency, timeout, and redacted errors.
- `rpc-fixed.ts` — fixed Effect RPC procedures with stable request and response
  schemas.
- `rpc-dispatch.ts` — dynamic Effect RPC gateway: the whole domain behind two
  static procedures. The server forwards to `domain.handleDispatch(...)` /
  `handleSubscription(...)`; the client is `Domain.client(...)`, which
  recovers exact `domain.execute` / `domain.subscribe` typing over the wire.
  The file itself is only the RPC transport glue.
- `mcp-dispatch.ts` — MCP server via Effect's built-in `McpServer`: every
  non-stream operation becomes an MCP tool. Tool list from `inspect()`, tool
  input schemas from each operation's args AST, execution through
  `domain.handleDispatch(...)`. An optional `select` tool parameter lets
  agents narrow their read set per call.
- `http-stream.ts` — HTTP NDJSON streaming with `domain.bindSubscriptions(...)`.
- `rpc-stream.ts` — Effect RPC streaming with `domain.bindSubscriptions(...)`.
- `batching.ts` — relation-like field loading with `field({ key, resolve })`
  and Effect request batching to avoid N+1 resolver calls.
- `persistence-backed.ts` — a semantic graph over normalized persistence rows.
  Repositories hide table shape, while graph selections define the API shape.
- `sync-engine.ts` — storing dynamic graph subscription output as replayable
  sync events.
- `live-queries.ts` — read-set-driven live queries: `dispatch(..., { reads:
true })` records which entities each query touched, and `invalidate(entity)`
  re-runs exactly the dependent queries, emitting events only on change.
- `foldkit-app/` — a complete browser frontend (Foldkit, Elm-architecture)
  over the dynamic gateway. The server is one POST /rpc route through
  `domain.handleDispatch(...)`; the client is `Domain.client(...)` with a
  fetch transport, so every screen picks its own selection and declared
  errors (UserNotFound) arrive typed. `dataForRoute` maps each route to its
  dispatches — the seam a server render would reuse. Run `bun run server`
  and `bun run dev` from inside the directory.

The fixed HTTP/RPC examples use `domain.bind(...)`, `domain.argsSchema(...)`, and
`domain.responseSchema(...)` when the interface owns the operation and selection.
The dynamic gateway and sync examples use `domain.prepareDispatch(...)` or
`domain.dispatch(...)` when the invocation arrives as data:
`{ name, args, select }`. Production gateways use `prepareDispatch` when they
need to inspect selection analysis or cache identity before resolvers run.
