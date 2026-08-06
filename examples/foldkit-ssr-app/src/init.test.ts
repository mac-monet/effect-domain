import { Option } from "effect";
import { fromString } from "foldkit/url";
import { describe, expect, it } from "vitest";

import { type Flags, init } from "./main";

const url = (path: string) => Option.getOrThrow(fromString(`http://localhost${path}`));

const empty: Flags = { preloadedUsers: null, preloadedUser: null };
const alice = { id: "1", fullName: "Alice Anderson" };

describe("init with hydration flags", () => {
  it("adopts preloaded users on Home without fetching", () => {
    const [model, commands] = init({ ...empty, preloadedUsers: [alice] }, url("/"));
    expect(model.users._tag).toBe("Success");
    expect(commands).toHaveLength(0);
  });

  it("falls back to loading when nothing is preloaded", () => {
    const [model, commands] = init(empty, url("/"));
    expect(model.users._tag).toBe("Loading");
    expect(commands).toHaveLength(1);
  });

  it("ignores a preloaded user that does not match the route id", () => {
    const detail = {
      id: "2",
      fullName: "Bob Brown",
      greeting: "Hello Bob Brown",
      profile: { bio: "b", location: "l" },
    };
    const [model, commands] = init({ ...empty, preloadedUser: detail }, url("/users/1"));
    expect(model.user._tag).toBe("Loading");
    expect(commands).toHaveLength(1);
  });
});
