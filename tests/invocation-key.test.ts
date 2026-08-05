import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  canonicalizeSelection,
  field,
  Domain,
  invocationKey,
  node,
  operation,
  selectionsEqual,
} from "../src/index.ts";

const User = node(
  "User",
  Schema.Struct({ id: Schema.String, firstName: Schema.String, lastName: Schema.String }),
  {
    fullName: field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
  },
);

const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String, opts: Schema.optional(Schema.Unknown) }),
    resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
  }),
});

function reverseKeysDeep(value: fc.JsonValue): fc.JsonValue {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, fc.JsonValue>;
    const out: Record<string, fc.JsonValue> = Object.create(null) as Record<string, fc.JsonValue>;
    for (const key of Object.keys(value).reverse()) {
      out[key] = reverseKeysDeep(obj[key]!);
    }
    return out;
  }
  return value;
}

const jsonObject = fc
  .jsonValue({ maxDepth: 4 })
  .filter((value) => value !== null && typeof value === "object" && !Array.isArray(value))
  .map((value) => value as Record<string, fc.JsonValue>);

const selectionLeaf = fc.constantFrom(true, [true], { select: {} });
const selectionWithShuffledKeys = fc
  .uniqueArray(
    fc.tuple(
      fc.constantFrom("id", "firstName", "lastName", "fullName", "profile", "posts"),
      selectionLeaf,
    ),
    { minLength: 0, maxLength: 5, selector: ([key]) => key },
  )
  .map((entries) => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const [key, value] of entries) a[key] = value;
    for (const [key, value] of [...entries].reverse()) b[key] = value;
    return [a, b] as const;
  });

