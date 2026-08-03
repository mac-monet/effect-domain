import { Effect, Result, Schema } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { domain } from "../examples/domain.ts";
import { webHandler } from "../examples/http-dispatch.ts";
import { rpc, RpcLive } from "../examples/rpc-dispatch.ts";

// Result.Result serializes to { _id: "Result", _tag: "Success" | "Failure", value }.
// Over the wire we work with that plain shape — Result methods need a live prototype.
type WireResult<A> =
  | { readonly _id: "Result"; readonly _tag: "Success"; readonly value: A }
  | { readonly _id: "Result"; readonly _tag: "Failure"; readonly value: unknown };
type UserWireResult = Record<string, WireResult<string>>;
const ok = <A>(r: WireResult<A>): A => {
  if (r._tag === "Failure")
    throw new Error(`Expected Success, got Failure: ${JSON.stringify(r.value)}`);
  return r.value;
};

describe("Examples: HTTP dynamic gateway via domain.dispatch", () => {
  it("POST /getUser returns the typed result tree", async () => {
    const response = await webHandler(
      new Request("http://localhost/getUser", {
        method: "POST",
        body: JSON.stringify({
          args: { id: "1" },
          select: {
            id: true,
            fullName: true,
            greeting: { args: { salutation: "Dr." } },
            profile: { select: { location: true } },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as UserWireResult & {
      readonly profile: WireResult<UserWireResult>;
    };
    expect(ok(body.id)).toBe("1");
    expect(ok(body.fullName)).toBe("Alice Anderson");
    expect(ok(body.greeting)).toBe("Dr. Alice Anderson");
    expect(ok(ok(body.profile).location)).toBe("Taipei");
  });

  it("POST /listUsers walks each row's selected fields", async () => {
    const response = await webHandler(
      new Request("http://localhost/listUsers", {
        method: "POST",
        body: JSON.stringify({
          select: { firstName: true, fullName: true },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadonlyArray<Record<string, WireResult<string>>>;
    expect(body.map((row) => ok(row.fullName))).toEqual(["Alice Anderson", "Bob Brown"]);
  });

  it("POST /createUser persists and returns the new row", async () => {
    const response = await webHandler(
      new Request("http://localhost/createUser", {
        method: "POST",
        body: JSON.stringify({
          args: { firstName: "Charlie", lastName: "Carter" },
          select: { id: true, fullName: true },
        }),
      }),
    );

    const body = (await response.json()) as Record<string, WireResult<string>>;
    expect(ok(body.fullName)).toBe("Charlie Carter");
  });

  it("POST /getUser returns 400 for invalid args", async () => {
    const response = await webHandler(
      new Request("http://localhost/getUser", {
        method: "POST",
        body: JSON.stringify({
          args: { id: 123 },
          select: { id: true },
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { readonly _tag: string; readonly operation: string };
    expect(body._tag).toBe("ArgsParseError");
    expect(body.operation).toBe("getUser");
  });

  it("POST /listUsers returns 400 for invalid select", async () => {
    const response = await webHandler(
      new Request("http://localhost/listUsers", {
        method: "POST",
        body: JSON.stringify({
          select: { users: { select: { id: true } } },
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { readonly _tag: string; readonly operation: string };
    expect(body._tag).toBe("SelectionParseError");
    expect(body.operation).toBe("listUsers");
  });

  it("POST /getUser returns 404 for typed operation failure", async () => {
    const response = await webHandler(
      new Request("http://localhost/getUser", {
        method: "POST",
        body: JSON.stringify({
          args: { id: "missing" },
          select: { id: true },
        }),
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      readonly _tag: string;
      readonly id: string;
      readonly message: string;
    };
    expect(body).toEqual({
      _tag: "UserNotFound",
      id: "missing",
      message: "User missing not found",
    });
  });

  it("404s an unknown path", async () => {
    const response = await webHandler(
      new Request("http://localhost/nope", {
        method: "POST",
        body: JSON.stringify({ select: {} }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

// In-process RPC: the handler returns live Result values. RpcTest skips
// serialization, so we keep the prototypes and use Result.getOrThrow directly.
describe("Examples: RPC dynamic gateway via domain.dispatch", () => {
  const program = Effect.gen(function* () {
    const client = rpc.clientFrom(yield* RpcTest.makeClient(rpc.group));
    const user = yield* client.execute("getUser", {
      args: { id: "1" },
      select: {
        id: true,
        fullName: true,
        greeting: { args: { salutation: "Dr." } },
        profile: { select: { location: true } },
      },
    });
    const list = yield* client.execute("listUsers", {
      select: { firstName: true },
    });
    const created = yield* client.execute("createUser", {
      args: { firstName: "Dana", lastName: "Davis" },
      select: { id: true, fullName: true },
    });
    return { user, list, created };
  });

  it("args decoding requires no services even when the resolver does", () => {
    // The boundary contract: args schemas decode pure shapes (no services),
    // services are reached only inside resolve. We can decode args via the
    // domain's own argsSchema accessor with `Effect.runSync` because R = never;
    // the resolver itself depends on UserRepo, but that requirement only
    // shows up on `domain.execute(...)`, not on the args parser.
    const argsDecoder = domain.argsSchema("getUser");
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(argsDecoder)({ id: "1" }));
    expect(decoded).toEqual({ id: "1" });
  });

  it("client roundtrips getUser, listUsers, createUser", async () => {
    const { user, list, created } = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(RpcLive))) as Effect.Effect<
        Effect.Success<typeof program>,
        never,
        never
      >,
    );

    expect(Result.getOrThrow(user.fullName)).toBe("Alice Anderson");
    expect(Result.getOrThrow(user.greeting)).toBe("Dr. Alice Anderson");
    // Nested projections are Result-wrapped at runtime; the nested projection
    // type is looser here (same cast as walker tests).
    const profile = Result.getOrThrow(user.profile) as unknown as Record<
      string,
      Result.Result<unknown, unknown>
    >;
    expect(Result.getOrThrow(profile.location)).toBe("Taipei");

    expect(list.map((r) => Result.getOrThrow(r.firstName))).toEqual(["Alice", "Bob"]);

    expect(Result.getOrThrow(created.fullName)).toBe("Dana Davis");
  });
});
