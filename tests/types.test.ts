import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  field,
  type FieldConfig,
  Domain,
  node,
  operation,
  type OperationDef,
  subscription,
  type SubscriptionDef,
} from "../src/index.ts";

// Soundness contract: the args slot on operation/subscription/field is
// `Schema.Decoder<Args>` (DecodingServices = never), not `Schema.Schema<Args>`
// (DecodingServices = unknown). A decoder that requires services would
// silently lose its R requirement when stored on the op, then fail at runtime
// when the gateway dispatches without provisioning the service.
//
// Compile-time assertions use a positive-truth pattern (no `@ts-expect-error`,
// which would suppress unrelated errors): for each slot we encode "this codec
// must NOT be assignable to the slot type" as a type that resolves to `true`,
// then assign `true` to that type. If the slot widens, the type becomes
// `false`, and `vp check` fails on the assignment.

interface AuthService {
  readonly uid: string;
}

declare const ServiceArgs: Schema.Codec<string, unknown, AuthService, never>;

type Rejects<Codec, Slot> = Codec extends Slot ? false : true;

type _OperationRejectsServiceArgs = Rejects<
  typeof ServiceArgs,
  NonNullable<OperationDef<unknown, string>["args"]>
>;
type _SubscriptionRejectsServiceArgs = Rejects<
  typeof ServiceArgs,
  NonNullable<SubscriptionDef<unknown, string>["args"]>
>;
type _FieldRejectsServiceArgs = Rejects<
  typeof ServiceArgs,
  NonNullable<FieldConfig<string, unknown, never, never, string>["args"]>
>;

const _opCheck: _OperationRejectsServiceArgs = true;
const _subCheck: _SubscriptionRejectsServiceArgs = true;
const _fieldCheck: _FieldRejectsServiceArgs = true;
void _opCheck;
void _subCheck;
void _fieldCheck;

// --- Runtime tests for the positive cases + accessor return type ---

const PlainArgs = Schema.Struct({ id: Schema.String });
const PlainNode = node("Plain", Schema.Struct({ id: Schema.String }), () => ({}));

describe("Type contract: args slot accepts plain Schema args", () => {
  it("operation() accepts plain Schema args", () => {
    const op = operation({
      type: PlainNode,
      args: PlainArgs,
      resolve: ({ args }) => Effect.succeed({ id: args.id }),
    });
    expect(op).toBeDefined();
  });

  it("subscription() accepts plain Schema args", () => {
    const sub = subscription({
      type: PlainNode,
      args: PlainArgs,
      resolve: ({ args }) => Stream.succeed({ id: args.id }),
    });
    expect(sub).toBeDefined();
  });

  it("field() accepts plain Schema args", () => {
    const f = field({
      type: Schema.String,
      args: Schema.Struct({ format: Schema.String }),
      resolve: ({ args }) => Effect.succeed(args.format),
    });
    expect(f).toBeDefined();
  });
});

describe("Type contract: argsSchema accessor returns Schema.Decoder", () => {
  it("decodeUnknownEffect on argsSchema produces R = never", () => {
    const domain = Domain.make({
      ping: operation({
        type: PlainNode,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
      getOne: operation({
        type: PlainNode,
        args: PlainArgs,
        resolve: ({ args }) => Effect.succeed({ id: args.id }),
      }),
    });

    const argsDecoder = domain.argsSchema("getOne");
    const decode = Schema.decodeUnknownEffect(argsDecoder);
    // If `argsSchema` returned Schema.Schema<Args> instead of Schema.Decoder<Args>,
    // this Effect's R would be `unknown` and `Effect.runSync` would reject the
    // call (its `R extends never` constraint).
    const result = Effect.runSync(decode({ id: "x" }));
    expect(result).toEqual({ id: "x" });
  });
});
