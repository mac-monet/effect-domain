import { describe, expect, it } from "vite-plus/test";
import { webHandler } from "../examples/http-stream.ts";

type WireResult<A> = {
  readonly _tag: "Success";
  readonly success: A;
};

describe("Example: HTTP stream via domain.bindSubscriptions", () => {
  it("GET /users/stream/10 returns projected NDJSON stream items", async () => {
    const response = await webHandler(new Request("http://localhost/users/stream/10"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");

    const lines = (await response.text()).trim().split("\n");
    const users = lines.map((line) => JSON.parse(line) as Record<string, WireResult<string>>);

    expect(users).toHaveLength(2);
    expect(users[0].id.success).toBe("10");
    expect(users[0].fullName.success).toBe("Stream One");
    expect(users[1].id.success).toBe("11");
    expect(users[1].fullName.success).toBe("Stream Two");
  });
});
