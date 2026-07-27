import { Context, Effect, Layer, Schema } from "effect";
import { Domain, node, operation } from "../src/index.ts";

// These interfaces model normalized SQL rows. They are deliberately not the
// API shape: User is assembled from accounts + profiles, while organization is
// reached through memberships.
interface AccountRow {
  readonly id: string;
  readonly email: string;
}

interface ProfileRow {
  readonly accountId: string;
  readonly displayName: string;
}

interface MembershipRow {
  readonly accountId: string;
  readonly organizationId: string;
}

interface OrganizationRow {
  readonly id: string;
  readonly name: string;
}

interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface PersistenceStats {
  profileJoins: number;
  organizationBatchCalls: number;
  lastOrganizationAccountIds: ReadonlyArray<string>;
}

export class UserRepo extends Context.Service<
  UserRepo,
  {
    readonly findById: (id: string) => Effect.Effect<UserRecord, UserNotFound>;
    readonly listAll: Effect.Effect<ReadonlyArray<UserRecord>>;
  }
>()("PersistenceExample/UserRepo") {}

export class OrganizationRepo extends Context.Service<
  OrganizationRepo,
  {
    readonly findPrimaryByAccountIds: (
      accountIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, OrganizationRecord>>;
  }
>()("PersistenceExample/OrganizationRepo") {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()("UserNotFound", {
  id: Schema.String,
}) {}

export const Organization = node(
  "PersistenceExampleOrganization",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
  {},
);

export type OrganizationRecord = Schema.Schema.Type<typeof Organization>;

export const User = node(
  "PersistenceExampleUser",
  Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    displayName: Schema.String,
  }),
  (f) => ({
    organization: f.field({
      type: Organization,
      key: (user: UserRecord) => user.id,
      resolve: (accountIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const repo = yield* OrganizationRepo;
          return yield* repo.findPrimaryByAccountIds(accountIds);
        }),
    }),
  }),
);

export const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.findById(args.id);
      }),
  }),
  listUsers: operation({
    type: Schema.Array(User),
    resolve: () =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.listAll;
      }),
  }),
});

export function makePersistenceLive(stats: PersistenceStats) {
  const accountRows: ReadonlyArray<AccountRow> = [
    { id: "acct_1", email: "ada@example.com" },
    { id: "acct_2", email: "grace@example.com" },
  ];
  const profileRows: ReadonlyArray<ProfileRow> = [
    { accountId: "acct_1", displayName: "Ada Lovelace" },
    { accountId: "acct_2", displayName: "Grace Hopper" },
  ];
  const membershipRows: ReadonlyArray<MembershipRow> = [
    { accountId: "acct_1", organizationId: "org_1" },
    { accountId: "acct_2", organizationId: "org_1" },
  ];
  const organizationRows: ReadonlyArray<OrganizationRow> = [
    { id: "org_1", name: "Analytical Engines" },
  ];

  const selectUsers = Effect.sync(() => {
    stats.profileJoins++;

    // Stand-in for:
    // SELECT a.id, a.email, p.display_name
    // FROM accounts a
    // LEFT JOIN profiles p ON p.account_id = a.id
    return accountRows.map((account) => {
      const profile = profileRows.find((row) => row.accountId === account.id);
      return {
        id: account.id,
        email: account.email,
        displayName: profile?.displayName ?? account.email,
      };
    });
  });

  return Layer.mergeAll(
    Layer.succeed(UserRepo, {
      findById: (id) =>
        Effect.flatMap(selectUsers, (users) => {
          const user = users.find((row) => row.id === id);
          return user ? Effect.succeed(user) : Effect.fail(new UserNotFound({ id }));
        }),
      listAll: selectUsers,
    }),
    Layer.succeed(OrganizationRepo, {
      findPrimaryByAccountIds: (accountIds) =>
        Effect.sync(() => {
          stats.organizationBatchCalls++;
          stats.lastOrganizationAccountIds = [...accountIds];

          // Stand-in for:
          // SELECT m.account_id, o.id, o.name
          // FROM memberships m
          // JOIN organizations o ON o.id = m.organization_id
          // WHERE m.account_id IN (...)
          const byAccount = new Map<string, OrganizationRecord>();
          for (const accountId of accountIds) {
            const membership = membershipRows.find((row) => row.accountId === accountId);
            const organization = organizationRows.find(
              (row) => row.id === membership?.organizationId,
            );
            if (organization) {
              byAccount.set(accountId, organization);
            }
          }
          return byAccount;
        }),
    }),
  );
}
