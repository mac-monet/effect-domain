import { Command, click, expect, given, role, scene, text } from "foldkit/scene";
import { describe, test } from "vitest";

import { homeModel, userModel } from "./main.fixtures";
import { LoadUser, SucceededLoadUser, update, view } from "./main";

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

describe("user detail", () => {
  test("toggling detail asks for the expanded projection", () => {
    scene(
      { update, view },
      given(userModel),
      expect(text("Alice Anderson")).toExist(),
      click(role("button", { name: "Show details" })),
      Command.resolve(
        LoadUser,
        SucceededLoadUser({
          user: {
            id: "1",
            fullName: "Alice Anderson",
            greeting: "Hello Alice Anderson",
            profile: { bio: "Maintains the domain gateway", location: "Taipei" },
          },
        }),
      ),
      expect(role("button", { name: "Hide details" })).toExist(),
      expect(text("Hello Alice Anderson")).toExist(),
    );
  });
});
