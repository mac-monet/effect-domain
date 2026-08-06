# effect-domain

effect-domain is a domain action graph for Effect applications.

Define resources, computed fields, actions, subscriptions, selections, and runtime schemas once with Effect Schema. Then expose or execute the same model through REST, RPC, GraphQL adapters, sync engines, workflows, jobs, or direct Effect services.

The core idea is that the domain model is primary. Transports are projections of that model. For the longer version of that argument — including two Foldkit frontends built as projections of one domain — see [docs/projections.md](docs/projections.md).

> **Status:** pre-release. The API is settling but not yet frozen. Install with `npm install effect-domain`; requires `effect@^4.0.0-beta.101` (Effect v4).

## Why

Most application stacks redefine the same domain shape at every boundary:

- REST routes define request and response DTOs.
- GraphQL defines object types, fields, args, and resolvers.
- RPC defines procedure payload and result schemas.
- Sync engines and workflows define invocation records and replay behavior.
- Internal services define plain typed functions.

effect-domain gives those interfaces a shared executable model:

- `node(...)` defines a Schema-backed resource shape with computed fields.
- `operation(...)` and `subscription(...)` define named actions.
- `field(...)` defines computed or batched fields.
- `Domain.make(...)` creates an executable domain.
- `domain.bind(...)` exposes fixed, typed service methods.
- `domain.dispatch(...)` exposes a validated dynamic invocation boundary.
- `domain.argsSchema(...)`, `domain.selectionSchema(...)`, and `domain.responseSchema(...)` let adapters derive runtime schemas from the domain.

## Example

```ts
import { Effect, Schema } from "effect";
import { Domain, field, node, operation } from "effect-domain";

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
  },
);

const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Anderson" }),
  }),
});

const users = domain.bind({
  getUser: { select: { id: true, fullName: true } },
});

const result = users.getUser({ id: "1" });
```

The same `getUser` action can back:

- a fixed REST endpoint with `domain.bind(...)`,
- an RPC procedure using `domain.argsSchema(...)` and `domain.responseSchema(...)`,
- a GraphQL field by translating GraphQL selections into graph selections,
- a sync subscription or workflow step through `domain.dispatch(...)`.

## Dynamic HTTP Gateway

`domain.dispatch(...)` gives a GraphQL-like selection model over plain JSON
without adopting the GraphQL language or execution engine.

```json
POST /getUser
{
  "args": { "id": "1" },
  "select": {
    "id": true,
    "fullName": true,
    "profile": { "select": { "bio": true } }
  }
}
```

For simple gateways, `domain.dispatch(...)` validates `args` and `select`
against the graph and immediately runs the operation:

```ts
const result = domain.dispatch({
  name: "getUser",
  args: body.args,
  select: body.select,
});
```

Production gateways that need auth, selection limits, caching, rate limits, or
audit policy before resolvers run should use the two-stage boundary:

```ts
const program = Effect.gen(function* () {
  const prepared = yield* domain.prepareDispatch({
    name: "getUser",
    args: body.args,
    select: body.select,
  });

  if (prepared.analysis.depth > maxDepth) {
    return Result.fail("SelectionLimitExceeded");
  }

  // Walker concurrency is server policy — it is never part of the wire envelope.
  return yield* prepared.execute({ concurrency: 8 });
});
```

If the entire invocation record comes from untrusted data, decode it first with
`Domain.decodeDispatchRequest(...)` before calling `prepareDispatch`.

## Wire Adapters

For transports that serialize responses, `domain.handleDispatch(...)` is the
complete server pipeline: validate the envelope, execute, and encode the
dispatch Result with the domain's own wire codec
(`dispatchResultSchemaDynamic`). Every expected outcome — gateway errors and
declared operation errors — travels inside the encoded envelope, so the
handler's error channel is `never` and any transport can forward it as-is:

```ts
// HTTP route, RPC handler, worker message — all the same line:
const handler = Effect.gen(function* () {
  return yield* domain.handleDispatch({ name, args, select });
});
```

`Domain.client(...)` is the client mirror. Give it the domain and "how to
send", and it returns a client with full `domain.execute` /
`domain.subscribe` typing — names, args, selections, selection-dependent
result types. Successes arrive as plain selected data trees; failures decode
back into live error-class instances. `Domain.transportHttp(url)` is the
canonical "how to send" (POST each envelope as JSON, fetch-backed,
wire-level failures as `Domain.TransportError`); any `WireTransport` object
works for other protocols:

```ts
const client = Domain.client(domain, Domain.transportHttp("/rpc"));

// or hand the envelope to any protocol yourself:
const rpc = Domain.client(domain, {
  execute: (request) => rpcClient.DomainExecute(request),
  subscribe: (request) => rpcClient.DomainSubscribe(request),
});

const program = Effect.gen(function* () {
  // fails with UserNotFound | GatewayError | TransportError | ... — all typed
  return yield* client.execute("getUser", {
    args: { id: "1" },
    select: { id: true, fullName: true },
  });
});
```

