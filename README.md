# effect-domain

effect-domain is a domain action graph for Effect applications.

Define your resources, computed fields, actions, subscriptions, selections, and runtime schemas one time with Effect Schema. Then serve the same model through REST, RPC, GraphQL adapters, sync engines, workflows, jobs, or direct Effect services.

The domain model is primary. Transports are projections of the model. For the full argument — with two Foldkit frontends built as projections of one domain — see [docs/projections.md](docs/projections.md).

> **Status:** pre-release. The API is almost stable, but it is not frozen. Install with `npm install effect-domain`. The library requires `effect@^4.0.0-beta.101` (Effect v4).

## Why

Most application stacks define the same domain shape again at each boundary:

- REST routes define request DTOs and response DTOs.
- GraphQL defines object types, fields, args, and resolvers.
- RPC defines payload schemas and result schemas.
- Sync engines and workflows define invocation records and replay behavior.
- Internal services define plain typed functions.

effect-domain gives one shared executable model to these interfaces:

- `node(...)` defines a Schema-backed resource shape with computed fields.
- `operation(...)` and `subscription(...)` define named actions.
- `field(...)` defines computed or batched fields.
- `Domain.make(...)` creates an executable domain.
- `domain.bind(...)` gives fixed, typed service methods.
- `domain.dispatch(...)` gives a validated dynamic invocation boundary.
- `domain.argsSchema(...)`, `domain.selectionSchema(...)`, and `domain.responseSchema(...)` derive runtime schemas from the domain for adapters.

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

The same `getUser` action can supply:

- a fixed REST endpoint, with `domain.bind(...)`,
- an RPC procedure, with `domain.argsSchema(...)` and `domain.responseSchema(...)`,
- a GraphQL field, when the adapter translates GraphQL selections into graph selections,
- a sync subscription or a workflow step, through `domain.dispatch(...)`.

## Dynamic HTTP Gateway

`domain.dispatch(...)` gives a GraphQL-like selection model over plain JSON. You do not adopt the GraphQL language or the GraphQL engine.

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

For simple gateways, `domain.dispatch(...)` validates `args` and `select` against the graph. Then it runs the operation immediately:

```ts
const result = domain.dispatch({
  name: "getUser",
  args: body.args,
  select: body.select,
});
```

Production gateways frequently apply policy before the resolvers run: auth, selection limits, caches, rate limits, or audit rules. For these, use the two-stage boundary:

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

When the full invocation record comes from untrusted data, decode it first with `Domain.decodeDispatchRequest(...)`. Then call `prepareDispatch`.

## Wire Adapters

For transports that serialize responses, `domain.handleDispatch(...)` is the complete server pipeline. It validates the envelope, runs the operation, and encodes the dispatch Result with the wire codec of the domain (`dispatchResultSchemaDynamic`). Each expected outcome — gateway errors and declared operation errors — travels inside the encoded envelope. The error channel of the handler is `never`, and each transport can forward the envelope without changes:

```ts
// HTTP route, RPC handler, worker message — all the same line:
const handler = Effect.gen(function* () {
  return yield* domain.handleDispatch({ name, args, select });
});
```

`Domain.client(...)` is the client mirror. Give it the domain and a transport. It returns a client with the full `domain.execute` / `domain.subscribe` types: names, args, selections, and selection-dependent result types. Successes arrive as plain selected data trees. Failures decode back into live error-class instances. `Domain.transportHttp(url)` is the canonical transport: it sends each envelope as JSON with POST, and it reports wire-level failures as `Domain.TransportError`. You can supply a different `WireTransport` object for other protocols:

```ts
const client = Domain.client(domain, Domain.transportHttp("/rpc"));

// or hand the envelope to any protocol yourself:
const rpc = Domain.client(domain, {
  execute: (request) => rpcClient.DomainExecute(request),
  subscribe: (request) => rpcClient.DomainSubscribe(request),
});

const program = Effect.gen(function* () {
  // fails with UserNotFound | GatewayError | TransportError | ... — all typed
  return yield* client.execute({
    name: "getUser",
    args: { id: "1" },
    select: { id: true, fullName: true },
  });
});
```

`Domain.client(domain)` with no transport is the in-process client. It is the same typed surface, connected to `handleDispatch` / `handleSubscription` on the same instance. A server entry (SSR, tests, background jobs) runs the same calls that the browser runs, with the wire codec round-trip, but with no wire.

To serialize failures, each fallible operation — and each fallible computed field — must declare an `error` schema (`operation({ error: UserNotFound, ... })`, `field({ error: ..., ... })`). `Domain.client` makes sure of this at compile time, and it names each operation that does not have one. A typed field failure causes the full operation to fail, so it arrives as the `OperationError` cause of that operation.

The dispatch ladder:

- Use `handleDispatch` for simple wire transports.
- Use `prepareDispatch` when policy must run between validation and execution.
- Use `dispatch` when nothing crosses a wire and you want live `Result` values.

`dispatch` and `handleDispatch` also accept an array of envelopes. They return one outcome for each envelope, in order. A failure in one entry stays inside its own Result or encoded envelope, and the other entries succeed. A batch wire endpoint is one `Array.isArray(body)` check away from a single-envelope endpoint. See `examples/rpc-dispatch.ts` and `examples/http-dispatch.ts` for the two ends of the wire, in approximately 50 lines each.

