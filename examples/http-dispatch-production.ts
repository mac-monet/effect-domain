import { Cache, Context, Effect, Layer, Option, Result } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { domain, UserNotFound, UserRepoLive } from "./domain.ts";
import {
  ArgsParseError,
  Domain,
  type PreparedDispatch,
  SelectionParseError,
  UnknownOperation,
  WrongOperationKind,
} from "../src/index.ts";

interface AuthenticatedUser {
  readonly id: string;
  readonly roles: ReadonlySet<string>;
}

interface GatewayConfigShape {
  readonly maxDepth: number;
  readonly maxFields: number;
  readonly graphConcurrency: number;
  readonly timeout: "2 seconds";
  readonly cacheableOperations: ReadonlySet<string>;
  readonly selectionLimitViolation: (
    prepared: PreparedDispatch<unknown, unknown>,
  ) => string | undefined;
}

const mountedOperations = ["getUser", "listUsers"];
const dispatchPayloadBody = HttpServerRequest.schemaBodyJson(Domain.DispatchPayload);

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayConfigShape>()(
  "GatewayConfig",
) {
  static readonly Live = Layer.succeed(GatewayConfig, {
    maxDepth: 1,
    maxFields: 6,
    graphConcurrency: 8,
    timeout: "2 seconds",
    cacheableOperations: new Set(["getUser", "listUsers"]),
    selectionLimitViolation(prepared) {
      const { depth, fieldCount } = prepared.analysis;
      if (depth > this.maxDepth) {
        return `Selection depth ${depth} exceeds limit ${this.maxDepth}.`;
      }
      if (fieldCount > this.maxFields) {
        return `Selection field count ${fieldCount} exceeds limit ${this.maxFields}.`;
      }
      return undefined;
    },
  } satisfies GatewayConfigShape);
}

export class AuthService extends Context.Service<
  AuthService,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<Option.Option<AuthenticatedUser>>;
  }
>()("AuthService") {
  static readonly Live = Layer.succeed(AuthService, {
    authenticate: (request) =>
      Effect.succeed(
        Option.contains(Headers.get(request.headers, "authorization"), "Bearer reader-token")
          ? Option.some({ id: "reader", roles: new Set(["reader"]) })
          : Option.none(),
      ),
  });
}

export class ResponseCache extends Context.Service<ResponseCache, Cache.Cache<string, unknown>>()(
  "ResponseCache",
) {
  static readonly Live = Layer.effect(
    ResponseCache,
    Cache.make<string, unknown>({
      capacity: 500,
      timeToLive: "30 seconds",
      // This gateway checks with Cache.getOption and writes successful dispatches
      // explicitly. Cache.get would run this lookup on a miss, so keep that path
      // visibly invalid for the example.
      lookup: () => Effect.die("Response cache misses are populated explicitly after dispatch."),
    }),
  );
}

const GatewayServicesLive = Layer.mergeAll(
  GatewayConfig.Live,
  AuthService.Live,
  ResponseCache.Live,
);

function jsonError(status: number, code: string, message: string) {
  return HttpServerResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function boundaryErrorResponse(
  error: UnknownOperation | ArgsParseError | SelectionParseError | WrongOperationKind,
) {
  const status = error instanceof UnknownOperation ? 404 : 400;
  return jsonError(status, error._tag, "The request is not valid for this domain operation.");
}

function operationErrorResponse(error: unknown) {
  if (error instanceof UserNotFound) {
    return jsonError(404, "NotFound", "The requested resource was not found.");
  }
  return jsonError(500, "OperationFailed", "The operation failed.");
}

function successResponse(body: unknown, cacheStatus: "HIT" | "MISS") {
  return HttpServerResponse.json(body, {
    headers: {
      "Cache-Control": "private, max-age=30",
      "X-Domain-Cache": cacheStatus,
    },
  });
}

function invalidPayloadResponse() {
  return jsonError(400, "InvalidPayload", "Request body must be a dispatch payload.");
}

function operationRoute(name: string) {
  return HttpRouter.route(
    "POST",
    `/${name}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* GatewayConfig;
      const auth = yield* AuthService;
      const cache = yield* ResponseCache;
      const user = yield* auth.authenticate(request);
      if (Option.isNone(user) || !user.value.roles.has("reader")) {
        return yield* jsonError(401, "Unauthorized", "Authentication is required.");
      }
      const authenticated = user.value;

      // Boundary auth answers "can this caller use this dynamic gateway?".
      // Resolver-level authorization and tenant scoping should still be
      // modeled as request-scoped Effect services provided to the domain.
      if (
        !Option.exists(Headers.get(request.headers, "content-type"), (value) =>
          value.includes("application/json"),
        )
      ) {
        return yield* jsonError(415, "UnsupportedMediaType", "Expected application/json.");
      }

      // Production servers should enforce body-size and rate limits in HTTP
      // middleware or platform body parsers before this route runs.
      const decodedBody = yield* Effect.result(dispatchPayloadBody);
      if (Result.isFailure(decodedBody)) {
        return yield* invalidPayloadResponse();
      }
      const body = decodedBody.success;

      const preparedResult = yield* Effect.result(
        domain.prepareDispatch({
          name,
          args: body.args,
          select: body.select,
        }),
      );
      if (Result.isFailure(preparedResult)) {
        return yield* boundaryErrorResponse(preparedResult.failure);
      }
      const prepared = preparedResult.success;

      const limitError = config.selectionLimitViolation(prepared);
      if (limitError !== undefined) {
        return yield* jsonError(400, "SelectionLimitExceeded", limitError);
      }

      const cacheKey = config.cacheableOperations.has(name)
        ? Option.some(`${authenticated.id}:${prepared.invocationKey}`)
        : Option.none<string>();
      if (Option.isSome(cacheKey)) {
        const cached = yield* Cache.getOption(cache, cacheKey.value);
        if (Option.isSome(cached)) {
          return yield* successResponse(cached.value, "HIT");
        }
      }

      const handled = prepared
        // This limits domain field execution concurrency for this dispatch,
        // not the number of simultaneous HTTP requests.
        .execute({ concurrency: config.graphConcurrency })
        .pipe(Domain.orFail, Effect.timeout(config.timeout));

      return yield* Effect.matchEffect(handled, {
        onFailure: operationErrorResponse,
        onSuccess: Result.match({
          onFailure: boundaryErrorResponse,
          onSuccess: (value) =>
            Effect.gen(function* () {
              const response = yield* successResponse(value, "MISS");
              if (Option.isSome(cacheKey)) {
                yield* Cache.set(cache, cacheKey.value, value);
              }
              return response;
            }),
        }),
      });
    }),
  );
}

const Routes = HttpRouter.addAll(mountedOperations.map(operationRoute));

export const AppLive = Routes.pipe(
  HttpRouter.provideRequest(Layer.merge(UserRepoLive, GatewayServicesLive)),
);

export const { handler: webHandler, dispose } = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
});
