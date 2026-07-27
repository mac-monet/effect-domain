# Sync Engine Example

`examples/sync-engine.ts` is an intentionally small in-memory sync engine. It
exists to show why the graph-native gateway primitives are useful outside
HTTP/RPC/GraphQL.

The important split is:

```text
fixed HTTP/RPC adapters  -> domain.execute / domain.subscribe
dynamic sync engine      -> domain.dispatch / domain.dispatchSubscription
```

HTTP and RPC fixed-selection bindings already know the operation name, args
projection, and selection at declaration time. A sync engine usually receives
or replays dynamic invocations from clients or storage:

```ts
{
  clientId: "client-1",
  name: "watchUsers",
  args: { start: 10 },
  select: { id: true, fullName: true },
}
```

That is an untyped boundary, so the sync engine should use `dispatch(...)` or
`dispatchSubscription(...)`. Boundary failures and operation failures become data values
instead of failing the worker fiber.

## Event Log Shape

The example stores events in memory:

```ts
type SyncEvent =
  | { _tag: "Item"; clientId: string; key: string; seq: number; value: unknown }
  | { _tag: "Failure"; clientId: string; key: string; seq: number; error: unknown }
  | { _tag: "Complete"; clientId: string; key: string; seq: number };
```

`seq` is a monotonically increasing cursor. Clients pull the feed with:

```ts
sync.pull({ clientId: "client-1", after: lastSeenSeq });
```

or for one subscription:

```ts
sync.pull({ clientId: "client-1", key, after: lastSeenSeq });
```

## Subscription Identity

The sync engine uses:

```ts
const key = domain.invocationKey({ name, args, select });
```

That key is the stable identity for a subscribed invocation. It is canonical
over object key order and selection normalization, so duplicate subscriptions
for the same client and invocation can be idempotent.

The default key is compact: 8 bytes / 16 hex characters. Use a longer key for
durable or global idempotency tables:

```ts
const key = domain.invocationKey({ name, args, select }, { bytes: 16 });
```

The example stores subscriptions by:

```text
clientId + invocationKey
```

Repeated `subscribe(...)` calls for the same client/key return the existing
subscription instead of replaying the stream and appending duplicate events.

## Lifecycle

`subscribe(...)` registers the subscription and forks stream consumption into a
background fiber. It returns immediately:

```ts
const subscription =
  yield *
  sync.subscribe({
    clientId: "client-1",
    name: "watchUsers",
    args: { start: 10 },
    select: { id: true, fullName: true },
  });
```

For finite example streams, the engine appends `Complete` and marks the
subscription status as `"Complete"`. For real live streams, the status would
remain `"Active"` until cancellation, failure, or disconnect handling is added.

The example exposes `wait(subscription)` only so tests can deterministically
wait for finite streams to finish.

## Failure Semantics

`domain.dispatchSubscription(...)` emits `Result` values:

- `Result.success(value)` for stream items
- `Result.failure(GatewayError)` for invalid operation, args, or selection
- `Result.failure(OperationError<E>)` for operation failures

The sync engine stores those failures as `Failure` events:

```ts
{
  _tag: "Failure",
  clientId,
  key,
  seq,
  error,
}
```

This is the right shape for a sync worker because one bad invocation should not
crash the process or erase the client's ability to resume from a cursor.

## What This Example Does Not Do

This is not a production sync engine. It intentionally does not implement:

- durable storage
- serialization for cross-process replay
- cancellation and disconnect cleanup
- backpressure
- mutation queues
- auth or per-client filtering
- compaction
- coarse invalidation
- incremental view maintenance

Those can be layered later. The point of this example is only to show that
`dispatchSubscription(...)`, `invocationKey(...)`, and result-as-data outcomes are a
good foundation for sync-engine style delivery.

## Live Queries via Read Sets

`examples/live-queries.ts` is the invalidation-driven sibling of this example.
Instead of forwarding stream subscriptions, it keeps _operation_ results
current: each live query is dispatched with `{ reads: true }`, the engine
remembers the `(node, key)` entities the walk touched, and `invalidate(entity)`
re-runs exactly the queries that depend on that entity — emitting a new event
only when the result actually changed. Mutations dispatched with
`{ reads: true }` report their own touched entities (their response walk),
closing the loop without separate write declarations.

Together the two examples cover both delivery models a sync engine needs:
pushed streams (this file) and invalidated queries (`live-queries.ts`).
