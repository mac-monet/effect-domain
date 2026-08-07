# GraphQL / effect-gql Direction

This is a planning note for integrating `effect-domain` with the existing
`effect-gql` project. The direction is not a thin HTTP/RPC-style adapter.
GraphQL needs a real runtime integration because GraphQL brings its own schema,
parser, validator, operation language, selection language, response envelope,
error formatting, and subscription protocol.

The target split is:

```text
effect-domain = graph definition + execution engine
effect-gql   = code-first GraphQL API + GraphQL semantics
```

`effect-gql` can make breaking changes if that makes the integration cleaner.
The goal is to remove the GraphQL per-field executor and use `effect-domain` as
the backend that resolves selected fields.

## Core Boundary

GraphQL owns ceremony:

- GraphQL schema construction
- parsing and validation
- variables and default values
- fragments, aliases, directives, and introspection
- query / mutation / subscription categorization
- GraphQL response shape
- GraphQL error paths and null bubbling
- HTTP, WebSocket, and server integrations

effect-domain owns execution:

- operation definitions
- subscription definitions
- args schemas
- selection-driven graph walking
- computed fields
- service requirements
- batching via `Effect.request`
- Effect failures and streams

The normal GraphQL path should be:

```text
GraphQL document
  -> graphql-js parse
  -> graphql-js validate against GraphQLSchema
  -> effect-gql collect root field args and selection set
  -> effect-gql convert GraphQL selection set to effect-domain selection
  -> domain.execute(...) or domain.subscribe(...)
  -> effect-gql convert result tree failures to GraphQL errors
  -> effect-gql apply GraphQL null bubbling
  -> GraphQL ExecutionResult
```

`domain.dispatch(...)` and `domain.dispatchSubscription(...)` are not the primary
GraphQL execution path. They are generic dynamic gateway APIs for untyped
`{ name, args, select }` input. GraphQL already parsed and validated operation
names, arguments, and selections, so `effect-gql` should avoid double-decoding
through gateway errors unless it is intentionally exposing a generic graph
gateway.

## Product Shape

`effect-gql` should still feel like a code-first GraphQL library:

```ts
const User = gql.object(
  "User",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
  }),
  (f) => ({
    fullName: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
  }),
);

const schema = gql.schema({
  query: {
    user: gql.query({
      type: User,
      args: Schema.Struct({ id: Schema.String }),
      resolve: ({ args }) => UserRepo.findById(args.id),
    }),
  },
});
```

Internally, those declarations should compile to an `effect-domain` graph:

```text
effect-gql declarations
  -> effect-domain graph
  -> GraphQLSchema
```

For users who already have an `effect-domain` graph, `effect-gql` should also
support direct schema projection:

```ts
const schema = gql.schemaFromGraph(graph, {
  query: {
    user: {
      operation: "getUser",
      args: ({ id }) => ({ id }),
    },
    users: {
      operation: "listUsers",
    },
  },
  mutation: {
    createUser: {
      operation: "createUser",
      args: ({ input }) => input,
    },
  },
  subscription: {
    userEvents: {
      subscription: "watchUsers",
    },
  },
});
```

The GraphQL root field name does not have to match the graph operation or
subscription name. That mapping belongs to `effect-gql`, not effect-domain.

## Execution

Given a GraphQL query:

```graphql
query GetUser($id: String!) {
  user(id: $id) {
    id
    fullName
  }
}
```

`effect-gql` should translate the validated root field into:

```ts
domain.execute({
  name: "getUser",
  args: { id: variables.id },
  select: { id: true, fullName: true },
});
```

For subscriptions:

```graphql
subscription WatchUsers($start: Int!) {
  watchUsers(start: $start) {
    id
    fullName
  }
}
```

`effect-gql` should translate to:

```ts
domain.subscribe({
  name: "watchUsers",
  args: { start: variables.start },
  select: { id: true, fullName: true },
});
```

The returned `Stream` is then exposed as the GraphQL subscription async
iterable.

## Selection Translation

GraphQL selection sets must be converted into effect-domain selections.

Basic fields:

```graphql
{
  id
  fullName
}
```

become:

```ts
{ id: true, fullName: true }
```

Nested selections:

```graphql
{
  profile {
    bio
  }
}
```

become:

```ts
{
  profile: {
    select: {
      bio: true;
    }
  }
}
```

Aliases, fragments, inline fragments, directives, and union/interface
selections are GraphQL responsibilities. `effect-gql` should resolve those
against the GraphQL validation context before calling `domain.execute(...)` or
`domain.subscribe(...)`.

## Error Mapping

GraphQL validation failures stay GraphQL validation errors.

Operation failures from `domain.execute(...)` or `domain.subscribe(...)` should
become GraphQL errors with useful paths. Field-level failures in the effect-domain
result tree should also become GraphQL errors at the corresponding field path.

`GatewayError` is not part of the normal GraphQL path. It belongs to
`domain.dispatch(...)` and `domain.dispatchSubscription(...)`, where untyped
runtime `{ name, args, select }` input must be decoded by effect-domain itself.

## Implementation Modules

Start inside `effect-gql`; do not create a separate package first.

Suggested modules:

- `graph/schema.ts`: builds `GraphQLSchema` from an effect-domain graph plus
  GraphQL mapping config.
- `graph/selection.ts`: converts a validated GraphQL selection set into an
  effect-domain selection.
- `graph/args.ts`: converts GraphQL coerced args into graph args using mapping
  config.
- `graph/execute.ts`: parses, validates, translates, calls `domain.execute(...)`,
  and formats `ExecutionResult`.
- `graph/subscribe.ts`: translates GraphQL subscriptions, calls
  `domain.subscribe(...)`, and exposes an async iterable.
- `graph/result.ts`: maps effect-domain result tree failures to GraphQL errors
  and applies null bubbling.

The old per-field GraphQL executor should be removed or demoted to a
compatibility shim. It should not remain the primary execution path.

## Open Questions

- Should `effect-gql` preserve source compatibility for `gql.object`,
  `gql.field`, and `gql.query`, or should it expose graph-native builders?
- Should `schemaFromGraph(graph, config)` be public from the start, or should
  code-first declarations always compile to a graph first?
- How should GraphQL non-null annotations be represented in Effect Schema so
  null bubbling can be applied correctly after graph execution?
- Should operation failures always become GraphQL errors, or should config allow
  typed result-union object fields?
- How should Relay conventions map onto graph nodes and selections?
