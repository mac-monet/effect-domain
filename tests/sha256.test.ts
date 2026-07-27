import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { sha256Hex } from "../src/internal/sha256.ts";

function referenceHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("sha256Hex", () => {
  it("matches FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto across message lengths spanning block boundaries", () => {
    // 55→56 is the one-block→two-block padding boundary, 119→120 the
    // two→three-block boundary; 63/64/65 straddle a block-aligned length;
    // longer inputs exercise multi-block processing.
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 10_000]) {
      const input = "a".repeat(length);
      expect(sha256Hex(input)).toBe(referenceHex(input));
    }
  });

  it("matches node:crypto for arbitrary unicode strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 500 }), (input) => {
        expect(sha256Hex(input)).toBe(referenceHex(input));
      }),
    );
  });

  it("matches node:crypto for canonical invocation JSON shapes", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const input = JSON.stringify(value);
        expect(sha256Hex(input)).toBe(referenceHex(input));
      }),
    );
  });
});
