import { describe, expect, it } from "vite-plus/test";
import type { UserNotFound } from "../examples/domain.ts";
import { webHandler } from "../examples/http-api.ts";

type WireResult<A> = {
  readonly _tag: "Success";
  readonly success: A;
};
type WireFailure = {
  readonly _tag: "Failure";
  readonly failure: unknown;
};
type WireField<A> = WireResult<A> | WireFailure;

describe("Example: HttpApi via domain.bind", () => {
  it("GET /users/1 returns the user detail route's selected result tree", async () => {
    const response = await webHandler(new Request("http://localhost/users/1"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly id: WireResult<string>;
      readonly fullName: WireResult<string>;
      readonly profile: WireResult<{
        readonly location: WireResult<string>;
      }>;
    };
    expect(body.id.success).toBe("1");
    expect(body.fullName.success).toBe("Alice Anderson");
    expect(body.profile.success.location.success).toBe("Taipei");
  });

  it("GET /users/1/card returns another fixed route shape from the same domain operation", async () => {
    const response = await webHandler(new Request("http://localhost/users/1/card"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly id: WireResult<string>;
      readonly greeting: WireResult<string>;
      readonly profile: WireResult<{
        readonly bio: WireResult<string>;
      }>;
      readonly fullName?: WireField<string>;
    };
    expect(body.id.success).toBe("1");
    expect(body.greeting.success).toBe("Dr. Alice Anderson");
    expect(body.profile.success.bio.success).toBe("Maintains the domain gateway");
    expect(body.fullName).toBeUndefined();
  });

  it("POST /users creates and returns the summary route's selected result tree", async () => {
    const response = await webHandler(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Grace",
          lastName: "Hopper",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, WireResult<string>>;
    expect(body.id.success).toEqual(expect.any(String));
    expect(body.fullName.success).toBe("Grace Hopper");
  });

  it("GET /users/missing returns the endpoint's HTTP error shape", async () => {
    const response = await webHandler(new Request("http://localhost/users/missing"));

    expect(response.status).toBe(404);
    const body = (await response.json()) as UserNotFound;
    expect(body).toEqual({
      _tag: "UserNotFound",
      id: "missing",
      message: "User missing not found",
    });
  });
});
