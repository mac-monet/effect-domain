import { createServer } from "node:http";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Domain } from "../../src/index.ts";
import { domain, KSBioUnavailable, KSUserNotFound, makeLive } from "./domain.ts";

const liveDomain = domain.provide(makeLive());

describe("kitchen sink: in-process client", () => {
  const client = Domain.client(liveDomain);

  it("round-trips a deep selection through the wire codec", async () => {
    const user = await Effect.runPromise(
      client.execute({
        name: "getUser",
        args: { id: "u1" },
        select: {
          fullName: true,
          posts: {
            select: {
              title: true,
              editor: { select: { firstName: true } },
              comments: { select: { body: true, author: { select: { id: true } } } },
            },
          },
        },
      }),
    );

    expect(user.fullName).toBe("Ada Lovelace");
    const p1 = user.posts.find((p) => p.title === "Engines")!;
    expect(p1.editor).toEqual({ firstName: "Grace" });
    expect(p1.comments.map((c) => c.author)).toEqual([{ id: "u2" }, { id: "u3" }]);
    const p3 = user.posts.find((p) => p.title === "Machines")!;
    expect(p3.editor).toBeNull();
  });

  it("decodes a declared operation error to a class instance", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        client.execute({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
      ),
    );
    expect(error).toBeInstanceOf(KSUserNotFound);
    expect((error as KSUserNotFound).id).toBe("missing");
  });

  it("surfaces a mid-depth field error as the operation's error", async () => {
    // bio fails for u3 only — reached via listUsers, two levels into the walk.
    const error = await Effect.runPromise(
      Effect.flip(client.execute({ name: "listUsers", select: { id: true, bio: true } })),
    );
    expect(error).toBeInstanceOf(KSBioUnavailable);
    expect((error as KSBioUnavailable).userId).toBe("u3");
  });

  it("mirrors the array overload over the wire codec", async () => {
    const [user, count] = await Effect.runPromise(
      client.execute([
        {
          name: "getUser",
          args: { id: "u2" },
          select: { fullName: true, posts: { select: { title: true } } },
        },
        { name: "countUsers" },
      ]),
    );
    expect(user).toEqual({ fullName: "Grace Hopper", posts: [{ title: "Compilers" }] });
    expect(count).toBe(3);
  });

  it("streams a subscription with a projected selection through the wire codec", async () => {
    const items = await Effect.runPromise(
      Stream.runCollect(
        client.subscribe({
          name: "watchPosts",
          args: { authorId: "u2" },
          select: { title: true, author: { select: { fullName: true } } },
        }),
      ),
    );
    expect(Array.from(items)).toEqual([
      { title: "Compilers", author: { fullName: "Grace Hopper" } },
    ]);
  });
});

describe("kitchen sink: HTTP client against a real server", () => {
  // Minimal real HTTP server: handleDispatch is the entire pipeline.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      // Any failure (bad JSON, defect) must still end the response or the
      // client fetch hangs until the test timeout.
      Promise.resolve()
        .then(() => Effect.runPromise(liveDomain.handleDispatch(JSON.parse(body))))
        .then((encoded) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(encoded));
        })
        .catch(() => {
          res.statusCode = 500;
          res.end("{}");
        });
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}/rpc`);
    });
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const httpClient = async () => Domain.client(domain, Domain.transportHttp(await url));

  it("round-trips a deep selection over real HTTP", async () => {
    const client = await httpClient();
    const user = await Effect.runPromise(
      client.execute({
        name: "getUser",
        args: { id: "u1" },
        select: { fullName: true, posts: { select: { author: { select: { fullName: true } } } } },
      }),
    );
    expect(user.fullName).toBe("Ada Lovelace");
    expect(user.posts.map((p) => p.author)).toEqual([
      { fullName: "Ada Lovelace" },
      { fullName: "Ada Lovelace" },
    ]);
  });

  it("decodes declared errors carried over real HTTP", async () => {
    const client = await httpClient();
    const error = await Effect.runPromise(
      Effect.flip(
        client.execute({ name: "getUser", args: { id: "missing" }, select: { id: true } }),
      ),
    );
    expect(error).toBeInstanceOf(KSUserNotFound);
  });
});
