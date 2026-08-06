// One repo for the whole process. `UserRepoLive` seeds an in-memory Map per
// layer build, so every render and form POST must run in a single built
// runtime — otherwise a created user would not exist on the next page.
import { ManagedRuntime } from "effect";
import { UserRepoLive } from "../../domain.ts";

export const runtime = ManagedRuntime.make(UserRepoLive);
