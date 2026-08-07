import { Effect, Result } from "effect";
import type {
  DispatchOptions,
  DispatchRequest,
  GatewayError,
  Invocation,
  OperationError,
  ReadSet,
} from "../src/index.ts";

/**
 * A toy live-query engine: the read-set-driven sibling of
 * `examples/sync-engine.ts`.
 *
 * Where the sync-engine example forwards *stream* subscriptions, this engine
 * keeps *operation* results current by invalidation:
 *
 * 1. `subscribe` dispatches the operation with `reads: true` and remembers
 *    which entities the walk touched.
 * 2. `invalidate(entity)` re-runs exactly the queries whose read set contains
 *    that entity, appends a new event when the result actually changed, and
 *    replaces the stored read set (dependencies can shift between runs).
 * 3. Clients `pull` events after a cursor, as in the sync-engine example.
 *
 * This is the poke + re-pull model with read-set precision instead of
 * re-running everything. It is intentionally in-memory and single-process;
 * durable storage, delivery, mutation queues, and per-entity versions are
 * engine concerns outside this library.
 */

export interface LiveQueryRequest {
  readonly clientId: string;
  readonly name: string;
  readonly args?: unknown;
  readonly select?: unknown;
}

export interface LiveQuery {
  readonly clientId: string;
  /** Canonical invocation key — the stable identity of this live query. */
  readonly key: string;
  readonly invocation: Invocation;
}

export interface EntityRef {
  readonly node: string;
  readonly key: string;
}

export type LiveQueryEvent =
  | {
      readonly _tag: "Value";
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
    };

export interface PullRequest {
  readonly clientId: string;
  readonly key?: string;
  readonly after?: number;
}

interface LiveQueryDomain<R> {
  readonly invocationKey: (invocation: Invocation) => string;
  readonly dispatch: (
    config: DispatchRequest,
    options?: DispatchOptions,
  ) => Effect.Effect<Result.Result<unknown, GatewayError | OperationError<unknown>>, never, R>;
}

interface ReadsEnvelope {
  readonly result: unknown;
  readonly reads: ReadSet;
}

export function makeLiveQueryEngine<R>(domain: LiveQueryDomain<R>) {
  interface StoredQuery {
    readonly query: LiveQuery;
    /** `${node}:${key}` entries the last run touched. */
    dependencies: ReadonlySet<string>;
    /** Canonical JSON of the last delivered value, for change detection. */
    lastValue: string | undefined;
  }

  const queries = new Map<string, StoredQuery>();
  const events: Array<LiveQueryEvent> = [];
  let nextSeq = 1;

  const entityId = (entity: EntityRef): string => `${entity.node}:${entity.key}`;

  type LiveQueryEventInput =
    | Omit<Extract<LiveQueryEvent, { readonly _tag: "Value" }>, "seq">
    | Omit<Extract<LiveQueryEvent, { readonly _tag: "Failure" }>, "seq">;

  const append = (event: LiveQueryEventInput): void => {
    events.push({ ...event, seq: nextSeq++ } as LiveQueryEvent);
  };

  const run = (stored: StoredQuery): Effect.Effect<void, never, R> =>
    Effect.map(
      domain.dispatch(
        {
          name: stored.query.invocation.name,
          args: stored.query.invocation.args,
          select: stored.query.invocation.select,
        },
        { reads: true },
      ),
      (result) => {
        if (Result.isFailure(result)) {
          append({
            _tag: "Failure",
            clientId: stored.query.clientId,
            key: stored.query.key,
            error: result.failure,
          });
          return;
        }
        const envelope = result.success as ReadsEnvelope;
        stored.dependencies = new Set(envelope.reads.map((read) => `${read.node}:${read.key}`));
        const serialized = JSON.stringify(envelope.result);
        if (serialized !== stored.lastValue) {
          stored.lastValue = serialized;
          append({
            _tag: "Value",
            clientId: stored.query.clientId,
            key: stored.query.key,
            value: envelope.result,
          });
        }
      },
    );

  return {
    /**
     * Registers a live query (idempotent per client + invocation key) and
     * delivers its initial value as an event.
     */
    subscribe(request: LiveQueryRequest): Effect.Effect<LiveQuery, never, R> {
      const invocation: Invocation = {
        name: request.name,
        args: request.args,
        select: request.select,
      };
      const key = domain.invocationKey(invocation);
      const id = `${request.clientId}:${key}`;

      return Effect.gen(function* () {
        const existing = queries.get(id);
        if (existing) return existing.query;

        const stored: StoredQuery = {
          query: { clientId: request.clientId, key, invocation },
          dependencies: new Set(),
          lastValue: undefined,
        };
        queries.set(id, stored);
        yield* run(stored);
        return stored.query;
      });
    },

    /**
     * Signals that an entity changed. Re-runs exactly the live queries whose
     * last walk touched it; unchanged results produce no events.
     */
    invalidate(entity: EntityRef): Effect.Effect<void, never, R> {
      const id = entityId(entity);
      const affected = Array.from(queries.values()).filter((stored) => stored.dependencies.has(id));
      // Concurrent re-runs share one batching window, so affected queries'
      // batched fields coalesce instead of issuing one round per query.
      return Effect.forEach(affected, run, { concurrency: "unbounded", discard: true });
    },

    pull(request: PullRequest): ReadonlyArray<LiveQueryEvent> {
      const after = request.after ?? 0;
      return events.filter(
        (event) =>
          event.clientId === request.clientId &&
          event.seq > after &&
          (request.key === undefined || event.key === request.key),
      );
    },

    /** The current entity dependencies of one client's live query. */
    dependenciesOf(query: Pick<LiveQuery, "clientId" | "key">): ReadonlySet<string> {
      return queries.get(`${query.clientId}:${query.key}`)?.dependencies ?? new Set();
    },
  };
}
