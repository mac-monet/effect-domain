import { Effect, type Layer, Result, Schema, Stream } from "effect";
import type { AnyOperationDef } from "../define.ts";
import { type DynamicCodec, unsafeCoerceCodec } from "../schema/codec.ts";
import {
  argsSchemaFor,
  type BoundaryDecoded,
  decodeBoundary,
  type DispatchOptions,
  type DispatchRequest,
  GatewayError,
  liftBoundaryStreamToResult,
  liftBoundaryToResult,
  OperationError,
  type WireDispatchOptions,
} from "../gateway.ts";
import type { DomainInstance, RuntimeBindConfig } from "./interface.ts";
import { inspect as inspectOperations } from "../inspect.ts";
import {
  type Invocation,
  type InvocationKeyOptions,
  invocationKey,
  selectionsEqual,
} from "../invocation-key.ts";
import { buildRegistry, type NodeRegistry, reachableFieldErrorSchemas } from "../registry.ts";
import { buildTopology, type DomainTopology } from "./topology.ts";
import { rootToResponseSchema } from "../response/codec.ts";
import { analyzeSelection } from "../selection/analyze.ts";
import type { Selection } from "../selection/syntax.ts";
import { selectionKeys } from "../selection/syntax.ts";
import { rootToSelectionSchema, type RootSelectionCodec } from "../selection/schema.ts";
import {
  makeReadSetCollector,
  type ReadSetCollector,
  walkRoot,
  type WalkContext,
} from "../walk.ts";
import { ResultCodec } from "../schema/result.ts";

class DomainInvariantError extends Error {}

type PublicSchemaCodec = Schema.Codec<unknown, unknown, never, never>;

// Only name→schema lookups are per-graph (operation names are graph-scoped).
// AST-keyed codec/plan caches are module-global WeakMaps in their own modules.
interface DomainCaches {
  readonly args: Map<string, Schema.Decoder<unknown>>;
  readonly selection: Map<string, RootSelectionCodec>;
  readonly topology: { value: DomainTopology | undefined };
}

function makeDomainCaches(): DomainCaches {
  return {
    args: new Map(),
    selection: new Map(),
    topology: { value: undefined },
  };
}

function bindingConfig(
  methodName: string,
  config: RuntimeBindConfig,
): { readonly name: string; readonly select?: Selection } {
  const entry = config[methodName];
  return {
    name: entry?.to ?? methodName,
    ...(entry?.select !== undefined ? { select: entry.select } : {}),
  };
}

function publicSchemaCodec(codec: DynamicCodec): PublicSchemaCodec {
  return codec;
}

// Fallback for dispatchResultSchemaDynamic: decodes any boundary failure.
// Built lazily once — most graphs never take the fallback path.
let gatewayResultCodecMemo: DynamicCodec | undefined;
function gatewayResultCodec(): DynamicCodec {
  gatewayResultCodecMemo ??= ResultCodec(Schema.Unknown, GatewayError) as DynamicCodec;
  return gatewayResultCodecMemo;
}

// AnyOperationDef keeps args contravariant as `never` so concrete operation
// resolvers remain assignable after erasure. Typed execute/bind calls pass the
// statically-checked args slot; dispatch calls pass the boundary-decoded args.
function erasedOperationArgs(args: unknown): never {
  return args as never;
}

function domainFacade<Ops extends Record<string, AnyOperationDef>, Provided, ProvidedE, ProvidedR>(
  facade: Record<string, unknown> & { readonly operations: Ops },
): DomainInstance<Ops, Provided, ProvidedE, ProvidedR> {
  // The runtime facade is implemented with broad string/unknown methods; the
  // exported Domain interface supplies the precise operation-name/result typing.
  return facade as unknown as DomainInstance<Ops, Provided, ProvidedE, ProvidedR>;
}

export function makeDomain<const Ops extends Record<string, AnyOperationDef>>(
  ops: Ops,
): DomainInstance<Ops> {
  return makeDomainWithLayers(ops, [], makeDomainCaches(), buildRegistry(ops));
}

