import { Deferred, Effect, Fiber, type Fiber as FiberType, Result, Stream } from "effect";
import type { DispatchRequest, GatewayError, Invocation, OperationError } from "../src/index.ts";

export interface SyncRequest {
  readonly clientId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly select?: unknown;
}

export interface Subscription {
  readonly clientId: string;
  readonly key: string;
  readonly invocation: Invocation;
  readonly status: "Active" | "Complete";
}

export type SyncEvent =
  | {
      readonly _tag: "Item";
      readonly clientId: string;
      readonly key: string;
      readonly seq: number;
      readonly value: unknown;
    }
  | {
      readonly _tag: "Failure";
      readonly clientId: string;
      readonly key: string;
      readonly seq: number;
      readonly error: GatewayError | OperationError<unknown>;
    }
  | {
      readonly _tag: "Complete";
      readonly clientId: string;
      readonly key: string;
      readonly seq: number;
    };

type SyncEventInput =
  | Omit<Extract<SyncEvent, { readonly _tag: "Item" }>, "seq">
  | Omit<Extract<SyncEvent, { readonly _tag: "Failure" }>, "seq">
  | Omit<Extract<SyncEvent, { readonly _tag: "Complete" }>, "seq">;

export interface PullRequest {
  readonly clientId: string;
  readonly key?: string;
  readonly after?: number;
}

interface SyncGraph<R> {
  readonly invocationKey: (invocation: Invocation) => string;
  readonly dispatchSubscription: (
    config: DispatchRequest,
  ) => Stream.Stream<Result.Result<unknown, GatewayError | OperationError<unknown>>, never, R>;
}

export function makeInMemorySyncEngine<R>(domain: SyncGraph<R>) {
  type StoredSubscription = {
    subscription: Subscription;
    fiber: FiberType.Fiber<void, never>;
  };

  const subscriptions = new Map<string, StoredSubscription>();
  const events: Array<SyncEvent> = [];
  let nextSeq = 1;

  const append = (event: SyncEventInput): Effect.Effect<SyncEvent> =>
    Effect.sync(() => {
      const stored = { ...event, seq: nextSeq++ } as SyncEvent;
      events.push(stored);
      return stored;
    });

  const setStatus = (id: string, status: Subscription["status"]): Effect.Effect<void> =>
    Effect.sync(() => {
      const stored = subscriptions.get(id);
      if (stored) {
        subscriptions.set(id, {
          ...stored,
          subscription: { ...stored.subscription, status },
        });
      }
    });

  return {
    subscribe(request: SyncRequest): Effect.Effect<Subscription, never, R> {
      const invocation: Invocation = {
        name: request.name,
        args: request.args,
        select: request.select,
      };
      const key = domain.invocationKey(invocation);
      const id = `${request.clientId}:${key}`;
      const subscription: Subscription = {
        clientId: request.clientId,
        key,
        invocation,
        status: "Active",
      };

      return Effect.gen(function* () {
        const existing = yield* Effect.sync(() => subscriptions.get(id));
        if (existing) return existing.subscription;

        const start = yield* Deferred.make<void>();
        const fiber = yield* Stream.unwrap(
          Deferred.await(start).pipe(Effect.as(domain.dispatchSubscription(request))),
        ).pipe(
          Stream.runForEach((result) =>
            Result.isFailure(result)
              ? append({
                  _tag: "Failure",
                  clientId: request.clientId,
                  key,
                  error: result.failure,
                })
              : append({
                  _tag: "Item",
                  clientId: request.clientId,
                  key,
                  value: result.success,
                }),
          ),
          Effect.flatMap(() =>
            append({
              _tag: "Complete",
              clientId: request.clientId,
              key,
            }),
          ),
          Effect.flatMap(() => setStatus(id, "Complete")),
          Effect.forkDetach,
        );

        yield* Effect.sync(() => {
          subscriptions.set(id, { subscription, fiber });
        });
        yield* Deferred.succeed(start, undefined);

        return subscription;
      });
    },

    pull(request: PullRequest): Effect.Effect<ReadonlyArray<SyncEvent>> {
      const after = request.after ?? 0;
      return Effect.sync(() =>
        events.filter(
          (event) =>
            event.clientId === request.clientId &&
            event.seq > after &&
            (request.key === undefined || event.key === request.key),
        ),
      );
    },

    subscriptions(): Effect.Effect<ReadonlyArray<Subscription>> {
      return Effect.sync(() =>
        Array.from(subscriptions.values()).map((stored) => stored.subscription),
      );
    },

    wait(subscription: Pick<Subscription, "clientId" | "key">): Effect.Effect<void> {
      return Effect.gen(function* () {
        const stored = yield* Effect.sync(() =>
          subscriptions.get(`${subscription.clientId}:${subscription.key}`),
        );
        if (stored) yield* Fiber.await(stored.fiber);
      });
    },
  };
}
