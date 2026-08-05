import { click, expect, given, role, scene, text } from "foldkit/scene";
import { describe, test } from "vitest";

import { homeModel } from "./main.fixtures";
import { update, view } from "./main";

describe("home", () => {
  test("renders the loaded user list with detail links", () => {
    scene(
      { update, view },
      given(homeModel),
      expect(role("link", { name: "Alice Anderson" })).toExist(),
      expect(role("button", { name: "Create user" })).toExist(),
    );
  });

  test("empty create form submit is a no-op", () => {
    scene(
      { update, view },
      given(homeModel),
      click(role("button", { name: "Create user" })),
      expect(text("Alice Anderson")).toExist(),
    );
  });
});
