import { Effect, Layer, Result, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { domain, UserRepoLive } from "./domain.ts";
import { GatewayError, Domain, type RootSelectionFor } from "../src/index.ts";

type OperationName = Extract<keyof typeof domain.operations, string>;
type OperationNamesByStream<Streamed extends boolean> = {
  [K in OperationName]: (typeof domain.operations)[K]["_stream"] extends Streamed ? K : never;
}[OperationName];
type QueryName = OperationNamesByStream<false>;
type ExtractArgs<Op> = Op extends {
  readonly args?: infer ArgsSchema;
}
  ? ArgsSchema extends Schema.Decoder<infer Args>
    ? Args
    : undefined
  : undefined;
type ExtractType<Op> = Op extends { readonly type: Schema.Schema<infer Type> } ? Type : never;
type ArgsPayload<Args> = [Args] extends [undefined]
  ? { readonly args?: Args }
  : { readonly args: Args };
type SelectPayload<Type, Select> = [RootSelectionFor<Type>] extends [never]
  ? { readonly select?: undefined }
  : { readonly select: Select & RootSelectionFor<Type> };

export type DomainRpcClient = {
  readonly [Name in QueryName]: <
    const Select extends RootSelectionFor<ExtractType<(typeof domain.operations)[Name]>>,
  >(
    payload: ArgsPayload<ExtractArgs<(typeof domain.operations)[Name]>> &
      SelectPayload<ExtractType<(typeof domain.operations)[Name]>, Select>,
  ) => Effect.Effect<
    Domain.RootResultOf<ExtractType<(typeof domain.operations)[Name]>, Select>,
    GatewayError
  >;
};

const operationNames = domain.operationNames() as ReadonlyArray<QueryName>;

// Dynamic gateway example: each procedure accepts runtime args/select and
// dispatches through domain.dispatch(...). Fixed RPC procedures should prefer
// domain.bind(...) with native RpcGroup declarations.
const RpcPayload = (_name: OperationName) =>
  Schema.Struct({
    args: Schema.optional(Schema.Unknown),
    select: Schema.optional(Schema.Unknown),
  });

export const Rpcs = RpcGroup.make(
  ...operationNames.map((name) =>
    Rpc.make(name, {
      payload: RpcPayload(name),
      success: Schema.Unknown,
      error: GatewayError,
    }),
  ),
);
type RpcsUnion = typeof Rpcs extends RpcGroup.RpcGroup<infer R> ? R : never;

// Client-side helper for shared-code Effect stacks. The RPC transport remains
// dynamic, but this wrapper captures the `select` literal at the call site so
// TypeScript can infer the selected Result tree.
export function makeDomainRpcClient(client: unknown): DomainRpcClient {
  return client as unknown as DomainRpcClient;
}

const handlers = Object.fromEntries(
  operationNames.map((name) => [
    name,
    (payload: { readonly args?: unknown; readonly select?: unknown }) =>
      Effect.flatMap(
        domain
          .dispatch({ name, args: payload.args, select: payload.select })
          .pipe(Domain.orFail, Effect.orDie),
        (result) =>
          Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success),
      ),
  ]),
) as unknown as RpcGroup.HandlersFrom<RpcsUnion>;

const Handlers = Rpcs.toLayer(Effect.succeed(handlers));

export const RpcLive = Layer.provide(Handlers, UserRepoLive);