`Domain.client(domain)` — no transport — is the in-process client: the same
typed surface glued to `handleDispatch` / `handleSubscription` on the same
instance, so a server entry (SSR, tests, background jobs) runs the exact
calls the browser runs, wire codec round-trip included, with no wire.

Serializing failures requires each fallible operation — and each fallible
computed field — to declare an `error` schema (`operation({ error:
UserNotFound, ... })`, `field({ error: ..., ... })`); `Domain.client` enforces
this at compile time, naming any operation that is missing one. A field's
typed failure fails the whole operation, so it arrives as that operation's
`OperationError` cause.

The dispatch ladder, then, is: `handleDispatch` for simple wire transports,
`prepareDispatch` when policy must run between validation and execution,
`dispatch` when nothing crosses a wire and live `Result` values are wanted.
See `examples/rpc-dispatch.ts` and `examples/http-dispatch.ts` for both ends
of the wire in ~50 lines each.

`domain.responseSchema(...)` is intended for fixed or already-validated
selections, such as RPC route declarations and typed clients. Dynamic gateways
should avoid synthesizing response schemas for arbitrary user-controlled
selections unless they bound or reuse the selection set.

Invocation keys default to compact 8-byte / 16-hex-character SHA-256 prefixes.
Use a longer key for durable or global idempotency stores:

```ts
const key = domain.invocationKey(invocation, { bytes: 16 });
```

This is not a replacement for GraphQL's ecosystem, parser, fragments,
introspection, or null-bubbling semantics. It is a smaller primitive for systems
where you control the client and server and want selected responses over
ordinary HTTP.

## Node Registry, Identity, and Topology

`Domain.make` reifies the domain model once into a node registry: every
`node()` reachable from the operations, its fields, sentinels, and the
reference edges between nodes. Two consumer-facing views are derived from it:

- `domain.inspect()` — plain-data snapshot of operations and nodes.
- `domain.topology()` — the domain graph as a core `effect/Graph` value
  (`DirectedGraph<NodeInfo, FieldEdge>`), composable with the core Graph module's
  traversal algorithms, plus `toMermaid()` / `toGraphViz()` diagram export.

```ts
const topology = domain.topology();
console.log(topology.toMermaid()); // flowchart of nodes and field edges
```

Nodes can declare a canonical entity key, the foundation for caches and
sync-engine invalidation:

```ts
const User = node("User", UserSchema, fields, { identity: "id" });
// or a derived key:
const Feed = node("Feed", FeedSchema, {}, { identity: (feed) => `feed:${feed.id}` });
```

## Read Sets

Pass `reads: true` to `execute` and the result arrives in an `Execution`
envelope that additionally reports the deduplicated `(node, key)` pairs of
every identified entity the walk touched:

```ts
const { result, reads } =
  yield *
  domain.execute("getFeed", {
    args: { id: "f1" },
    reads: true,
    select: { posts: { select: { author: { select: { name: true } } } } },
  });
// reads: [{ node: "Feed", key: "feed:f1" }, { node: "Post", key: "p1" }, ...]
```

Only nodes declaring both an identifier and an `identity` participate. Two
sync-engine uses fall out of one primitive:

- **Query dependencies** — a subscription's read set is the exact set of
  entities whose changes should invalidate it.
- **Mutation write-sets** — run a mutation with `reads: true` and the
  entities present in its response are the touched keys, with no separate
  declaration (mutations should return what they changed).

## N+1 and Request Batching

effect-domain does not include a query planner. It uses Effect's request batching
for relation-like fields.

A field with `key` is resolved through `Effect.request`, so many selected fields
with the same resolver can be batched by Effect:

```ts
const User = node("User", UserSchema, {
  posts: field({
    type: Schema.Array(Post),
    key: (user) => user.id,
    resolve: (userIds) => PostRepo.findByAuthorIds(userIds),
  }),
});
```

Selecting posts for a list of users still looks like per-user field resolution:

```ts
domain.execute("listUsers", {
  select: {
    id: true,
    posts: { select: { title: true } },
  },
});
```

Internally, the walker creates requests for each selected `posts` field and
Effect coalesces them. For 100 users, this can become one `listUsers` operation
plus one batched `findByAuthorIds([...100 ids])` call, not 100 individual post
loads.

The batching primitive is backend-agnostic. A resolver can batch through SQL,
a KV store, a cache, another HTTP service, or an in-memory map. effect-domain
only describes when a selected field should be resolved and how to derive its
batch key.

## More

- [examples/README.md](./examples/README.md) shows one shared domain graph exposed through HTTP, RPC, streaming, and sync-engine shapes.
- [EFFECT_DOMAIN.md](./EFFECT_DOMAIN.md) contains longer design notes.

## Development

```bash
vp install
vp check
vp test
vp pack
```
