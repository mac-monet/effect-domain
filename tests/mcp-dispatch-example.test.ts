import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { mcp } from "../examples/mcp-dispatch.ts";

const callTool = (name: string, params: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* mcp.toolkit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool names are runtime-derived
    const results = yield* Stream.runCollect(yield* toolkit.handle(name as never, params as any));
    const final = results.find((r) => !r.preliminary);
    if (final === undefined) throw new Error("tool call emitted no final result");
    return final;
  }).pipe(Effect.provide(mcp.handlersLayer));

describe("Examples: MCP adapter", () => {
  it("exposes one tool per non-stream operation", async () => {
    const toolkit = await Effect.runPromise(Effect.provide(mcp.toolkit, mcp.handlersLayer));
    expect(Object.keys(toolkit.tools).sort()).toEqual(["createUser", "getUser", "listUsers"]);
  });

  it("executes an operation with a selection", async () => {
    const result = await Effect.runPromise(
      callTool("getUser", { args: { id: "1" }, select: { id: true, fullName: true } }),
    );
    expect(result.isFailure).toBe(false);
    // Projection results are plain data — no per-field Result wrapping.
    expect(result.result).toEqual({
      id: "1",
      fullName: "Alice Anderson",
    });
  });

  it("returns typed operation errors as tool failures", async () => {
    const result = await Effect.runPromise(
      callTool("getUser", { args: { id: "missing" }, select: { id: true } }),
    );
    expect(result.isFailure).toBe(true);
    expect(result.result).toMatchObject({
      _tag: "OperationError",
      cause: { _tag: "UserNotFound", id: "missing" },
    });
  });
});