function makeDomainWithLayers<
  const Ops extends Record<string, AnyOperationDef>,
  Provided = never,
  ProvidedE = never,
  ProvidedR = never,
>(
  ops: Ops,
  layers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,
  caches: DomainCaches,
  registry: NodeRegistry,
): DomainInstance<Ops, Provided, ProvidedE, ProvidedR> {
  type InternalResult = unknown;

  function toStream(
    op: AnyOperationDef,
    config: { args?: unknown; select?: Selection; concurrency?: number | "unbounded" },
    reads?: ReadSetCollector,
  ): Stream.Stream<InternalResult, unknown, unknown> {
    const selections = config.select ? selectionKeys(config.select) : new Set<string>();
    const ctx: WalkContext = {
      concurrency: config.concurrency ?? "unbounded",
      registry,
      ...(reads !== undefined ? { reads } : {}),
    };
    const rawStream = op.resolve({ args: erasedOperationArgs(config.args), selections });

    return Stream.mapEffect(rawStream, (value) => walkRoot(value, op.type.ast, config.select, ctx));
  }

  function applyLayers<A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return layers.reduce((acc, layer) => Effect.provide(acc, layer) as Effect.Effect<A, E, R>, eff);
  }

  function applyLayersStream<A, E, R>(s: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> {
    return layers.reduce((acc, layer) => Stream.provide(acc, layer) as Stream.Stream<A, E, R>, s);
  }

  type InternalConfig = {
    args?: unknown;
    select?: Selection;
    concurrency?: number | "unbounded";
    reads?: boolean;
  };

  function internalConfig(config: InternalConfig): InternalConfig {
    return {
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.select !== undefined ? { select: config.select } : {}),
      ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    };
  }

  function selectionSchemaFor(name: string): RootSelectionCodec {
    const cached = caches.selection.get(name);
    if (cached) return cached;
    if (!Object.hasOwn(ops, name)) {
      throw new Error(`Unknown operation: ${name}`);
    }
    const op = ops[name]!;
    const schema = rootToSelectionSchema(registry, op.type.ast);
    caches.selection.set(name, schema);
    return schema;
  }

  function decodeFor(config: DispatchRequest, expectedKind?: "operation" | "subscription") {
    return decodeBoundary(config, ops, selectionSchemaFor, expectedKind);
  }

  // A field's typed failure fails the whole operation, so the wire cause
  // schema is the operation's declared errors plus every reachable field's.
  // Memoized per operation — reachability is selection-independent.
  const causeSchemas = new Map<string, Schema.Top>();
  function operationCauseSchema(
    name: string,
    op: AnyOperationDef,
    operationErrorOverride?: Schema.Top,
  ): Schema.Top {
    const cached = operationErrorOverride === undefined ? causeSchemas.get(name) : undefined;
    if (cached) return cached;
    const fieldErrors = reachableFieldErrorSchemas(registry, op.type.ast);
    const declared = operationErrorOverride ?? op.error ?? Schema.Never;
    const built = fieldErrors.length === 0 ? declared : Schema.Union([declared, ...fieldErrors]);
    if (operationErrorOverride === undefined) causeSchemas.set(name, built);
    return built;
  }

  function executeBoundary(decoded: BoundaryDecoded, options?: DispatchOptions) {
    const config = internalConfig({
      args: decoded.args,
      ...(decoded.select !== undefined ? { select: decoded.select } : {}),
      ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });

    if (options?.reads === true) {
      // Suspend for a fresh collector per execution of the returned Effect.
      return Effect.suspend(() => {
        const reads = makeReadSetCollector();
        const walked = toStream(decoded.op, config, reads);
        return Effect.flatMap(Stream.runHead(walked), (option) => {
          if (option._tag === "None") {
            return Effect.die(new DomainInvariantError("Operation resolver produced empty stream"));
          }
          return Effect.succeed({ result: option.value, reads: reads.entries } as unknown);
        });
      });
    }

    const walked = toStream(decoded.op, config);
    return Effect.flatMap(Stream.runHead(walked), (option) => {
      if (option._tag === "None") {
        return Effect.die(new DomainInvariantError("Operation resolver produced empty stream"));
      }
      return Effect.succeed(option.value as unknown);
    });
  }

  function streamBoundary(decoded: BoundaryDecoded, concurrency?: number | "unbounded") {
    return toStream(
      decoded.op,
      internalConfig({
        args: decoded.args,
        ...(decoded.select !== undefined ? { select: decoded.select } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      }),
    ) as Stream.Stream<unknown, unknown, unknown>;
  }

  // Unknown names and empty single-value streams are graph invariant
  // violations: the typed API makes them unrepresentable, so reaching one at
  // runtime means a bypassed type check or a buggy resolver. Both die.
  function executeOperation(name: string, config: InternalConfig) {
    if (!Object.hasOwn(ops, name)) {
      return Effect.die(new DomainInvariantError(`Unknown operation: ${name}`));
    }
    const op = ops[name]!;

    if (config.reads === true) {
      // Suspend so each execution gets a fresh collector — the returned
      // Effect may be run more than once.
      return applyLayers(
        Effect.suspend(() => {
          const reads = makeReadSetCollector();
          const walked = toStream(op, config, reads);
          return Effect.flatMap(Stream.runHead(walked), (option) => {
            if (option._tag === "None") {
              return Effect.die(
                new DomainInvariantError("Operation resolver produced empty stream"),
              );
            }
            return Effect.succeed({ result: option.value, reads: reads.entries });
          });
        }),
      );
    }

    const walked = toStream(op, config);
    const result = Effect.flatMap(Stream.runHead(walked), (option) => {
      if (option._tag === "None") {
        return Effect.die(new DomainInvariantError("Operation resolver produced empty stream"));
      }
      return Effect.succeed(option.value);
    });
    return applyLayers(result);
  }

  function subscribeOperation(name: string, config: InternalConfig) {
    if (!Object.hasOwn(ops, name)) {
      return Stream.fromEffect(Effect.die(new DomainInvariantError(`Unknown operation: ${name}`)));
    }
    const op = ops[name]!;
    return applyLayersStream(toStream(op, config));
  }

  // The total wire codec behind dispatchResultSchemaDynamic, handleDispatch,
  // and handleSubscription. Unknown names fall back to the gateway codec,
  // which decodes exactly what the server can produce for them (such
  // dispatches fail at the boundary with a GatewayError).
  function dynamicResultCodec(name: string, selection: Selection | undefined): DynamicCodec {
    const op = Object.hasOwn(ops, name) ? ops[name]! : undefined;
    if (op === undefined) return gatewayResultCodec();
    let success: DynamicCodec;
    try {
      success = rootToResponseSchema(registry, op.type.ast, selection);
    } catch {
      // A known operation whose selection can't build a response codec: the
      // failure side must still round-trip (the boundary rejects such
      // selections as GatewayErrors), but a success produced despite it must
      // not silently cross the wire un-encoded — Never dies at encode time.
      success = unsafeCoerceCodec(Schema.Never);
    }
    const failure = Schema.Union([
      GatewayError,
      OperationError.schema(operationCauseSchema(name, op)),
    ]);
    // Success/failure services are unknown at this erased level; the public
    // interface asserts never per the responseSchema convention.
    return ResultCodec(success, failure) as DynamicCodec;
  }

  // Encode a live dispatch Result into the wire envelope. An encode failure
  // means the produced result doesn't match the domain's own codec — a graph
  // invariant violation, so it dies rather than surfacing as a typed error.
  //
  // The wire handlers only call this with boundary-DECODED selections (the
  // codec cache is keyed by selection, so building codecs from raw untrusted
  // input would let arbitrary distinct selections grow it without bound).
  function encodeDispatchResult(name: string, selection: Selection | undefined) {
    const encode = Schema.encodeEffect(dynamicResultCodec(name, selection));
    return (result: unknown) =>
      Effect.orDie(
        encode(result as Parameters<typeof encode>[0]) as Effect.Effect<
          unknown,
          Schema.SchemaError
        >,
      );
  }

  // Boundary failures encode through the memoized gateway codec — never the
  // per-selection codec, which must not be built from unvalidated input.
  function encodeGatewayFailure(gatewayError: unknown) {
    const encode = Schema.encodeEffect(gatewayResultCodec());
    return Effect.orDie(
      encode(Result.fail(gatewayError)) as Effect.Effect<unknown, Schema.SchemaError>,
    );
  }

  function operationNames(streamed: boolean): ReadonlyArray<string> {
    return Object.entries(ops)
      .filter(([, op]) => op._stream === streamed)
      .map(([name]) => name);
  }

  return domainFacade<Ops, Provided, ProvidedE, ProvidedR>({
    operations: ops,
    operationNames() {
      return operationNames(false);
    },
    subscriptionNames() {
      return operationNames(true);
    },
    analyzeSelection(selection: Selection | undefined) {
      return analyzeSelection(selection);
    },
    execute(name: string, config: InternalConfig) {
      return executeOperation(name, config);
    },
    subscribe(name: string, config: InternalConfig) {
      return subscribeOperation(name, config);
    },
    inspect() {
      return inspectOperations(registry);
    },
    topology() {
      caches.topology.value ??= buildTopology(registry);
      return caches.topology.value;
    },
    argsSchema(name: string) {
      const cached = caches.args.get(name);
      if (cached) return cached;
      if (!Object.hasOwn(ops, name)) {
        throw new Error(`Unknown operation: ${name}`);
      }
      const op = ops[name]!;
      const schema = argsSchemaFor(op);
      caches.args.set(name, schema);
      return schema;
    },
    selectionSchema(name: string) {
      return publicSchemaCodec(selectionSchemaFor(name));
    },
    responseSchema(name: string, selection: Selection | undefined) {
      if (!Object.hasOwn(ops, name)) {
        throw new Error(`Unknown operation: ${name}`);
      }
      const op = ops[name]!;
      return publicSchemaCodec(rootToResponseSchema(registry, op.type.ast, selection));
    },
    errorSchema(name: string) {
      if (!Object.hasOwn(ops, name)) {
        throw new Error(`Unknown operation: ${name}`);
      }
      return ops[name]!.error ?? Schema.Never;
    },
    // The trailing optional below is the TS overload-implementation signature
    // absorbing both public arities — both public overloads are optional-free.
    dispatchResultSchema(
      name: string,
      selection: Selection | undefined,
      operationErrorSchema?: Schema.Top,
    ) {
      if (!Object.hasOwn(ops, name)) {
        throw new Error(`Unknown operation: ${name}`);
      }
      const op = ops[name]!;
      if (op._stream) {
        throw new Error(`dispatchResultSchema: expected operation, got subscription: ${name}`);
      }
      const success = rootToResponseSchema(registry, op.type.ast, selection);
      const failure = Schema.Union([
        GatewayError,
        OperationError.schema(operationCauseSchema(name, op, operationErrorSchema)),
      ]);
      return ResultCodec(success, failure);
    },
    dispatchResultSchemaDynamic(name: string, selection: Selection | undefined) {
      return dynamicResultCodec(name, selection);
    },
    bind(config: RuntimeBindConfig) {
      const service: Record<string, (args?: unknown) => Effect.Effect<unknown, unknown, unknown>> =
        {};

      for (const methodName of Object.keys(config)) {
        const operation = bindingConfig(methodName, config);
        service[methodName] = (args?: unknown) =>
          executeOperation(
            operation.name,
            internalConfig({
              ...(args !== undefined ? { args } : {}),
              ...(operation.select !== undefined ? { select: operation.select } : {}),
            }),
          );
      }

      return service;
    },
    bindSubscriptions(config: RuntimeBindConfig) {
      const service: Record<string, (args?: unknown) => Stream.Stream<unknown, unknown, unknown>> =
        {};

      for (const methodName of Object.keys(config)) {
        const operation = bindingConfig(methodName, config);
        service[methodName] = (args?: unknown) =>
          subscribeOperation(
            operation.name,
            internalConfig({
              ...(args !== undefined ? { args } : {}),
              ...(operation.select !== undefined ? { select: operation.select } : {}),
            }),
          );
      }

      return service;
    },
    dispatch(config: DispatchRequest, options?: DispatchOptions) {
      return applyLayers(
        liftBoundaryToResult(
          (decoded) => executeBoundary(decoded, options),
          decodeFor(config, "operation"),
          config.name,
        ),
      );
    },
    prepareDispatch(config: DispatchRequest, keyOptions?: InvocationKeyOptions) {
      return Effect.map(decodeFor(config, "operation"), (decoded) => ({
        name: config.name,
        args: decoded.args,
        ...(decoded.select !== undefined ? { select: decoded.select } : {}),
        invocationKey: invocationKey(
          {
            name: config.name,
            args: decoded.args,
            ...(decoded.select !== undefined ? { select: decoded.select } : {}),
          },
          keyOptions,
        ),
        analysis: analyzeSelection(decoded.select),
        execute: (options?: DispatchOptions) =>
          applyLayers(
            liftBoundaryToResult(
              (prepared) => executeBoundary(prepared, options),
              Effect.succeed(decoded),
              config.name,
            ),
          ),
      }));
    },
    dispatchSubscription(config: DispatchRequest, options?: DispatchOptions) {
      return applyLayersStream(
        liftBoundaryStreamToResult(
          (decoded) => streamBoundary(decoded, options?.concurrency),
          decodeFor(config, "subscription"),
          config.name,
        ),
      );
    },
    handleDispatch(config: DispatchRequest, options?: WireDispatchOptions) {
      // Decode-first: boundary failures encode via the gateway codec without
      // ever touching the per-selection codec cache; only validated
      // selections build (and memoize) success codecs. Operation E is lifted
      // into the Result value by liftBoundaryToResult, so the encoded
      // envelope carries every expected outcome.
      return applyLayers(
        Effect.matchEffect(decodeFor(config, "operation"), {
          onFailure: encodeGatewayFailure,
          onSuccess: (decoded) =>
            liftBoundaryToResult(
              (d) => executeBoundary(d, options),
              Effect.succeed(decoded),
              config.name,
            ).pipe(Effect.flatMap(encodeDispatchResult(config.name, decoded.select))),
        }),
      );
    },
    handleSubscription(config: DispatchRequest, options?: WireDispatchOptions) {
      return applyLayersStream(
        Stream.unwrap(
          Effect.match(decodeFor(config, "subscription"), {
            onFailure: (gatewayError) => Stream.fromEffect(encodeGatewayFailure(gatewayError)),
            onSuccess: (decoded) =>
              liftBoundaryStreamToResult(
                (d) => streamBoundary(d, options?.concurrency),
                Effect.succeed(decoded),
                config.name,
              ).pipe(Stream.mapEffect(encodeDispatchResult(config.name, decoded.select))),
          }),
        ),
      );
    },
    invocationKey(invocation: Invocation, options?: InvocationKeyOptions) {
      return invocationKey(invocation, options);
    },
    selectionsEqual(a: unknown, b: unknown) {
      return selectionsEqual(a, b);
    },
    provide<AL, EL = never, RL = never>(layer: Layer.Layer<AL, EL, RL>) {
      // The registry (and warm caches) ride along: it is built once per
      // Domain.make regardless of how many provide() derivatives exist.
      return makeDomainWithLayers<Ops, Provided | AL, ProvidedE | EL, Exclude<ProvidedR, AL> | RL>(
        ops,
        [...layers, layer as Layer.Layer<unknown, unknown, unknown>],
        caches,
        registry,
      );
    },
  });
}
