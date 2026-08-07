import { Effect, Schema } from "effect";
import { RpcTest } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";
import { domain } from "../examples/domain.ts";
import { webHandler } from "../examples/http-dispatch.ts";
import { rpc, RpcLive } from "../examples/rpc-dispatch.ts";

// The HTTP example encodes every response with dispatchResultSchemaDynamic.
// Only the operation-level envelope is wrapped:
// { _tag: "Success", success } | { _tag: "Failure", failure } — the success
// payload itself is the plain selected data tree.
type WireResult<A> =
  | { readonly _tag: "Success"; readonly success: A }
  | { readonly _tag: "Failure"; readonly failure: unknown };
type UserWire = Record<string, string>;
const ok = <A>(r: WireResult<A>): A => {
  if (r._tag === "Failure")
    throw new Error(`Expected Success, got Failure: ${JSON.stringify(r.failure)}`);
  return r.success;
};
const failed = (r: WireResult<unknown>): unknown => {
  if (r._tag === "Success")
    throw new Error(`Expected Failure, got Success: ${JSON.stringify(r.success)}`);
  return r.failure;
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
    const body = (await response.json()) as WireResult<UserWire & { readonly profile: UserWire }>;
    const user = ok(body);
    expect(user.id).toBe("1");
    expect(user.fullName).toBe("Alice Anderson");
    expect(user.greeting).toBe("Dr. Alice Anderson");
    expect(user.profile.location).toBe("Taipei");
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
    const body = (await response.json()) as WireResult<ReadonlyArray<UserWire>>;
    expect(ok(body).map((row) => row.fullName)).toEqual(["Alice Anderson", "Bob Brown"]);
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

    const body = (await response.json()) as WireResult<UserWire>;
    expect(ok(body).fullName).toBe("Charlie Carter");
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
    const body = (await response.json()) as WireResult<never>;
    expect(failed(body)).toMatchObject({ _tag: "ArgsParseError", operation: "getUser" });
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
    const body = (await response.json()) as WireResult<never>;
    expect(failed(body)).toMatchObject({ _tag: "SelectionParseError", operation: "listUsers" });
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
    const body = (await response.json()) as WireResult<never>;
    expect(failed(body)).toMatchObject({
      _tag: "OperationError",
      operation: "getUser",
      cause: { _tag: "UserNotFound", id: "missing" },
    });
  });

  it("returns 400 for a literal null JSON body", async () => {
    const response = await webHandler(
      new Request("http://localhost/getUser", { method: "POST", body: "null" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as WireResult<never>;
    expect(failed(body)).toMatchObject({ _tag: "ArgsParseError", operation: "getUser" });
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

// In-process RPC: the handler returns plain projected data trees.
describe("Examples: RPC dynamic gateway via domain.dispatch", () => {
  const program = Effect.gen(function* () {
    const client = rpc.clientFrom(yield* RpcTest.makeClient(rpc.group));
    const user = yield* client.execute({
      name: "getUser",
      args: { id: "1" },
      select: {
        id: true,
        fullName: true,
        greeting: { args: { salutation: "Dr." } },
        profile: { select: { location: true } },
      },
    });
    const list = yield* client.execute({ name: "listUsers", select: { firstName: true } });
    const created = yield* client.execute({
      name: "createUser",
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

    expect(user.fullName).toBe("Alice Anderson");
    expect(user.greeting).toBe("Dr. Alice Anderson");
    expect(user.profile.location).toBe("Taipei");

    expect(list.map((r) => r.firstName)).toEqual(["Alice", "Bob"]);

    expect(created.fullName).toBe("Dana Davis");
  });
});
