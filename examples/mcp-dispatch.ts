// MCP server over a domain: every non-stream operation becomes an MCP tool.
// Nothing here is MCP-specific to the core — the tool list comes from
// `inspect()`, tool input schemas from each operation's args AST, and
// execution from `handleDispatch`, the same wire pipeline the RPC and HTTP
// examples use. Effect ships the MCP protocol itself
// (`effect/unstable/ai/McpServer`), so this file is only the mapping.
//
// Selections ride along as a `select` tool parameter, validated by the
// gateway like any other wire dispatch — agents state their read set per
// call. Object-shaped operations require one (there is no implicit full
// selection); scalar operations take none.
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import type { AnyOperationDef } from "../src/define.ts";
import { type Domain, type DomainInstance, type WireShape } from "../src/index.ts";
import { domain, UserRepoLive } from "./domain.ts";

export const makeDomainMcp = <Ops extends Record<string, AnyOperationDef>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provided sits in an Exclude<>; only `any` unifies every provided domain.
  liveDomain: DomainInstance<Ops, any, never, never> & Domain.RequireErrorSchemas<Ops>,
) => {
  const operations = liveDomain.inspect().operations.filter((op) => !op.stream);

  // Tool schemas are runtime-derived, so hand `Tool.dynamic` raw JSON Schema —
  // the mode it documents for tools discovered at runtime. Validation is not
  // lost: `handleDispatch` decodes args and select through the domain's own
  // schemas on every call.
  const argsJsonSchema = (ast: NonNullable<(typeof operations)[number]["args"]>) => {
    const doc = Schema.toJsonSchemaDocument(Schema.make<Schema.Constraint>(ast));
    return Object.keys(doc.definitions).length === 0
      ? doc.schema
      : { ...doc.schema, $defs: doc.definitions };
  };

  const tools = operations.map((op) =>
    Tool.dynamic(op.name, {
      description: `Execute the ${op.name} domain operation.`,
      parameters: {
        type: "object",
        properties: {
          ...(op.args === null ? {} : { args: argsJsonSchema(op.args) }),
          select: {
            description:
              "Field selection, e.g. { id: true, fullName: true }. Required for object-shaped operations; omit for scalar operations.",
          },
        },
        ...(op.args === null ? {} : { required: ["args"] }),
        additionalProperties: false,
      },
      success: Schema.Unknown,
      failure: Schema.Unknown,
      // Operation errors become MCP `isError` tool results instead of
      // killing the server connection.
      failureMode: "return",
    }),
  );

  const handlers = Object.fromEntries(
    operations.map((op) => [
      op.name,
      (params: { readonly args?: unknown; readonly select?: unknown }) =>
        liveDomain.handleDispatch({ name: op.name, args: params.args, select: params.select }).pipe(
          Effect.flatMap((envelope) => {
            // handleDispatch returns the encoded dispatch-Result envelope;
            // unwrap it so agents see plain results and typed failures.
            const e = envelope as WireShape<unknown, unknown>;
            return e._tag === "Success" ? Effect.succeed(e.success) : Effect.fail(e.failure);
          }),
        ),
    ]),
  );

  const toolkit = Toolkit.make(...tools);
  // Tool names are only known at runtime, so the handler record cannot satisfy
  // `HandlersFrom` per-name. Cast to `never` rather than `any`: `any` makes
  // `toLayer` infer its services parameter as `unknown`, which then poisons
  // every consumer's R channel.
  const handlersLayer = toolkit.toLayer(handlers as never);
  const layer = McpServer.toolkit(toolkit).pipe(Layer.provide(handlersLayer));

  return { toolkit, handlersLayer, layer };
};

export const mcp = makeDomainMcp(domain.provide(UserRepoLive));

// To serve over stdio, provide a transport from your platform package:
//
//   mcp.layer.pipe(
//     Layer.provide(
//       McpServer.layerStdio({
//         name: "effect-domain demo",
//         version: "1.0.0",
//         protocols: [McpProtocol.v2025_06_18],
//       }),
//     ),
//   )
//
// `McpServer.layerHttp` mounts the same server on an HttpRouter instead.
