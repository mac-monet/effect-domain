import { Effect, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  domain,
  makePersistenceLive,
  type PersistenceStats,
  UserNotFound,
} from "../examples/persistence-backed.ts";

const stats = (): PersistenceStats => ({
  profileJoins: 0,
  organizationBatchCalls: 0,
  lastOrganizationAccountIds: [],
});

describe("Examples: persistence-backed domain", () => {
  it("returns a semantic user assembled from normalized rows", async () => {
    const observed = stats();
    const result = await Effect.runPromise(
      domain
        .execute("getUser", {
          args: { id: "acct_1" },
          select: { id: true, email: true, displayName: true },
        })
        .pipe(Effect.provide(makePersistenceLive(observed))),
    );

    expect(result.id).toBe("acct_1");
    expect(result.email).toBe("ada@example.com");
    expect(result.displayName).toBe("Ada Lovelace");
    expect(observed.profileJoins).toBe(1);
    expect(observed.organizationBatchCalls).toBe(0);
  });

  it("batches relation-like fields across listed users", async () => {
    const observed = stats();
    const result = await Effect.runPromise(
      domain
        .execute("listUsers", {
          select: {
            displayName: true,
            organization: { select: { name: true } },
          },
        })
        .pipe(Effect.provide(makePersistenceLive(observed))),
    );

    expect(result.map((user) => user.displayName)).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(result.map((user) => user.organization.name)).toEqual([
      "Analytical Engines",
      "Analytical Engines",
    ]);
    expect(observed.organizationBatchCalls).toBe(1);
    expect(observed.lastOrganizationAccountIds).toEqual(["acct_1", "acct_2"]);
  });

  it("keeps persistence failures in the operation error channel", async () => {
    const observed = stats();
    const exit = await Effect.runPromiseExit(
      domain
        .execute("getUser", {
          args: { id: "missing" },
          select: { id: true },
        })
        .pipe(Effect.provide(makePersistenceLive(observed))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("UserNotFound");
    }
  });

  it("surfaces typed persistence errors through dynamic dispatch", async () => {
    const observed = stats();
    const result = await Effect.runPromise(
      domain
        .dispatch({
          name: "getUser",
          args: { id: "missing" },
          select: { id: true },
        })
        .pipe(Effect.provide(makePersistenceLive(observed))),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.cause).toBeInstanceOf(UserNotFound);
    }
  });
});
