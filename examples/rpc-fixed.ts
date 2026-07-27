import { Layer } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { domain, UserNotFound, UserRepoLive } from "./domain.ts";

const userSelect = { id: true, fullName: true } as const;

export const Rpcs = RpcGroup.make(
  Rpc.make("getUser", {
    payload: domain.argsSchema("getUser"),
    success: domain.responseSchema("getUser", userSelect),
    error: UserNotFound,
  }),
  Rpc.make("createUser", {
    payload: domain.argsSchema("createUser"),
    success: domain.responseSchema("createUser", userSelect),
  }),
);

const users = domain.bind({
  getUser: { select: userSelect },
  createUser: { select: userSelect },
});

const Handlers = Rpcs.toLayer({
  getUser: users.getUser,
  createUser: users.createUser,
});

export const RpcLive = Layer.provide(Handlers, UserRepoLive);