describe("invocationKey — canonicalization", () => {
  it("is deterministic for the same input", () => {
    const k1 = invocationKey({ name: "x", args: { id: "1" }, select: { id: true } });
    const k2 = invocationKey({ name: "x", args: { id: "1" }, select: { id: true } });
    expect(k1).toBe(k2);
  });

  it("is 16 hex chars", () => {
    const key = invocationKey({ name: "x", args: { id: "1" }, select: { id: true } });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("can use longer digest byte lengths for durable identities", () => {
    const invocation = { name: "x", args: { id: "1" }, select: { id: true } };
    const compact = invocationKey(invocation);
    const durable = invocationKey(invocation, { bytes: 16 });
    const full = invocationKey(invocation, { bytes: 32 });

    expect(durable).toMatch(/^[0-9a-f]{32}$/);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    expect(durable.startsWith(compact)).toBe(true);
    expect(full.startsWith(durable)).toBe(true);
  });

  it("rejects unsupported digest byte lengths", () => {
    const invocation = { name: "x", args: { id: "1" } };
    for (const bytes of [0, 7, 33, 8.5, Number.NaN]) {
      expect(() => invocationKey(invocation, { bytes })).toThrow(RangeError);
    }
  });

  it("is stable across shuffled select key order", () => {
    const k1 = invocationKey({ name: "x", select: { id: true, firstName: true } });
    const k2 = invocationKey({ name: "x", select: { firstName: true, id: true } });
    expect(k1).toBe(k2);
  });

  it("is stable across shuffled args key order (recursively)", () => {
    const k1 = invocationKey({ name: "x", args: { a: { x: 1, y: 2 }, b: 3 } });
    const k2 = invocationKey({ name: "x", args: { b: 3, a: { y: 2, x: 1 } } });
    expect(k1).toBe(k2);
  });

  it("collapses [true] to true", () => {
    const k1 = invocationKey({ name: "x", select: { id: [true] } });
    const k2 = invocationKey({ name: "x", select: { id: true } });
    expect(k1).toBe(k2);
  });

  it("collapses [{ alias, args, select }] to its bare form", () => {
    const k1 = invocationKey({
      name: "x",
      select: { users: [{ alias: "admins", args: { role: "admin" }, select: { id: true } }] },
    });
    const k2 = invocationKey({
      name: "x",
      select: { users: { alias: "admins", args: { role: "admin" }, select: { id: true } } },
    });
    expect(k1).toBe(k2);
  });

  it("sorts multi-alias array entries by alias", () => {
    const k1 = invocationKey({
      name: "x",
      select: {
        users: [
          { args: { role: "admin" }, alias: "admins", select: { id: true } },
          { args: { role: "user" }, alias: "users", select: { id: true } },
        ],
      },
    });
    const k2 = invocationKey({
      name: "x",
      select: {
        users: [
          { args: { role: "user" }, alias: "users", select: { id: true } },
          { args: { role: "admin" }, alias: "admins", select: { id: true } },
        ],
      },
    });
    expect(k1).toBe(k2);
  });

  it("treats select: {} and absent select as equal", () => {
    const k1 = invocationKey({ name: "x" });
    const k2 = invocationKey({ name: "x", select: {} });
    expect(k1).toBe(k2);
  });

  it("keeps nested select: {} distinct from true (they produce different data)", () => {
    // `{ select: {} }` projects the value to `{}`; `true` passes it through
    // raw — same key would alias two different results in idempotency stores
    // and the response-codec cache.
    const k1 = invocationKey({ name: "x", select: { profile: { select: {} } } });
    const k2 = invocationKey({ name: "x", select: { profile: true } });
    expect(k1).not.toBe(k2);
  });

  it("does NOT collapse args: {} and undefined", () => {
    const k1 = invocationKey({ name: "x" });
    const k2 = invocationKey({ name: "x", args: {} });
    expect(k1).not.toBe(k2);
  });

  it("differs when name changes", () => {
    const k1 = invocationKey({ name: "x", select: { id: true } });
    const k2 = invocationKey({ name: "y", select: { id: true } });
    expect(k1).not.toBe(k2);
  });

  it("differs when args differ semantically", () => {
    const k1 = invocationKey({ name: "x", args: { id: "1" } });
    const k2 = invocationKey({ name: "x", args: { id: "2" } });
    expect(k1).not.toBe(k2);
  });

  it("differs when select differs semantically", () => {
    const k1 = invocationKey({ name: "x", select: { id: true } });
    const k2 = invocationKey({ name: "x", select: { firstName: true } });
    expect(k1).not.toBe(k2);
  });

  it("differs when alias differs", () => {
    const k1 = invocationKey({ name: "x", select: { id: { alias: "a" } } });
    const k2 = invocationKey({ name: "x", select: { id: { alias: "b" } } });
    expect(k1).not.toBe(k2);
  });

  it("preserves Date / URL via JSON.stringify's toJSON contract", () => {
    const k1 = invocationKey({ name: "x", args: { at: new Date("2024-01-01T00:00:00Z") } });
    const k2 = invocationKey({ name: "x", args: { at: new Date("2099-01-01T00:00:00Z") } });
    expect(k1).not.toBe(k2);
    const k3 = invocationKey({ name: "x", args: { url: new URL("https://example.com/a") } });
    const k4 = invocationKey({ name: "x", args: { url: new URL("https://example.com/b") } });
    expect(k3).not.toBe(k4);
  });

  it("property: is stable across recursive args key order", () => {
    fc.assert(
      fc.property(jsonObject, (args) => {
        expect(invocationKey({ name: "x", args })).toBe(
          invocationKey({ name: "x", args: reverseKeysDeep(args) }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("property: is stable across selection key order", () => {
    fc.assert(
      fc.property(selectionWithShuffledKeys, ([a, b]) => {
        expect(invocationKey({ name: "x", select: a })).toBe(
          invocationKey({ name: "x", select: b }),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("selectionsEqual — structural compare", () => {
  it("agrees with invocationKey on equivalent selections", () => {
    const a = { id: true, firstName: true };
    const b = { firstName: true, id: true };
    expect(selectionsEqual(a, b)).toBe(true);
    expect(invocationKey({ name: "x", select: a })).toBe(invocationKey({ name: "x", select: b }));
  });

  it("collapses [true] vs true", () => {
    expect(selectionsEqual({ id: [true] }, { id: true })).toBe(true);
  });

  it("treats {} as absent", () => {
    expect(selectionsEqual({}, undefined)).toBe(true);
  });

  it("treats undefined object entries as absent", () => {
    expect(selectionsEqual({ id: undefined }, undefined)).toBe(true);
    expect(invocationKey({ name: "x", select: { id: undefined } })).toBe(
      invocationKey({ name: "x" }),
    );
  });

  it("agrees on multi-alias arrays in different order", () => {
    const a = {
      users: [
        { alias: "admins", args: { role: "admin" } },
        { alias: "users", args: { role: "user" } },
      ],
    };
    const b = {
      users: [
        { alias: "users", args: { role: "user" } },
        { alias: "admins", args: { role: "admin" } },
      ],
    };
    expect(selectionsEqual(a, b)).toBe(true);
  });

  it("returns false for semantically different selections", () => {
    expect(selectionsEqual({ id: true }, { id: { alias: "renamed" } })).toBe(false);
    expect(selectionsEqual({ id: true }, { firstName: true })).toBe(false);
  });

  it("property: agrees with invocationKey for generated equivalent selections", () => {
    fc.assert(
      fc.property(selectionWithShuffledKeys, ([a, b]) => {
        expect(selectionsEqual(a, b)).toBe(true);
        expect(invocationKey({ name: "x", select: a })).toBe(
          invocationKey({ name: "x", select: b }),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("domain.invocationKey + domain.selectionsEqual", () => {
  it("domain.invocationKey delegates to the standalone helper", () => {
    const direct = invocationKey({ name: "getUser", args: { id: "1" }, select: { id: true } });
    const fromGraph = domain.invocationKey({
      name: "getUser",
      args: { id: "1" },
      select: { id: true },
    });
    expect(fromGraph).toBe(direct);
  });

  it("domain.invocationKey delegates byte-length options", () => {
    const invocation = { name: "getUser", args: { id: "1" }, select: { id: true } };
    expect(domain.invocationKey(invocation, { bytes: 16 })).toBe(
      invocationKey(invocation, { bytes: 16 }),
    );
  });

  it("domain.selectionsEqual delegates to the standalone helper", () => {
    expect(
      domain.selectionsEqual({ id: true, firstName: true }, { firstName: true, id: true }),
    ).toBe(true);
    expect(domain.selectionsEqual({ id: true }, { firstName: true })).toBe(false);
  });
});

describe("canonicalizeSelection", () => {
  it("returns undefined for empty / non-object inputs", () => {
    expect(canonicalizeSelection({})).toBeUndefined();
    expect(canonicalizeSelection(undefined)).toBeUndefined();
    expect(canonicalizeSelection(null)).toBeUndefined();
    expect(canonicalizeSelection("not-an-object")).toBeUndefined();
  });

  it("preserves nested { select: {} } (not equivalent to true)", () => {
    const out = canonicalizeSelection({ profile: { select: {} } });
    expect(out).toEqual({ profile: { select: {} } });
  });

  it("property: canonicalization is idempotent", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const once = canonicalizeSelection(value);
        expect(canonicalizeSelection(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});

// Two surface forms that canonicalize identically to `true`; mixing them
// freely across two/three renderings of the same field set yields equivalent
// selections by construction. (`{ select: {} }` is deliberately NOT
// equivalent: it projects to `{}` where `true` passes the value through.)
const equivalentLeafForms = fc.constantFrom<unknown>(true, [true]);
const selectionFieldNames = fc.constantFrom("id", "firstName", "lastName", "fullName", "posts");

const equivalentSelectionTriple = fc
  .uniqueArray(
    fc.tuple(selectionFieldNames, equivalentLeafForms, equivalentLeafForms, equivalentLeafForms),
    { minLength: 0, maxLength: 5, selector: ([key]) => key },
  )
  .map((entries) => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    for (const [key, formA] of entries) a[key] = formA;
    for (const [key, , formB] of [...entries].reverse()) b[key] = formB;
    for (const [key, , , formC] of entries) c[key] = formC;
    return [a, b, c] as const;
  });

const arbitrarySelection = fc
  .uniqueArray(fc.tuple(selectionFieldNames, equivalentLeafForms), {
    minLength: 0,
    maxLength: 5,
    selector: ([key]) => key,
  })
  .map((entries) => {
    const out: Record<string, unknown> = {};
    for (const [key, form] of entries) out[key] = form;
    return out;
  });

describe("selectionsEqual — equivalence laws", () => {
  it("property: reflexive", () => {
    fc.assert(
      fc.property(arbitrarySelection, (s) => {
        expect(selectionsEqual(s, s)).toBe(true);
      }),
    );
  });

  it("property: symmetric", () => {
    fc.assert(
      fc.property(arbitrarySelection, arbitrarySelection, (a, b) => {
        expect(selectionsEqual(a, b)).toBe(selectionsEqual(b, a));
      }),
    );
  });

  it("property: equivalent surface forms are pairwise equal (transitivity witness)", () => {
    fc.assert(
      fc.property(equivalentSelectionTriple, ([a, b, c]) => {
        expect(selectionsEqual(a, b)).toBe(true);
        expect(selectionsEqual(b, c)).toBe(true);
        expect(selectionsEqual(a, c)).toBe(true);
      }),
    );
  });

  it("property: selectionsEqual agrees with invocationKey equality in both directions", () => {
    fc.assert(
      fc.property(arbitrarySelection, arbitrarySelection, (a, b) => {
        const keyA = invocationKey({ name: "op", select: a });
        const keyB = invocationKey({ name: "op", select: b });
        expect(selectionsEqual(a, b)).toBe(keyA === keyB);
      }),
    );
  });
});

describe("invocationKey — digest laws", () => {
  it("property: shorter digests are prefixes of longer digests", () => {
    fc.assert(
      fc.property(arbitrarySelection, jsonObject, (select, args) => {
        const invocation = { name: "op", args, select };
        const short = invocationKey(invocation, { bytes: 8 });
        const medium = invocationKey(invocation, { bytes: 16 });
        const long = invocationKey(invocation, { bytes: 32 });
        expect(long.startsWith(medium)).toBe(true);
        expect(medium.startsWith(short)).toBe(true);
        expect(short).toHaveLength(16);
        expect(medium).toHaveLength(32);
        expect(long).toHaveLength(64);
      }),
    );
  });

  it("property: canonicalized selection is a fixpoint of canonicalization", () => {
    fc.assert(
      fc.property(arbitrarySelection, (s) => {
        const once = canonicalizeSelection(s);
        expect(canonicalizeSelection(once)).toEqual(once);
        expect(selectionsEqual(once, s)).toBe(true);
      }),
    );
  });
});