`domain.responseSchema(...)` is for fixed or validated selections, for example RPC route declarations and typed clients. Dynamic gateways must not make response schemas for arbitrary user-controlled selections, unless they limit or reuse the selection set.

The derived schemas are standard Effect Schemas. JSON Schema export for non-TypeScript consumers is one call. No OpenAPI pipeline is necessary:

```ts
import { Schema } from "effect";

Schema.toJsonSchemaDocument(domain.argsSchema("getUser")).schema;
// { type: "object", properties: { id: { type: "string" } }, required: ["id"], ... }

Schema.toJsonSchemaDocument(domain.responseSchema("getUser", { id: true, fullName: true })).schema;
// { type: "object", properties: { id: ..., fullName: ... }, ... }
```

Invocation keys default to compact 8-byte / 16-hex-character SHA-256 prefixes. Use a longer key for durable or global idempotency stores:

```ts
const key = domain.invocationKey(invocation, { bytes: 16 });
```

This is not a replacement for the GraphQL ecosystem, parser, fragments, introspection, or null-bubbling semantics. It is a smaller primitive for systems where you control the client and the server, and where you want selected responses over standard HTTP.

## Node Registry, Identity, and Topology

`Domain.make` reifies the domain model one time into a node registry: each `node()` reachable from the operations, its fields, its sentinels, and the reference edges between nodes. Two consumer-facing views come from the registry:

- `domain.inspect()` — a plain-data snapshot of operations, subscriptions, and nodes.
- `domain.topology()` — the domain graph as a core `effect/Graph` value
  (`DirectedGraph<NodeInfo, FieldEdge>`). It composes with the traversal algorithms of the core Graph module, and it has `toMermaid()` / `toGraphViz()` diagram export.

```ts
const topology = domain.topology();
console.log(topology.toMermaid()); // flowchart of nodes and field edges
```

A node can declare a canonical entity key. This key is the foundation for caches and sync-engine invalidation:

```ts
const User = node("User", UserSchema, fields, { identity: "id" });
// or a derived key:
const Feed = node("Feed", FeedSchema, {}, { identity: (feed) => `feed:${feed.id}` });
```

## Read Sets

Pass `{ reads: true }` in the options of `execute`. The result then arrives in an `Execution` envelope, which also reports the deduplicated `(node, key)` pairs of each identified entity that the walk touched:

```ts
const { result, reads } =
  yield *
  domain.execute(
    {
      name: "getFeed",
      args: { id: "f1" },
      select: { posts: { select: { author: { select: { name: true } } } } },
    },
    { reads: true },
  );
// reads: [{ node: "Feed", key: "feed:f1" }, { node: "Post", key: "p1" }, ...]
```

Only nodes that declare an identifier and an `identity` participate. One primitive gives two sync-engine uses:

- **Query dependencies** — the read set of a subscription is the exact set of entities whose changes must invalidate it.
- **Mutation write-sets** — run a mutation with `reads: true`. The entities in its response are the touched keys, with no separate declaration (a mutation must return what it changed).

## N+1 and Request Batching

effect-domain does not include a query planner. It uses the request batching from Effect for relation-like fields.

A field with `key` resolves through `Effect.request`, so Effect can batch many selected fields that have the same resolver:

```ts
const User = node("User", UserSchema, {
  posts: field({
    type: Schema.Array(Post),
    key: (user) => user.id,
    resolve: (userIds) => PostRepo.findByAuthorIds(userIds),
  }),
});
```

A selection of posts for a list of users continues to look like per-user field resolution:

```ts
domain.execute({
  name: "listUsers",
  select: {
    id: true,
    posts: { select: { title: true } },
  },
});
```

Internally, the walker creates one request for each selected `posts` field, and Effect coalesces the requests. For 100 users, this can become one `listUsers` operation plus one batched `findByAuthorIds([...100 ids])` call, not 100 individual post loads.

Batching coalesces by the identity of the resolve function, inside one execution context. Each batch call receives distinct keys. Two fields that share one resolve function — `Post.author` and `Comment.author` both load users — share one request family. A walk that touches the two fields makes a single batched call with no duplicate keys. The shared function is the full declaration: there are no loader objects to construct or to thread through context. Inline closures are different functions, and they batch separately. Concurrent executions with different provided services never share a batch — coalescing is scoped to the built context, so the services of one run can never answer the keys of a different run.

The batching primitive is backend-agnostic. A resolver can batch through SQL, a KV store, a cache, a different HTTP service, or an in-memory map. effect-domain only specifies when a selected field must resolve and how to derive its batch key.

Batching also crosses operations. `execute` accepts an array of dispatch-shaped entries and returns a tuple with a type for each entry. The entries run concurrently in one fiber tree, so batched fields coalesce **across** entries:

```ts
const [users, user] =
  yield *
  domain.execute([
    { name: "listUsers", select: { id: true, posts: { select: { title: true } } } },
    { name: "getUser", args: { id: "1" }, select: { posts: { select: { title: true } } } },
  ]);
// posts for both result sets arrive via one findByAuthorIds([...]) call
```

## More

- [examples/README.md](./examples/README.md) shows one shared domain graph served through HTTP, RPC, streaming, and sync-engine shapes.
- [EFFECT_DOMAIN.md](./EFFECT_DOMAIN.md) contains longer design notes.

## Development

```bash
vp install
vp check
vp test
vp pack
```
