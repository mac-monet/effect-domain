import { Effect, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { domain, UserRepoLive } from "../examples/domain.ts";

describe("Domain.prepareDispatch", () => {
  it("decodes and analyzes a dynamic invocation before execution", async () => {
    const prepared = await Effect.runPromise(
      domain.prepareDispatch({
        name: "getUser",
        args: { id: "1" },
        select: {
          id: true,
          profile: { select: { location: true } },
        },
      }),
    );

    expect(prepared.name).toBe("getUser");
    expect(prepared.analysis.depth).toBe(2);
    expect(prepared.analysis.fieldCount).toBe(3);
    expect(prepared.analysis.fields.map((field) => field.path.join("."))).toEqual([
      "id",
      "profile",
      "profile.location",
    ]);
    expect(prepared.invocationKey).toBe(
      domain.invocationKey({
        name: "getUser",
        args: { id: "1" },
        select: {
          id: true,
          profile: { select: { location: true } },
        },
      }),
    );

    const result = await Effect.runPromise(prepared.execute().pipe(Effect.provide(UserRepoLive)));
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("uses custom invocation key byte length when preparing dispatch", async () => {
    const invocation = {
      name: "getUser",
      args: { id: "1" },
      select: { id: true },
    } as const;
    const prepared = await Effect.runPromise(domain.prepareDispatch(invocation, { bytes: 16 }));

    expect(prepared.invocationKey).toBe(domain.invocationKey(invocation, { bytes: 16 }));
    expect(prepared.invocationKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("fails during preparation without running resolvers when args are invalid", async () => {
    const exit = await Effect.runPromiseExit(
      domain.prepareDispatch({
        name: "getUser",
        args: { id: 123 },
        select: { id: true },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("ArgsParseError");
    }
  });

  it("exposes operation names without reading raw operation internals", () => {
    expect(domain.operationNames()).toEqual(["getUser", "listUsers", "createUser"]);
    expect(domain.subscriptionNames()).toEqual(["watchUsers"]);
  });

  it("can analyze already-validated selections directly", () => {
    const analysis = domain.analyzeSelection({
      id: true,
      profile: { select: { bio: true } },
    });

    expect(analysis.depth).toBe(2);
    expect(analysis.fieldCount).toBe(3);
  });

  it("counts aliased array selections by output path", async () => {
    const prepared = await Effect.runPromise(
      domain.prepareDispatch({
        name: "getUser",
        args: { id: "1" },
        select: {
          greeting: [
            { alias: "formalGreeting", args: { salutation: "Dr." } },
            { alias: "casualGreeting", args: { salutation: "Hi" } },
          ],
          profile: [
            { alias: "publicProfile", select: { bio: true } },
            { alias: "privateProfile", select: { location: true } },
          ],
        },
      }),
    );

    expect(prepared.analysis.depth).toBe(2);
    expect(prepared.analysis.fieldCount).toBe(6);
    expect(
      prepared.analysis.fields
        .map((field) => ({
          path: field.path.join("."),
          fieldName: field.fieldName,
          outputKey: field.outputKey,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual(
      [
        { path: "casualGreeting", fieldName: "greeting", outputKey: "casualGreeting" },
        { path: "formalGreeting", fieldName: "greeting", outputKey: "formalGreeting" },
        { path: "privateProfile", fieldName: "profile", outputKey: "privateProfile" },
        { path: "privateProfile.location", fieldName: "location", outputKey: "location" },
        { path: "publicProfile", fieldName: "profile", outputKey: "publicProfile" },
        { path: "publicProfile.bio", fieldName: "bio", outputKey: "bio" },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });
});
