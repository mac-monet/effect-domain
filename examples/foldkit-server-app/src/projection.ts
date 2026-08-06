// The app's data layer, written once as selections. Each screen states what
// it needs; `domain.responseSchema` turns that same value into the runtime
// Schema the Model is built from. There is no client, no DTOs, no wire —
// the selections feed `domain.execute` directly in the server entry.
import { domain } from "../../domain.ts";

export const summarySelect = { id: true, fullName: true } as const;
export const detailSelect = {
  id: true,
  fullName: true,
  greeting: { args: { salutation: "Hello" } },
  profile: { select: { bio: true, location: true } },
} as const;

export const UserSummary = domain.responseSchema("createUser", summarySelect);
export type UserSummary = typeof UserSummary.Type;

export const UserDetail = domain.responseSchema("getUser", detailSelect);
export type UserDetail = typeof UserDetail.Type;
