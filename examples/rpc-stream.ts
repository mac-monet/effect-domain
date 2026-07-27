import { Layer } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { domain, UserRepoLive } from "./domain.ts";

const userSelect = { id: true, fullName: true } as const;

export const Rpcs = RpcGroup.make(
  Rpc.make("watchUsers", {
    payload: domain.argsSchema("watchUsers"),
    success: domain.responseSchema("watchUsers", userSelect),
    stream: true,
  }),
);

const userStreams = domain.bindSubscriptions({
  watchUsers: { select: userSelect },
});

const Handlers = Rpcs.toLayer({
  watchUsers: userStreams.watchUsers,
});

export const RpcLive = Layer.provide(Handlers, UserRepoLive);
