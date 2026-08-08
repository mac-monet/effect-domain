import type { Model } from "./main";
import { HomeRoute, UserRoute } from "./route";

export const homeModel: Model = {
  route: HomeRoute(),
  users: { _tag: "Success", data: [{ id: "1", fullName: "Alice Anderson" }] },
  user: { _tag: "Idle" },
  detailLevel: "compact",
  firstNameInput: "",
  lastNameInput: "",
};

export const userModel: Model = {
  route: UserRoute({ id: "1" }),
  users: { _tag: "Idle" },
  user: { _tag: "Success", data: { id: "1", fullName: "Alice Anderson" } },
  detailLevel: "compact",
  firstNameInput: "",
  lastNameInput: "",
};
