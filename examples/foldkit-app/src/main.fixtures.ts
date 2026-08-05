import type { Model } from "./main";
import { HomeRoute } from "./route";

export const homeModel: Model = {
  route: HomeRoute(),
  users: { _tag: "Success", data: [{ id: "1", fullName: "Alice Anderson" }] },
  user: { _tag: "Idle" },
  firstNameInput: "",
  lastNameInput: "",
};
