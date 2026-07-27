import { Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ResultCodec } from "../src/index.ts";

class BoomError extends Schema.TaggedErrorClass<BoomError>()("BoomError", {
  message: Schema.String,
}) {}

describe("ResultCodec (Schema.Result)", () => {
  const Codec = ResultCodec(Schema.Number, BoomError);

  it("encodes Result.success to the tagged Success wire shape", () => {
    const wire = Schema.encodeUnknownSync(Codec)(Result.succeed(42));
    expect(wire).toEqual({ _tag: "Success", success: 42 });
  });

  it("encodes Result.failure to the tagged Failure wire shape", () => {
    const wire = Schema.encodeUnknownSync(Codec)(Result.fail(new BoomError({ message: "x" })));
    expect(wire).toEqual({
      _tag: "Failure",
      failure: { _tag: "BoomError", message: "x" },
    });
  });

  it("decodes a Success wire payload back to a live Result.Success", () => {
    const decoded = Schema.decodeUnknownSync(Codec)({ _tag: "Success", success: 7 });
    expect(Result.isSuccess(decoded)).toBe(true);
    expect(Result.isFailure(decoded)).toBe(false);
    expect(Result.getOrThrow(decoded)).toBe(7);
  });

  it("decodes a Failure wire payload back to a live Result.Failure", () => {
    const decoded = Schema.decodeUnknownSync(Codec)({
      _tag: "Failure",
      failure: { _tag: "BoomError", message: "kaboom" },
    });
    expect(Result.isFailure(decoded)).toBe(true);
    expect(Result.isSuccess(decoded)).toBe(false);
    if (Result.isFailure(decoded)) {
      expect((decoded.failure as BoomError).message).toBe("kaboom");
    }
  });

  it("round-trips Result.success via decode → encode", () => {
    const original = Result.succeed(3);
    const wire = Schema.encodeUnknownSync(Codec)(original);
    const decoded = Schema.decodeUnknownSync(Codec)(wire);
    expect(Result.isSuccess(decoded)).toBe(true);
    expect(Result.getOrThrow(decoded)).toBe(3);
  });

  it("round-trips Result.failure via decode → encode", () => {
    const original = Result.fail(new BoomError({ message: "rt" }));
    const wire = Schema.encodeUnknownSync(Codec)(original);
    const decoded = Schema.decodeUnknownSync(Codec)(wire);
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect((decoded.failure as BoomError).message).toBe("rt");
    }
  });

  it("rejects malformed wire payloads", () => {
    expect(() => Schema.decodeUnknownSync(Codec)({ _tag: "Bogus", value: 1 })).toThrow();
  });
});
