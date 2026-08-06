// One repo for the whole process. `UserRepoLive` seeds an in-memory Map per
// layer build, so the SSR renderer and the /rpc gateway must share a single
// built runtime — otherwise a user created over /rpc would not exist in the
// next server render.
import { ManagedRuntime } from "effect";
import { UserRepoLive } from "../../domain.ts";

export const runtime = ManagedRuntime.make(UserRepoLive);
