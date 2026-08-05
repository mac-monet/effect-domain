import { describe, expect, it } from "vite-plus/test";
import type { UserNotFound } from "../examples/domain.ts";
import { webHandler } from "../examples/http-api.ts";

describe("Example: HttpApi via domain.bind", () => {
  it("GET /users/1 returns the user detail route's selected result tree", async () => {
    const response = await webHandler(new Request("http://localhost/users/1"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly id: string;
      readonly fullName: string;
      readonly profile: {
        readonly location: string;
      };
    };
    expect(body.id).toBe("1");
    expect(body.fullName).toBe("Alice Anderson");
    expect(body.profile.location).toBe("Taipei");
  });

  it("GET /users/1/card returns another fixed route shape from the same domain operation", async () => {
    const response = await webHandler(new Request("http://localhost/users/1/card"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly id: string;
      readonly greeting: string;
      readonly profile: {
        readonly bio: string;
      };
      readonly fullName?: string;
    };
    expect(body.id).toBe("1");
    expect(body.greeting).toBe("Dr. Alice Anderson");
    expect(body.profile.bio).toBe("Maintains the domain gateway");
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
    const body = (await response.json()) as Record<string, string>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.fullName).toBe("Grace Hopper");
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
