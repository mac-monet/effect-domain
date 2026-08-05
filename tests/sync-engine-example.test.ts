import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserRepoLive } from "../examples/domain.ts";
import { makeInMemorySyncEngine } from "../examples/sync-engine.ts";

describe("Example: in-memory sync engine", () => {
  it("subscribes to a domain stream and replays in-memory client events", async () => {
    const sync = makeInMemorySyncEngine(domain);

    const subscription = await Effect.runPromise(
      sync
        .subscribe({
          clientId: "client-1",
          name: "watchUsers",
          args: { start: 10 },
          select: { id: true, fullName: true },
        })
        .pipe(Effect.provide(UserRepoLive)),
    );
    await Effect.runPromise(sync.wait(subscription));

    const events = await Effect.runPromise(sync.pull({ clientId: "client-1" }));

    expect(subscription.key).toBe(
      domain.invocationKey({
        name: "watchUsers",
        args: { start: 10 },
        select: { fullName: true, id: true },
      }),
    );
    expect(events.map((event) => event._tag)).toEqual(["Item", "Item", "Complete"]);

    const first = events[0];
    const second = events[1];
    expect(first._tag).toBe("Item");
    expect(second._tag).toBe("Item");
    if (first._tag !== "Item" || second._tag !== "Item") {
      throw new Error("expected item events");
    }

    // Stored events carry plain data snapshots.
    expect(first.value).toEqual({ id: "10", fullName: "Stream One" });
    expect(second.value).toEqual({ id: "11", fullName: "Stream Two" });

    const afterFirst = await Effect.runPromise(
      sync.pull({ clientId: "client-1", after: first.seq }),
    );
    expect(afterFirst.map((event) => event.seq)).toEqual([second.seq, events[2].seq]);

    const byKey = await Effect.runPromise(
      sync.pull({ clientId: "client-1", key: subscription.key }),
    );
    expect(byKey).toHaveLength(3);

    const subscriptions = await Effect.runPromise(sync.subscriptions());
    expect(subscriptions).toEqual([{ ...subscription, status: "Complete" }]);
  });

  it("treats duplicate subscribe calls as idempotent for the same client invocation", async () => {
    const sync = makeInMemorySyncEngine(domain);

    const request = {
      clientId: "client-1",
      name: "watchUsers",
      args: { start: 10 },
      select: { id: true },
    };
    const first = await Effect.runPromise(
      sync.subscribe(request).pipe(Effect.provide(UserRepoLive)),
    );
    const second = await Effect.runPromise(
      sync
        .subscribe({
          ...request,
          select: { id: true },
        })
        .pipe(Effect.provide(UserRepoLive)),
    );
    await Effect.runPromise(sync.wait(first));

    expect(second.key).toBe(first.key);
    const events = await Effect.runPromise(sync.pull({ clientId: "client-1", key: first.key }));
    expect(events.map((event) => event._tag)).toEqual(["Item", "Item", "Complete"]);
  });

  it("stores boundary failures as sync events instead of throwing", async () => {
    const sync = makeInMemorySyncEngine(domain);

    await Effect.runPromise(
      sync
        .subscribe({
          clientId: "client-1",
          name: "watchUsers",
          args: { start: "not-a-number" },
          select: { id: true },
        })
        .pipe(Effect.provide(UserRepoLive)),
    );
    const subscriptions = await Effect.runPromise(sync.subscriptions());
    await Effect.runPromise(sync.wait(subscriptions[0]));

    const events = await Effect.runPromise(sync.pull({ clientId: "client-1" }));
    expect(events.map((event) => event._tag)).toEqual(["Failure", "Complete"]);

    const failure = events[0];
    expect(failure._tag).toBe("Failure");
    if (failure._tag !== "Failure") {
      throw new Error("expected failure event");
    }
    expect(failure.error._tag).toBe("ArgsParseError");
  });

  it("stores wrong-kind failures as sync events instead of failing the worker", async () => {
    const sync = makeInMemorySyncEngine(domain);

    await Effect.runPromise(
      sync
        .subscribe({
          clientId: "client-1",
          name: "getUser",
          args: { id: "missing" },
          select: { id: true },
        })
        .pipe(Effect.provide(UserRepoLive)),
    );
    const subscriptions = await Effect.runPromise(sync.subscriptions());
    await Effect.runPromise(sync.wait(subscriptions[0]));

    const events = await Effect.runPromise(sync.pull({ clientId: "client-1" }));
    expect(events.map((event) => event._tag)).toEqual(["Failure", "Complete"]);

    const failure = events[0];
    expect(failure._tag).toBe("Failure");
    if (failure._tag !== "Failure") {
      throw new Error("expected failure event");
    }
    expect(failure.error._tag).toBe("WrongOperationKind");
  });
});
