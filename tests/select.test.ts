import { describe, expect, it } from "vite-plus/test";
import { DuplicateOutputKey, parseSelection, type Selection } from "../src/selection/syntax.ts";

describe("parseSelection", () => {
  it("turns true leaves into parsed field entries", () => {
    expect(parseSelection({ id: true })).toEqual([{ fieldName: "id", outputKey: "id" }]);
  });

  it("keeps args, aliases, and nested selections", () => {
    const select = { id: true } satisfies Selection;
    expect(parseSelection({ users: { alias: "admins", args: { role: "admin" }, select } })).toEqual(
      [
        {
          fieldName: "users",
          outputKey: "admins",
          args: { role: "admin" },
          select,
        },
      ],
    );
  });

  it("expands multi-entry array selections in order", () => {
    expect(
      parseSelection({
        users: [{ args: { role: "user" } }, { alias: "admins", args: { role: "admin" } }],
      }),
    ).toEqual([
      {
        fieldName: "users",
        outputKey: "users",
        args: { role: "user" },
      },
      {
        fieldName: "users",
        outputKey: "admins",
        args: { role: "admin" },
      },
    ]);
  });

  it("rejects duplicate output keys", () => {
    expect(() =>
      parseSelection({
        firstName: { alias: "name" },
        fullName: { alias: "name" },
      }),
    ).toThrow(DuplicateOutputKey);
  });
});
