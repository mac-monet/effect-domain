import { describe, expect, it } from "vite-plus/test";
import { HttpRouter } from "effect/unstable/http";
import { AppLive, webHandler } from "../examples/http-dispatch-production.ts";

const handle = webHandler as (request: Request) => Promise<Response>;

type ErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

const post = (path: string, body: unknown, init?: RequestInit) =>
  handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader-token",
        "content-type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );

const postWith = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  init?: RequestInit,
) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer reader-token",
        "content-type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );

describe("Examples: production-style HTTP dynamic gateway", () => {
  it("requires bearer auth before dispatch", async () => {
    const response = await handle(
      new Request("http://localhost/getUser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: { id: "1" }, select: { id: true } }),
      }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).error.code).toBe("Unauthorized");
  });

  it("only mounts explicitly allowed operations", async () => {
    const response = await post("/createUser", {
      args: { firstName: "Ada", lastName: "Lovelace" },
      select: { id: true },
    });

    expect(response.status).toBe(404);
  });

  it("requires json content type", async () => {
    const response = await post(
      "/getUser",
      JSON.stringify({ args: { id: "1" }, select: { id: true } }),
      {
        headers: {
          authorization: "Bearer reader-token",
          "content-type": "text/plain",
        },
      },
    );

    expect(response.status).toBe(415);
    expect(((await response.json()) as ErrorBody).error.code).toBe("UnsupportedMediaType");
  });

  it("redacts invalid json details", async () => {
    const response = await post("/getUser", "{");

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toEqual({
      code: "InvalidPayload",
      message: "Request body must be a dispatch payload.",
    });
  });

  it("rejects non-object json bodies before dispatch", async () => {
    const response = await post("/getUser", "null");

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error).toEqual({
      code: "InvalidPayload",
      message: "Request body must be a dispatch payload.",
    });
  });

  it("enforces selection depth limits before dispatch", async () => {
    const response = await post("/getUser", {
      args: { id: "1" },
      select: {
        profile: {
          select: {
            location: true,
          },
        },
      },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe("SelectionLimitExceeded");
  });

  it("enforces selection field-count limits before dispatch", async () => {
    const response = await post("/getUser", {
      args: { id: "1" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        greeting: { args: { salutation: "Dr." } },
        profile: { select: { bio: true, location: true } },
      },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe("SelectionLimitExceeded");
  });

  it("caches successful dynamic dispatch responses by canonical invocation", async () => {
    const { dispose, handler } = HttpRouter.toWebHandler(AppLive, {
      disableLogger: true,
    });
    const isolatedHandle = handler as (request: Request) => Promise<Response>;
    const body = {
      args: { id: "1" },
      select: { id: true, fullName: true },
    };

    try {
      const miss = await postWith(isolatedHandle, "/getUser", body);
      const hit = await postWith(isolatedHandle, "/getUser", {
        select: { fullName: true, id: true },
        args: { id: "1" },
      });

      expect(miss.status).toBe(200);
      expect(miss.headers.get("x-domain-cache")).toBe("MISS");
      expect(miss.headers.get("cache-control")).toBe("private, max-age=30");
      expect(hit.status).toBe(200);
      expect(hit.headers.get("x-domain-cache")).toBe("HIT");
    } finally {
      await dispose();
    }
  });

  it("redacts operation errors", async () => {
    const response = await post("/getUser", {
      args: { id: "missing" },
      select: { id: true },
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toEqual({
      code: "NotFound",
      message: "The requested resource was not found.",
    });
  });
});
