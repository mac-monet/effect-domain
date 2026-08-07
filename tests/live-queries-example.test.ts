import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeLiveQueryEngine } from "../examples/live-queries.ts";
import { Domain, node, operation } from "../src/index.ts";

interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
}

function makeFixture() {
  // Mutable in-memory store the mutations write to.
  const users = new Map<string, UserRow>([
    ["u1", { id: "u1", name: "Ada", teamId: "t1" }],
    ["u2", { id: "u2", name: "Brian", teamId: "t1" }],
  ]);

  const User = node(
    "User",
    Schema.Struct({ id: Schema.String, name: Schema.String, teamId: Schema.String }),
    {},
    { identity: "id" },
  );

  const Team = node(
    "Team",
    Schema.Struct({ id: Schema.String, members: Schema.Array(User) }),
    {},
    { identity: "id" },
  );

  const domain = Domain.make({
    getTeam: operation({
      type: Team,
      args: Schema.Struct({ id: Schema.String }),
      resolve: ({ args }) =>
        Effect.succeed({
          id: args.id,
          members: Array.from(users.values()).filter((u) => u.teamId === args.id),
        }),
    }),
    renameUser: operation({
      type: User,
      args: Schema.Struct({ id: Schema.String, name: Schema.String }),
      resolve: ({ args }) =>
        Effect.sync(() => {
          const existing = users.get(args.id);
          if (!existing) throw new Error(`no user ${args.id}`);
          const updated = { ...existing, name: args.name };
          users.set(args.id, updated);
          return updated;
        }),
    }),
  });

  return { domain, users };
}

describe("Example: live-query engine on read sets", () => {
  it("delivers an initial value and records entity dependencies", async () => {
    const { domain } = makeFixture();
    const engine = makeLiveQueryEngine(domain);

    const query = await Effect.runPromise(
      engine.subscribe({
        clientId: "c1",
        name: "getTeam",
        args: { id: "t1" },
        select: { id: true, members: { select: { name: true } } },
      }),
    );

    const events = engine.pull({ clientId: "c1" });
    expect(events.map((e) => e._tag)).toEqual(["Value"]);
    expect(Array.from(engine.dependenciesOf(query)).sort((a, b) => a.localeCompare(b))).toEqual([
      "Team:t1",
      "User:u1",
      "User:u2",
    ]);
  });

  it("invalidation re-runs only dependent queries and emits only on change", async () => {
    const { domain } = makeFixture();
    const engine = makeLiveQueryEngine(domain);

    await Effect.runPromise(
      engine.subscribe({
        clientId: "c1",
        name: "getTeam",
        args: { id: "t1" },
        select: { members: { select: { name: true } } },
      }),
    );

    // A mutation's own read set is its response-derived write-set.
    const mutated = await Effect.runPromise(
      domain.dispatch(
        { name: "renameUser", args: { id: "u1", name: "Ada L." }, select: { id: true } },
        { reads: true },
      ),
    );
    expect(mutated._tag).toBe("Success");

    // Touched entity -> dependent query re-runs and emits the new value.
    await Effect.runPromise(engine.invalidate({ node: "User", key: "u1" }));
    let events = engine.pull({ clientId: "c1" });
    expect(events.map((e) => e._tag)).toEqual(["Value", "Value"]);

    // Untouched entity -> no re-run, no event.
    await Effect.runPromise(engine.invalidate({ node: "User", key: "u999" }));
    events = engine.pull({ clientId: "c1" });
    expect(events).toHaveLength(2);

    // Touched entity but identical result -> re-run without an event.
    await Effect.runPromise(engine.invalidate({ node: "User", key: "u1" }));
    events = engine.pull({ clientId: "c1" });
    expect(events).toHaveLength(2);
  });

  it("subscribe is idempotent per client and invocation", async () => {
    const { domain } = makeFixture();
    const engine = makeLiveQueryEngine(domain);
    const request = {
      clientId: "c1",
      name: "getTeam",
      args: { id: "t1" },
      select: { id: true },
    };

    const first = await Effect.runPromise(engine.subscribe(request));
    const second = await Effect.runPromise(engine.subscribe(request));
    expect(second).toBe(first);
    expect(engine.pull({ clientId: "c1" })).toHaveLength(1);
  });

  it("cursor-based pull resumes after the last seen event", async () => {
    const { domain } = makeFixture();
    const engine = makeLiveQueryEngine(domain);

    await Effect.runPromise(
      engine.subscribe({
        clientId: "c1",
        name: "getTeam",
        args: { id: "t1" },
        select: { members: { select: { name: true } } },
      }),
    );
    const initial = engine.pull({ clientId: "c1" });
    const cursor = initial[initial.length - 1]!.seq;

    await Effect.runPromise(
      domain.execute({
        name: "renameUser",
        args: { id: "u2", name: "Brian K." },
        select: { id: true },
      }),
    );
    await Effect.runPromise(engine.invalidate({ node: "User", key: "u2" }));

    const delta = engine.pull({ clientId: "c1", after: cursor });
    expect(delta).toHaveLength(1);
    expect(delta[0]!._tag).toBe("Value");
  });
});
